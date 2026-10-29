import {randomBytes} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

/**
 * Several Claude accounts in priority order. A chat uses the first one that has not hit its limit;
 * when it does, it is marked limited until its reset and the next one takes over.
 *
 * - `key` / `token`: an API key or a subscription (setup-token) token, stored here.
 * - `login`: a Claude Code browser login. Claude Code keeps one login in its config dir, so each login
 *   account has a slot with its login files, swapped into the config dir before Claude Code starts.
 * - `env`: ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN from the environment (not stored, not removable).
 *
 * Everything here is synchronous: it runs right before Claude Code is spawned, while the session lock
 * is held, so no other yena session uses the login files during a swap.
 */

export type AccountKind = 'api-key' | 'oauth';
export type AccountType = 'key' | 'token' | 'login' | 'env';
export type LimitReason = 'usage-limit' | 'billing';

export type Account = {
	readonly name: string;
	readonly type: AccountType;
	readonly kind: AccountKind;
	readonly email?: string;
};

export type AccountView = Account & {limitedUntil?: number; reason?: LimitReason; installed?: boolean};

type Stored = {name: string; type: 'key' | 'token' | 'login'; kind: AccountKind; value?: string; email?: string; uuid?: string; addedAt: string};
type Limit = {until: number; reason: LimitReason};
type AccountsFile = {v: 1; accounts: Stored[]; order: string[]; limits: Record<string, Limit>; installed?: string};

// The parts of a Claude Code login: its credentials file and two fields of .claude.json.
type LoginSlot = {credentials: unknown; oauthAccount?: unknown; primaryApiKey?: string};

export const ENV_KEY = 'env-key';
export const ENV_TOKEN = 'env-token';
const RESERVED = new Set([ENV_KEY, ENV_TOKEN]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const MAX_ACCOUNTS = 50;
const FILE_MAX = 256 * 1024;
export const API_KEY_RE = /^sk-ant-(?!oat)[A-Za-z0-9_-]{20,}$/;
export const OAUTH_TOKEN_RE = /^sk-ant-oat[0-9A-Za-z_-]{20,}$/;
const LOGIN_FIELDS = ['oauthAccount', 'primaryApiKey'] as const;
// Signed per-organisation caches of Claude Code; another account fetches its own.
const ORG_CACHES = /^(policy-limits|remote-settings)\.json/;

export type AccountsCtx = {dataDir: string; configDir: string; env: NodeJS.ProcessEnv; now?: () => number};

export const accountsFile = (dataDir: string): string => path.join(dataDir, 'accounts.json');
export const accountsDir = (dataDir: string): string => path.join(dataDir, 'accounts');
const legacyFile = (dataDir: string) => path.join(dataDir, 'credentials.json');
const slotFile = (dataDir: string, name: string) => path.join(accountsDir(dataDir), name, 'login.json');
const nowSec = (ctx: AccountsCtx) => Math.floor((ctx.now?.() ?? Date.now()) / 1000);

export function checkAccountName(name: string | undefined): string {
	if (name === undefined || !NAME_RE.test(name) || name.includes('..')) {
		throw new Error('An account name is up to 64 letters, digits and . _ @ + - (e.g. work or me@example.com)');
	}
	if (RESERVED.has(name)) throw new Error(`"${name}" is the name of an environment variable account`);
	return name;
}

function writeAtomic(file: string, data: string): void {
	mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, {force: true});
		throw err;
	}
}

