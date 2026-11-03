import {createHash} from 'node:crypto';
import {existsSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../src/api.js';
import {ACCOUNT_NAME_RE, API_KEY_RE, authFile, ENV_KEY, ENV_TOKEN, LOGIN, type AuthState, freeNames, readAuth, toAccountName, writeAuth} from './accounts.js';
import {errClass, noopLog} from './log.js';
import {isRecord, readJson} from './login-slot.js';
import {createCredential, type ClaudeVault, FIELD_OF} from './vault.js';

export const accountsFile = (dataDir: string): string => path.join(dataDir, 'accounts.json');
export const accountsDir = (dataDir: string): string => path.join(dataDir, 'accounts');
export const legacyFile = (dataDir: string): string => path.join(dataDir, 'credentials.json');
const lockFile = (dataDir: string) => path.join(dataDir, 'migrate.lock');

const OLD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const MAX_OLD = 50;
const LOCK_STALE_MS = 2 * 60_000;

type Old = {name: string; value: string};
type Legacy = {accounts: Old[]; skipped: number; dropped: number; order: string[]; installed?: string};

export type MigrateResult = {moved: number; skipped: number; dropped: number} | 'none' | 'deferred' | 'failed';

export const legacyPresent = (dataDir: string): boolean =>
	[accountsFile(dataDir), accountsDir(dataDir), legacyFile(dataDir)].some(p => existsSync(p));

function readLegacy(dataDir: string): Legacy {
	const raw = readJson(accountsFile(dataDir));
	const out: Legacy = {accounts: [], skipped: 0, dropped: 0, order: []};
	const f = isRecord(raw) ? raw : {};
	const seen = new Set<string>();
	for (const a of Array.isArray(f.accounts) ? f.accounts.slice(0, MAX_OLD) : []) {
		if (!isRecord(a) || typeof a.name !== 'string' || !OLD_NAME_RE.test(a.name) || a.name.includes('..') || seen.has(a.name)) {
			out.skipped++;
			continue;
		}
		seen.add(a.name);
		if (a.type === 'key' && typeof a.value === 'string' && API_KEY_RE.test(a.value)) out.accounts.push({name: a.name, value: a.value});
		else if (a.type === 'token' || a.type === 'login') out.dropped++;
		else out.skipped++;
	}
	if (Array.isArray(f.order)) out.order = f.order.filter((n): n is string => typeof n === 'string').slice(0, MAX_OLD + 2);
	if (typeof f.installed === 'string' && seen.has(f.installed)) out.installed = f.installed;
	const single = readJson(legacyFile(dataDir));
	if (isRecord(single) && typeof single.value === 'string') {
		if (single.kind === 'oauth') out.dropped++;
		else {
			const value = single.value.trim();
			if (!API_KEY_RE.test(value)) out.skipped++;
			else if (!out.accounts.some(a => a.value === value)) out.accounts.push({name: 'stored', value});
		}
	} else if (existsSync(legacyFile(dataDir))) out.skipped++;
	return out;
}

export function legacyCount(dataDir: string): number {
	if (!legacyPresent(dataDir)) return 0;
	return readLegacy(dataDir).accounts.length;
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

export async function migrateLegacy(o: {dataDir: string; vault: ClaudeVault; log?: Logger}): Promise<MigrateResult> {
	const log = o.log ?? noopLog;
	if (!legacyPresent(o.dataDir)) return 'none';
	const creds = o.vault.channel;
	if (!creds || (await o.vault.load()).status !== 'ok') return 'deferred';
	if (!takeLock(o.dataDir)) return 'deferred';
	let step = 'read';
	try {
		const old = readLegacy(o.dataDir);
		step = 'write';
		const existing = o.vault.current().entries;
		const used = new Set(existing.map(e => e.name));
		const names = new Map<string, string>();
		const expected: Array<{name: string; old: Old}> = [];
		for (const a of old.accounts) {
			const reuse = existing.find(e => e.value === a.value);
			let name: string;
			if (reuse) name = reuse.name;
			else {
				const base = freeNames(toAccountName(a.name, 'key'), used, 1)[0] ?? toAccountName(a.name, 'key');
				name = await createCredential(creds, {base, explicit: false, taken: used, type: 'key', value: a.value});
			}
			used.add(name);
			names.set(a.name, name);
			expected.push({name, old: a});
		}
		step = 'verify';
		for (const {name, old: a} of expected) {
			const back = await creds.read(name, FIELD_OF.key);
			const ok = back !== undefined && digest(back.trim()) === digest(a.value);
			if (!ok) throw new Error('A migrated account reads back different');
		}
		step = 'state';
		const map = (n: string): string | undefined => (n === ENV_KEY || n === ENV_TOKEN ? n : n === old.installed ? LOGIN : names.get(n));
		const prev = readAuth(o.dataDir);
		const f: AuthState = {v: 1, order: [...new Set(old.order.map(map).filter((n): n is string => n !== undefined && ACCOUNT_NAME_RE.test(n)))]};
		if (prev.pin) f.pin = prev.pin;
		f.migrated = {at: new Date().toISOString(), accounts: expected.length};
		writeAuth(o.dataDir, f);
		step = 'cleanup';
		rmSync(accountsFile(o.dataDir), {force: true});
		rmSync(accountsDir(o.dataDir), {recursive: true, force: true});
		rmSync(legacyFile(o.dataDir), {force: true});
		log.info('credentials migrated', {moved: expected.length, skipped: old.skipped, dropped: old.dropped});
		await o.vault.load();
		return {moved: expected.length, skipped: old.skipped, dropped: old.dropped};
	} catch (err) {
		log.warn('credential migration failed', {errClass: errClass(err), step});
		return 'failed';
	} finally {
		rmSync(lockFile(o.dataDir), {force: true});
	}
}

export function migrateAuthState(dataDir: string, log: Logger = noopLog): boolean {
	const raw = readJson(authFile(dataDir));
	if (!isRecord(raw)) return false;
	const pinOnly = isRecord(raw.pin) && 'only' in raw.pin;
	if (!('installed' in raw) && !('limits' in raw) && !pinOnly) return false;
	const f = readAuth(dataDir);
	const installed = typeof raw.installed === 'string' && ACCOUNT_NAME_RE.test(raw.installed) ? raw.installed : undefined;
	if (installed !== undefined) {
		f.order = [...new Set(f.order.map(n => (n === installed ? LOGIN : n)))];
		if (f.pin?.name === installed) f.pin = {name: LOGIN};
	}
	writeAuth(dataDir, f);
	log.info('auth state migrated', {});
	return true;
}
