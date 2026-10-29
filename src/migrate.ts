import {createHash} from 'node:crypto';
import {existsSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import {ACCOUNT_NAME_RE, API_KEY_RE, ENV_KEY, ENV_TOKEN, OAUTH_TOKEN_RE, type AuthState, freeNames, readAuth, toAccountName, writeAuth} from './accounts.js';
import {errClass, noopLog} from './log.js';
import {expiresAt, isRecord, type LoginSlot, parseSlot, readJson, readWorkingCopy, sameClaudeAccount, slotDigest} from './login-slot.js';
import {createCredential, type ClaudeVault, type EntryType, FIELD_OF, type VaultEntry} from './vault.js';

export const accountsFile = (dataDir: string): string => path.join(dataDir, 'accounts.json');
export const accountsDir = (dataDir: string): string => path.join(dataDir, 'accounts');
export const legacyFile = (dataDir: string): string => path.join(dataDir, 'credentials.json');
const slotFile = (dataDir: string, name: string) => path.join(accountsDir(dataDir), name, 'login.json');
const lockFile = (dataDir: string) => path.join(dataDir, 'migrate.lock');

const OLD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const MAX_OLD = 50;
const LOCK_STALE_MS = 2 * 60_000;

type Old = {name: string; type: EntryType; value?: string; slot?: LoginSlot};
type Legacy = {accounts: Old[]; skipped: number; order: string[]; limits: AuthState['limits']; installed?: string};

export type MigrateResult = {moved: number; skipped: number} | 'none' | 'deferred' | 'failed';

export const legacyPresent = (dataDir: string): boolean =>
	[accountsFile(dataDir), accountsDir(dataDir), legacyFile(dataDir)].some(p => existsSync(p));

function readLegacy(dataDir: string, configDir: string): Legacy {
	const raw = readJson(accountsFile(dataDir));
	const out: Legacy = {accounts: [], skipped: 0, order: [], limits: {}};
	const f = isRecord(raw) ? raw : {};
	const seen = new Set<string>();
	for (const a of Array.isArray(f.accounts) ? f.accounts.slice(0, MAX_OLD) : []) {
		if (!isRecord(a) || typeof a.name !== 'string' || !OLD_NAME_RE.test(a.name) || a.name.includes('..') || seen.has(a.name)) {
			out.skipped++;
			continue;
		}
		seen.add(a.name);
		if (a.type === 'key' && typeof a.value === 'string' && API_KEY_RE.test(a.value)) out.accounts.push({name: a.name, type: 'key', value: a.value});
		else if (a.type === 'token' && typeof a.value === 'string' && OAUTH_TOKEN_RE.test(a.value)) out.accounts.push({name: a.name, type: 'token', value: a.value});
		else if (a.type === 'login') {
			const slot = parseSlot(readJson(slotFile(dataDir, a.name)));
			if (slot) out.accounts.push({name: a.name, type: 'login', slot});
			else out.skipped++;
		} else out.skipped++;
	}
	if (Array.isArray(f.order)) out.order = f.order.filter((n): n is string => typeof n === 'string').slice(0, MAX_OLD + 2);
	if (isRecord(f.limits)) {
		for (const [n, l] of Object.entries(f.limits)) {
			if (isRecord(l) && typeof l.until === 'number' && Number.isFinite(l.until)) out.limits[n] = {until: l.until, reason: l.reason === 'billing' ? 'billing' : 'usage-limit'};
		}
	}
	if (typeof f.installed === 'string' && seen.has(f.installed)) out.installed = f.installed;
	const inst = out.accounts.find(a => a.name === out.installed && a.type === 'login');
	const wc = readWorkingCopy(configDir);
	if (inst?.slot && wc.state === 'ok' && sameClaudeAccount(wc.slot, inst.slot) && (expiresAt(wc.slot) ?? 0) >= (expiresAt(inst.slot) ?? 0)) inst.slot = wc.slot;
	const single = readJson(legacyFile(dataDir));
	if (isRecord(single) && typeof single.value === 'string') {
		const type: EntryType = single.kind === 'oauth' ? 'token' : 'key';
		const value = single.value.trim();
		const ok = type === 'key' ? API_KEY_RE.test(value) : OAUTH_TOKEN_RE.test(value);
		if (!ok) out.skipped++;
		else if (!out.accounts.some(a => a.value === value)) out.accounts.push({name: 'stored', type, value});
	} else if (existsSync(legacyFile(dataDir))) out.skipped++;
	return out;
}

export function legacyCount(dataDir: string, configDir: string): number {
	if (!legacyPresent(dataDir)) return 0;
	return readLegacy(dataDir, configDir).accounts.length;
}

function takeLock(dataDir: string): boolean {
	const file = lockFile(dataDir);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, JSON.stringify({pid: process.pid, at: Date.now()}), {flag: 'wx', mode: 0o600});
			return true;
		} catch {
			try {
				if (Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS) return false;
				rmSync(file, {force: true});
			} catch {
				return false;
			}
		}
	}
	return false;
}