// A regular file only (never through a symlink), bounded.
function readJson(file: string): unknown {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > FILE_MAX * 4) return undefined;
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch {
		return undefined;
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseStored(v: unknown): Stored | undefined {
	if (!isRecord(v) || typeof v.name !== 'string' || !NAME_RE.test(v.name) || RESERVED.has(v.name)) return undefined;
	const addedAt = typeof v.addedAt === 'string' ? v.addedAt : '';
	const extra = {
		...(typeof v.email === 'string' && v.email.length <= 320 && {email: v.email}),
		...(typeof v.uuid === 'string' && v.uuid.length <= 64 && {uuid: v.uuid}),
	};
	if (v.type === 'key' && typeof v.value === 'string' && API_KEY_RE.test(v.value)) return {name: v.name, type: 'key', kind: 'api-key', value: v.value, addedAt};
	if (v.type === 'token' && typeof v.value === 'string' && OAUTH_TOKEN_RE.test(v.value)) return {name: v.name, type: 'token', kind: 'oauth', value: v.value, addedAt};
	if (v.type === 'login' && (v.kind === 'api-key' || v.kind === 'oauth')) return {name: v.name, type: 'login', kind: v.kind, addedAt, ...extra};
	return undefined;
}

function readFile(dataDir: string): AccountsFile {
	const raw = readJson(accountsFile(dataDir));
	const out: AccountsFile = {v: 1, accounts: [], order: [], limits: {}};
	if (!isRecord(raw)) return out;
	const seen = new Set<string>();
	for (const a of Array.isArray(raw.accounts) ? raw.accounts.slice(0, MAX_ACCOUNTS) : []) {
		const s = parseStored(a);
		if (s && !seen.has(s.name)) {
			seen.add(s.name);
			out.accounts.push(s);
		}
	}
	if (Array.isArray(raw.order)) out.order = raw.order.filter((n): n is string => typeof n === 'string' && NAME_RE.test(n)).slice(0, MAX_ACCOUNTS + 2);
	if (isRecord(raw.limits)) {
		for (const [name, l] of Object.entries(raw.limits)) {
			if (!NAME_RE.test(name) || !isRecord(l) || typeof l.until !== 'number' || !Number.isFinite(l.until)) continue;
			out.limits[name] = {until: l.until, reason: l.reason === 'billing' ? 'billing' : 'usage-limit'};
		}
	}
	if (typeof raw.installed === 'string' && seen.has(raw.installed)) out.installed = raw.installed;
	return out;
}

const writeFile = (dataDir: string, f: AccountsFile): void => writeAtomic(accountsFile(dataDir), JSON.stringify(f, null, '\t') + '\n');

const nonEmpty = (v: string | undefined): string | undefined => {
	const t = v?.trim();
	return t ? t : undefined;
};

// ---- Claude Code's login files ----

const loginCredentialsFile = (configDir: string) => path.join(configDir, '.credentials.json');
const claudeJsonFile = (configDir: string) => path.join(configDir, '.claude.json');

/** The login now in the config dir, or undefined when there is none. */
function snapshotLogin(configDir: string): LoginSlot | undefined {
	const credentials = readJson(loginCredentialsFile(configDir));
	const claude = readJson(claudeJsonFile(configDir));
	const c = isRecord(claude) ? claude : {};
	const primaryApiKey = typeof c.primaryApiKey === 'string' && c.primaryApiKey !== '' ? c.primaryApiKey : undefined;
	const hasOauth = isRecord(credentials) && isRecord(credentials.claudeAiOauth);
	if (!hasOauth && primaryApiKey === undefined) return undefined;
	return {
		credentials: hasOauth ? credentials : null,
		...(c.oauthAccount !== undefined && {oauthAccount: c.oauthAccount}),
		...(primaryApiKey !== undefined && {primaryApiKey}),
	};
}

const slotKind = (slot: LoginSlot): AccountKind => (slot.credentials ? 'oauth' : 'api-key');
const slotEmail = (slot: LoginSlot): string | undefined => {
	const a = slot.oauthAccount;
	return isRecord(a) && typeof a.emailAddress === 'string' && a.emailAddress.length <= 320 ? a.emailAddress : undefined;
};
const slotUuid = (slot: LoginSlot): string | undefined => {
	const a = slot.oauthAccount;
	return isRecord(a) && typeof a.accountUuid === 'string' && a.accountUuid.length <= 64 ? a.accountUuid : undefined;
};

function readSlot(dataDir: string, name: string): LoginSlot | undefined {
	const raw = readJson(slotFile(dataDir, name));
	if (!isRecord(raw)) return undefined;
	return {
		credentials: isRecord(raw.credentials) ? raw.credentials : null,
		...(raw.oauthAccount !== undefined && {oauthAccount: raw.oauthAccount}),
		...(typeof raw.primaryApiKey === 'string' && {primaryApiKey: raw.primaryApiKey}),
	};
}

const writeSlot = (dataDir: string, name: string, slot: LoginSlot): void => writeAtomic(slotFile(dataDir, name), JSON.stringify(slot) + '\n');

/** Puts a login into the config dir; the rest of .claude.json (settings, MCP servers, projects) stays. */
function installSlot(configDir: string, slot: LoginSlot): void {
	if (slot.credentials) writeAtomic(loginCredentialsFile(configDir), JSON.stringify(slot.credentials, null, 2));
	else rmSync(loginCredentialsFile(configDir), {force: true});
	const claude = readJson(claudeJsonFile(configDir));
	const next: Record<string, unknown> = isRecord(claude) ? {...claude} : {};
	for (const k of LOGIN_FIELDS) delete next[k];
	if (slot.oauthAccount !== undefined) next.oauthAccount = slot.oauthAccount;
	if (slot.primaryApiKey !== undefined) next.primaryApiKey = slot.primaryApiKey;
	writeAtomic(claudeJsonFile(configDir), JSON.stringify(next, null, 2));
	try {
		for (const f of readdirSync(configDir)) if (ORG_CACHES.test(f)) rmSync(path.join(configDir, f), {force: true});
	} catch {
		// no config dir yet
	}
}

/** Takes the login out of the config dir (signs Claude Code out); the rest of .claude.json stays. */
function clearLogin(configDir: string): void {
	rmSync(loginCredentialsFile(configDir), {force: true});
	const claude = readJson(claudeJsonFile(configDir));
	if (!isRecord(claude) || !LOGIN_FIELDS.some(k => k in claude)) return;
	const next = {...claude};
	for (const k of LOGIN_FIELDS) delete next[k];
	writeAtomic(claudeJsonFile(configDir), JSON.stringify(next, null, 2));
}

/**
 * Saves the login in the config dir back into its slot: Claude Code refreshes (and rotates) the tokens.
 * Skipped when the config dir now holds another account (someone logged in there directly).
 */
function saveInstalled(ctx: AccountsCtx, f: AccountsFile): void {
	const name = f.installed;
	if (!name) return;
	const acct = f.accounts.find(a => a.name === name && a.type === 'login');
	const now = snapshotLogin(ctx.configDir);
	if (!acct || !now) return;
	if (acct.uuid !== undefined && slotUuid(now) !== undefined && slotUuid(now) !== acct.uuid) return;
	writeSlot(ctx.dataDir, name, now);
}

// ---- loading, with the old single-credential file and an existing login taken over ----

function load(ctx: AccountsCtx): AccountsFile {
	const f = readFile(ctx.dataDir);
	let changed = false;
	const legacy = readJson(legacyFile(ctx.dataDir));
	if (isRecord(legacy) && typeof legacy.value === 'string') {
		const type = legacy.kind === 'oauth' ? 'token' : 'key';
		const s = parseStored({name: uniqueName(f, 'stored'), type, value: legacy.value, addedAt: typeof legacy.savedAt === 'string' ? legacy.savedAt : ''});
		if (s && !f.accounts.some(a => a.value === s.value)) f.accounts.push(s);
		rmSync(legacyFile(ctx.dataDir), {force: true});
		changed = true;
	}
	// A login made before accounts existed, or directly in Claude Code, becomes an account.
	const current = snapshotLogin(ctx.configDir);
	if (current) {
		const uuid = slotUuid(current);
		const inst = f.accounts.find(a => a.name === f.installed);
		const known = inst !== undefined && (inst.uuid === undefined || uuid === undefined || inst.uuid === uuid);
		if (!known) {
			const same = f.accounts.find(a => a.type === 'login' && uuid !== undefined && a.uuid === uuid);
			const name = same?.name ?? uniqueName(f, slotEmail(current) ?? 'login');
			if (!same) f.accounts.push(loginEntry(name, current));
			writeSlot(ctx.dataDir, name, current);
			f.installed = name;
			changed = true;
		}
	}
	if (changed) writeFile(ctx.dataDir, f);
	return f;
}

function loginEntry(name: string, slot: LoginSlot): Stored {
	const email = slotEmail(slot);
	const uuid = slotUuid(slot);
	return {name, type: 'login', kind: slotKind(slot), addedAt: new Date().toISOString(), ...(email && {email}), ...(uuid && {uuid})};
}

function uniqueName(f: AccountsFile, base: string): string {
	const clean = NAME_RE.test(base) && !base.includes('..') && !RESERVED.has(base) ? base : 'login';
	if (!f.accounts.some(a => a.name === clean)) return clean;
	for (let i = 2; ; i++) if (!f.accounts.some(a => a.name === `${clean}-${i}`)) return `${clean}-${i}`;
}

function envAccounts(env: NodeJS.ProcessEnv): Account[] {
	const out: Account[] = [];
	if (nonEmpty(env.ANTHROPIC_API_KEY)) out.push({name: ENV_KEY, type: 'env', kind: 'api-key'});
	if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)) out.push({name: ENV_TOKEN, type: 'env', kind: 'oauth'});
	return out;
}

const publicOf = (s: Stored): Account => ({name: s.name, type: s.type, kind: s.kind, ...(s.email && {email: s.email})});

// Priority: the saved order first, then the rest as before accounts existed: environment, logins, stored.
function ordered(ctx: AccountsCtx, f: AccountsFile): Account[] {
	const all: Account[] = [
		...envAccounts(ctx.env),
		...f.accounts.filter(a => a.type === 'login').map(publicOf),
		...f.accounts.filter(a => a.type !== 'login').map(publicOf),
	];
	const rank = (a: Account) => {
		const i = f.order.indexOf(a.name);
		return i < 0 ? f.order.length + all.indexOf(a) : i;
	};
	return [...all].sort((a, b) => rank(a) - rank(b));
}

// ---- the public operations ----

/** Every account in priority order, with its limit state. */
export function listAccounts(ctx: AccountsCtx): AccountView[] {
	const f = load(ctx);
	const now = nowSec(ctx);
	return ordered(ctx, f).map(a => {
		const l = f.limits[a.name];
		return {...a, ...(l && l.until > now && {limitedUntil: l.until, reason: l.reason}), ...(f.installed === a.name && {installed: true})};
	});
}

/** The account a new turn uses: the first not limited; when all are, the one that resets first. */
export function chooseAccount(ctx: AccountsCtx): AccountView | undefined {
	const list = listAccounts(ctx);
	return list.find(a => a.limitedUntil === undefined) ?? [...list].sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0))[0];
}