const digest = (s: string): string => createHash('sha256').update(s).digest('hex');
const valueOf = (o: Old): string => (o.type === 'login' ? JSON.stringify(o.slot) : o.value!);

const sameEntry = (o: Old, e: VaultEntry): boolean =>
	e.type === o.type && (o.type === 'login' ? e.slot !== undefined && sameClaudeAccount(o.slot!, e.slot) : e.value === o.value);

export async function migrateLegacy(o: {dataDir: string; configDir: string; vault: ClaudeVault; log?: Logger}): Promise<MigrateResult> {
	const log = o.log ?? noopLog;
	if (!legacyPresent(o.dataDir)) return 'none';
	const creds = o.vault.channel;
	if (!creds || (await o.vault.load()).status !== 'ok') return 'deferred';
	if (!takeLock(o.dataDir)) return 'deferred';
	let step = 'read';
	try {
		const old = readLegacy(o.dataDir, o.configDir);
		step = 'write';
		const existing = o.vault.current().entries;
		const used = new Set(existing.map(e => e.name));
		const names = new Map<string, string>();
		const expected: Array<{name: string; old: Old}> = [];
		for (const a of old.accounts) {
			const reuse = existing.find(e => sameEntry(a, e));
			let name: string;
			if (reuse) {
				name = reuse.name;
				if (a.type === 'login' && reuse.slot && slotDigest(reuse.slot) !== slotDigest(a.slot!) && (expiresAt(a.slot!) ?? 0) >= (expiresAt(reuse.slot) ?? 0)) {
					await creds.write(name, FIELD_OF.login, valueOf(a));
				} else if (a.type === 'login' && reuse.slot) a.slot = reuse.slot;
			} else {
				const base = freeNames(toAccountName(a.name, a.type), used, 1)[0] ?? toAccountName(a.name, a.type);
				name = await createCredential(creds, {base, explicit: false, taken: used, type: a.type, value: valueOf(a)});
			}
			used.add(name);
			names.set(a.name, name);
			expected.push({name, old: a});
		}
		step = 'verify';
		for (const {name, old: a} of expected) {
			const back = await creds.read(name, FIELD_OF[a.type]);
			const ok =
				back !== undefined &&
				(a.type === 'login' ? (() => {
					const s = parseSlot(back);
					return s !== undefined && slotDigest(s) === slotDigest(a.slot!);
				})() : digest(back.trim()) === digest(a.value!));
			if (!ok) throw new Error('A migrated account reads back different');
		}
		step = 'state';
		const map = (n: string): string | undefined => (n === ENV_KEY || n === ENV_TOKEN ? n : names.get(n));
		const prev = readAuth(o.dataDir);
		const f: AuthState = {v: 1, order: [...new Set(old.order.map(map).filter((n): n is string => n !== undefined && ACCOUNT_NAME_RE.test(n)))], limits: {}};
		for (const [n, l] of Object.entries(old.limits)) {
			const m = map(n);
			if (m) f.limits[m] = l;
		}
		const inst = old.installed !== undefined ? names.get(old.installed) : prev.installed;
		if (inst) f.installed = inst;
		f.migrated = {at: new Date().toISOString(), accounts: expected.length};
		writeAuth(o.dataDir, f);
		step = 'cleanup';
		rmSync(accountsFile(o.dataDir), {force: true});
		rmSync(accountsDir(o.dataDir), {recursive: true, force: true});
		rmSync(legacyFile(o.dataDir), {force: true});
		log.info('credentials migrated', {moved: expected.length, skipped: old.skipped});
		await o.vault.load();
		return {moved: expected.length, skipped: old.skipped};
	} catch (err) {
		log.warn('credential migration failed', {errClass: errClass(err), step});
		return 'failed';
	} finally {
		rmSync(lockFile(o.dataDir), {force: true});
	}
}