export type Prepared = {account: Account; kind: AccountKind; value: string; login: boolean};

/**
 * Makes an account usable by Claude Code: its secret, or for a login account its files in the config
 * dir (the login there before is saved back into its own slot first).
 */
export function prepareAccount(ctx: AccountsCtx, name: string): Prepared {
	if (name === ENV_KEY || name === ENV_TOKEN) {
		const value = nonEmpty(name === ENV_KEY ? ctx.env.ANTHROPIC_API_KEY : ctx.env.CLAUDE_CODE_OAUTH_TOKEN);
		if (!value) throw new Error(`The environment variable for "${name}" is not set`);
		return {account: {name, type: 'env', kind: name === ENV_KEY ? 'api-key' : 'oauth'}, kind: name === ENV_KEY ? 'api-key' : 'oauth', value, login: false};
	}
	const f = load(ctx);
	const acct = f.accounts.find(a => a.name === name);
	if (!acct) throw new Error(`No account "${name}"; "claude auth status" lists them`);
	if (acct.type !== 'login') return {account: publicOf(acct), kind: acct.kind, value: acct.value!, login: false};
	if (f.installed !== name || !snapshotLogin(ctx.configDir)) {
		const slot = readSlot(ctx.dataDir, name);
		if (!slot) throw new Error(`The login of account "${name}" is missing; sign in again with "claude auth login --name ${name}"`);
		saveInstalled(ctx, f);
		installSlot(ctx.configDir, slot);
		f.installed = name;
		writeFile(ctx.dataDir, f);
	}
	return {account: publicOf(acct), kind: acct.kind, value: '', login: true};
}

/** Marks an account as out of quota until `until` (epoch seconds). */
export function markLimited(ctx: AccountsCtx, name: string, until: number, reason: LimitReason): void {
	const f = load(ctx);
	f.limits[name] = {until: Math.floor(until), reason};
	const now = nowSec(ctx);
	for (const [n, l] of Object.entries(f.limits)) if (l.until <= now) delete f.limits[n];
	writeFile(ctx.dataDir, f);
}

const secretType = (value: string): 'key' | 'token' => {
	const type = OAUTH_TOKEN_RE.test(value) ? 'token' : API_KEY_RE.test(value) ? 'key' : undefined;
	if (!type) throw new Error('That is neither an Anthropic API key (sk-ant-…) nor a subscription token (sk-ant-oat…)');
	return type;
};

/** The default name for a new key or token (`key`/`token`, then `-2`…); throws when the value is not one or is already stored. */
export function suggestSecretName(ctx: AccountsCtx, raw: string): string {
	const value = raw.trim();
	const type = secretType(value);
	const f = load(ctx);
	const dup = f.accounts.find(a => a.value === value);
	if (dup) throw new Error(`That ${type === 'key' ? 'key' : 'token'} is already account "${dup.name}"`);
	return uniqueName(f, type);
}

/** Why a name typed for a new key or token cannot be used, or undefined when it is free and valid. */
export function newAccountNameProblem(ctx: AccountsCtx, name: string): string | undefined {
	try {
		checkAccountName(name);
	} catch (e) {
		return (e as Error).message;
	}
	if (load(ctx).accounts.some(a => a.name === name)) return `"${name}" is already an account; choose another name`;
	return undefined;
}

/** Adds an API key or a subscription token (told apart by its prefix); replaces the secret of an account with that name. */
export function addSecretAccount(ctx: AccountsCtx, rawName: string | undefined, raw: string): Account {
	const value = raw.trim();
	const type = secretType(value);
	if (rawName !== undefined) checkAccountName(rawName);
	const f = load(ctx);
	const dup = f.accounts.find(a => a.value === value);
	if (dup && dup.name !== rawName) throw new Error(`That ${type === 'key' ? 'key' : 'token'} is already account "${dup.name}"`);
	const name = rawName ?? uniqueName(f, type === 'key' ? 'key' : 'token');
	const existing = f.accounts.findIndex(a => a.name === name);
	if (existing >= 0 && f.accounts[existing]!.type === 'login') throw new Error(`"${name}" is a login account; choose another name`);
	if (existing < 0 && f.accounts.length >= MAX_ACCOUNTS) throw new Error(`At most ${MAX_ACCOUNTS} accounts`);
	const entry: Stored = {name, type, kind: type === 'key' ? 'api-key' : 'oauth', value, addedAt: new Date().toISOString()};
	if (existing >= 0) f.accounts[existing] = entry;
	else f.accounts.push(entry);
	delete f.limits[name];
	writeFile(ctx.dataDir, f);
	return publicOf(entry);
}

/** Saves the login in the config dir before a new sign-in replaces it. */
export function stashLogin(ctx: AccountsCtx): void {
	const f = load(ctx);
	saveInstalled(ctx, f);
}

/** Takes the login Claude Code just made in the config dir as an account (the same Claude account updates its entry). */
export function adoptLogin(ctx: AccountsCtx, rawName: string | undefined): Account {
	const slot = snapshotLogin(ctx.configDir);
	if (!slot) throw new Error('Claude Code has no login in its config dir');
	const f = readFile(ctx.dataDir);
	const uuid = slotUuid(slot);
	const same = f.accounts.find(a => a.type === 'login' && uuid !== undefined && a.uuid === uuid);
	let name: string;
	if (rawName !== undefined) {
		name = checkAccountName(rawName);
		const taken = f.accounts.find(a => a.name === name);
		if (taken && taken !== same && taken.type !== 'login') throw new Error(`"${name}" is already a ${taken.type} account`);
	} else name = same?.name ?? uniqueName(f, slotEmail(slot) ?? 'login');
	const entry = loginEntry(name, slot);
	f.accounts = f.accounts.filter(a => a !== same && a.name !== name);
	f.accounts.push(entry);
	if (same && same.name !== name) {
		rmSync(path.join(accountsDir(ctx.dataDir), same.name), {recursive: true, force: true});
		f.order = f.order.map(n => (n === same.name ? name : n));
	}
	writeSlot(ctx.dataDir, name, slot);
	f.installed = name;
	delete f.limits[name];
	writeFile(ctx.dataDir, f);
	return publicOf(entry);
}

/** Puts the named accounts first, in the given order; the others keep theirs after them. */
export function setOrder(ctx: AccountsCtx, names: string[]): AccountView[] {
	const known = listAccounts(ctx).map(a => a.name);
	for (const n of names) if (!known.includes(n)) throw new Error(`No account "${n}"; "claude auth status" lists them`);
	if (new Set(names).size !== names.length) throw new Error('Each account once');
	const f = load(ctx);
	f.order = [...names, ...known.filter(n => !names.includes(n))];
	writeFile(ctx.dataDir, f);
	return listAccounts(ctx);
}

/** Moves an account to the top and forgets its limit. */
export function useAccount(ctx: AccountsCtx, name: string): AccountView[] {
	setOrder(ctx, [name]);
	const f = load(ctx);
	delete f.limits[name];
	writeFile(ctx.dataDir, f);
	return listAccounts(ctx);
}

/** Removes a stored account; a login account's slot goes too (the config dir keeps its login only if it was another). */
export function removeAccount(ctx: AccountsCtx, name: string): {wasInstalled: boolean} {
	if (RESERVED.has(name)) throw new Error(`"${name}" comes from an environment variable; unset the variable instead`);
	const f = load(ctx);
	const acct = f.accounts.find(a => a.name === name);
	if (!acct) throw new Error(`No account "${name}"; "claude auth status" lists them`);
	f.accounts = f.accounts.filter(a => a !== acct);
	f.order = f.order.filter(n => n !== name);
	delete f.limits[name];
	const wasInstalled = f.installed === name;
	if (wasInstalled) {
		delete f.installed;
		clearLogin(ctx.configDir);
	}
	rmSync(path.join(accountsDir(ctx.dataDir), name), {recursive: true, force: true});
	writeFile(ctx.dataDir, f);
	return {wasInstalled};
}

/** Every stored secret, for redaction. */
export function accountSecrets(ctx: AccountsCtx): string[] {
	return readFile(ctx.dataDir).accounts.flatMap(a => (a.value ? [a.value] : []));
}

/** Forgets every stored account and slot and signs Claude Code out (the environment variables stay). */
export function removeAllAccounts(ctx: AccountsCtx): number {
	const f = readFile(ctx.dataDir);
	clearLogin(ctx.configDir);
	rmSync(accountsDir(ctx.dataDir), {recursive: true, force: true});
	rmSync(accountsFile(ctx.dataDir), {force: true});
	rmSync(legacyFile(ctx.dataDir), {force: true});
	return f.accounts.length;
}
