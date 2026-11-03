import path from 'node:path';
import {isRecord, readJson, writeAtomic} from './login-slot.js';
import type {ClaudeVault, CredentialBundle, VaultEntry} from './vault.js';

export type AccountKind = 'api-key' | 'oauth';
export type AccountType = 'key' | 'login' | 'env';

export type Account = {
	readonly name: string;
	readonly type: AccountType;
	readonly kind: AccountKind;
	readonly email?: string;
};

export type Unusable = 'disabled' | 'reserved' | 'missing';

export type AccountView = Account & {unusable?: Unusable};

export type Pin = {name: string};
export type AuthState = {v: 1; order: string[]; pin?: Pin; migrated?: {at: string; accounts: number}};

export const ENV_KEY = 'env-key';
export const ENV_TOKEN = 'env-token';
export const LOGIN = 'login';
export const RESERVED = new Set([ENV_KEY, ENV_TOKEN, LOGIN]);
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_NAMES = 64;
export const API_KEY_RE = /^sk-ant-(?!oat)[A-Za-z0-9_-]{20,}$/;
export const OAUTH_TOKEN_RE = /^sk-ant-oat[0-9A-Za-z_-]{20,}$/;

export type LoginInfo = {present: boolean; kind: AccountKind; email?: string};

export type AccountsCtx = {dataDir: string; configDir: string; env: NodeJS.ProcessEnv; bundle: CredentialBundle; login?: LoginInfo};

export const authFile = (dataDir: string): string => path.join(dataDir, 'auth.json');

export function checkAccountName(name: string | undefined): string {
	if (name === undefined || !ACCOUNT_NAME_RE.test(name)) {
		throw new Error('An account name is up to 32 lowercase letters, digits, _ and -, starting with a letter or digit (e.g. work)');
	}
	if (name === LOGIN) throw new Error('"login" is the name of the Claude Code login account');
	if (RESERVED.has(name)) throw new Error(`"${name}" is the name of an environment variable account`);
	return name;
}

export function toAccountName(raw: string, fallback: string): string {
	const base = raw
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^[^a-z0-9]+/, '')
		.slice(0, 32)
		.replace(/[-_]+$/, '');
	const name = base === '' ? fallback : base;
	return RESERVED.has(name) ? `${name}-1` : name;
}

export function freeNames(base: string, taken: ReadonlySet<string>, count: number): string[] {
	const out: string[] = [];
	for (let i = 1; out.length < count && i < 1000; i++) {
		const suffix = i === 1 ? '' : `-${i}`;
		const name = `${base.slice(0, 32 - suffix.length)}${suffix}`;
		if (!taken.has(name) && !RESERVED.has(name)) out.push(name);
	}
	return out;
}

export function readAuth(dataDir: string): AuthState {
	const raw = readJson(authFile(dataDir));
	const out: AuthState = {v: 1, order: []};
	if (!isRecord(raw)) return out;
	if (Array.isArray(raw.order)) out.order = [...new Set(raw.order.filter((n): n is string => typeof n === 'string' && ACCOUNT_NAME_RE.test(n)))].slice(0, MAX_NAMES);
	const p = raw.pin;
	if (isRecord(p) && typeof p.name === 'string' && ACCOUNT_NAME_RE.test(p.name)) out.pin = {name: p.name};
	const m = raw.migrated;
	if (isRecord(m) && typeof m.at === 'string' && typeof m.accounts === 'number') out.migrated = {at: m.at.slice(0, 40), accounts: m.accounts};
	return out;
}

export const writeAuth = (dataDir: string, f: AuthState): void => writeAtomic(authFile(dataDir), JSON.stringify(f, null, '\t') + '\n');

export const storedEntries = (bundle: CredentialBundle): readonly VaultEntry[] => (bundle.status === 'ok' ? bundle.entries : []);

const unusableOf = (e: VaultEntry): Unusable | undefined => (e.reserved ? 'reserved' : e.disabled ? 'disabled' : e.value === undefined ? 'missing' : undefined);

function saveAuth(ctx: AccountsCtx, f: AuthState): void {
	if (ctx.bundle.status === 'ok') {
		const known = new Set([ENV_KEY, ENV_TOKEN, LOGIN, ...ctx.bundle.entries.map(e => e.name)]);
		f.order = f.order.filter(n => known.has(n));
		const pin = f.pin;
		if (pin) {
			const entry = ctx.bundle.entries.find(e => e.name === pin.name);
			if (!known.has(pin.name) || (entry && unusableOf(entry) !== undefined)) delete f.pin;
		}
	}
	writeAuth(ctx.dataDir, f);
}

const nonEmpty = (v: string | undefined): string | undefined => {
	const t = v?.trim();
	return t ? t : undefined;
};

function envAccounts(env: NodeJS.ProcessEnv): Account[] {
	const out: Account[] = [];
	if (nonEmpty(env.ANTHROPIC_API_KEY)) out.push({name: ENV_KEY, type: 'env', kind: 'api-key'});
	if (nonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)) out.push({name: ENV_TOKEN, type: 'env', kind: 'oauth'});
	return out;
}

const publicOf = (e: VaultEntry): Account => ({name: e.name, type: e.type, kind: e.kind, ...(e.email && {email: e.email})});

const loginAccount = (ctx: AccountsCtx): Account[] =>
	ctx.login?.present ? [{name: LOGIN, type: 'login', kind: ctx.login.kind, ...(ctx.login.email && {email: ctx.login.email})}] : [];

function ordered(ctx: AccountsCtx, f: AuthState): Array<Account & {unusable?: Unusable}> {
	const withMark = (e: VaultEntry) => {
		const u = unusableOf(e);
		return {...publicOf(e), ...(u && {unusable: u})};
	};
	const all = [...envAccounts(ctx.env), ...loginAccount(ctx), ...storedEntries(ctx.bundle).map(withMark)];
	const rank = (a: Account) => {
		const i = f.order.indexOf(a.name);
		return i < 0 ? f.order.length + all.indexOf(a) : i;
	};
	return [...all].sort((a, b) => rank(a) - rank(b));
}

export function listAccounts(ctx: AccountsCtx): AccountView[] {
	return ordered(ctx, readAuth(ctx.dataDir));
}

export function pinnedAccount(ctx: AccountsCtx): Pin | undefined {
	const pin = readAuth(ctx.dataDir).pin;
	if (!pin) return undefined;
	return listAccounts(ctx).some(a => a.name === pin.name && a.unusable === undefined) ? pin : undefined;
}

export type ChooseOpts = {apiKeyOnly?: boolean};

export function chooseAccount(ctx: AccountsCtx, opts: ChooseOpts = {}): AccountView | undefined {
	const pin = pinnedAccount(ctx);
	const list = listAccounts(ctx).filter(a => a.unusable === undefined && (!opts.apiKeyOnly || a.kind === 'api-key'));
	return (pin && list.find(a => a.name === pin.name)) ?? list[0];
}

export type Prepared = {account: Account; kind: AccountKind; value: string; login: boolean; passthrough?: true};

export function prepareAccount(ctx: AccountsCtx, name: string): Prepared {
	if (name === ENV_KEY) {
		const value = nonEmpty(ctx.env.ANTHROPIC_API_KEY);
		if (!value) throw new Error(`The environment variable for "${name}" is not set`);
		return {account: {name, type: 'env', kind: 'api-key'}, kind: 'api-key', value, login: false};
	}
	if (name === ENV_TOKEN) {
		if (!nonEmpty(ctx.env.CLAUDE_CODE_OAUTH_TOKEN)) throw new Error(`The environment variable for "${name}" is not set`);
		return {account: {name, type: 'env', kind: 'oauth'}, kind: 'oauth', value: '', login: false, passthrough: true};
	}
	if (name === LOGIN) {
		const a = loginAccount(ctx)[0];
		if (!a) throw new Error('Claude Code is not signed in; run "claude auth login"');
		return {account: a, kind: a.kind, value: '', login: true};
	}
	const entry = storedEntries(ctx.bundle).find(e => e.name === name);
	if (!entry || entry.reserved) throw new Error(`No account "${name}"; "claude auth status" lists them`);
	if (entry.disabled) throw new Error(`Account "${name}" is disabled in the account module`);
	if (entry.value === undefined) throw new Error(`Account "${name}" has no secret set in the account module`);
	return {account: publicOf(entry), kind: entry.kind, value: entry.value, login: false};
}

export const TOKEN_REFUSED = 'Subscription tokens are no longer stored; sign in with "claude auth login", or set CLAUDE_CODE_OAUTH_TOKEN in your environment.';

export const secretType = (value: string): 'key' => {
	if (OAUTH_TOKEN_RE.test(value)) throw new Error(TOKEN_REFUSED);
	if (!API_KEY_RE.test(value)) throw new Error('That is not an Anthropic API key (sk-ant-…)');
	return 'key';
};

export function suggestSecretName(ctx: AccountsCtx, raw: string): string {
	const value = raw.trim();
	const type = secretType(value);
	const stored = storedEntries(ctx.bundle);
	const dup = stored.find(e => e.value === value);
	if (dup) throw new Error(`That key is already account "${dup.name}"`);
	return freeNames(type, new Set(stored.map(e => e.name)), 1)[0]!;
}

export function newAccountNameProblem(ctx: AccountsCtx, name: string): string | undefined {
	try {
		checkAccountName(name);
	} catch (e) {
		return (e as Error).message;
	}
	if (storedEntries(ctx.bundle).some(e => e.name === name)) return `"${name}" is already an account; choose another name`;
	return undefined;
}

export function setOrder(ctx: AccountsCtx, names: string[]): AccountView[] {
	const known = listAccounts(ctx).map(a => a.name);
	for (const n of names) if (!known.includes(n)) throw new Error(`No account "${n}"; "claude auth status" lists them`);
	if (new Set(names).size !== names.length) throw new Error('Each account once');
	const f = readAuth(ctx.dataDir);
	f.order = [...names, ...known.filter(n => !names.includes(n))];
	saveAuth(ctx, f);
	return listAccounts(ctx);
}

export function useAccount(ctx: AccountsCtx, name: string): AccountView[] {
	const a = listAccounts(ctx).find(x => x.name === name);
	if (!a) throw new Error(`No account "${name}"; "claude auth status" lists them`);
	if (a.unusable) throw new Error(`Account "${name}" cannot be used right now (${a.unusable})`);
	const f = readAuth(ctx.dataDir);
	f.pin = {name};
	saveAuth(ctx, f);
	return listAccounts(ctx);
}

export function clearPin(ctx: AccountsCtx): boolean {
	const f = readAuth(ctx.dataDir);
	if (!f.pin) return false;
	delete f.pin;
	saveAuth(ctx, f);
	return true;
}

const withBundle = (ctx: AccountsCtx, vault: ClaudeVault): AccountsCtx => ({...ctx, bundle: vault.current()});

export async function addSecretAccount(ctx: AccountsCtx, vault: ClaudeVault, rawName: string | undefined, raw: string): Promise<Account> {
	const account = await vault.addSecret(rawName, raw);
	saveAuth(withBundle(ctx, vault), readAuth(ctx.dataDir));
	return account;
}

export async function removeAccount(ctx: AccountsCtx, vault: ClaudeVault, name: string): Promise<void> {
	if (name === LOGIN) throw new Error('The Claude Code login is removed with "claude auth logout"');
	if (RESERVED.has(name)) throw new Error(`"${name}" comes from an environment variable; unset the variable instead`);
	await vault.remove(name);
	const f = readAuth(ctx.dataDir);
	f.order = f.order.filter(n => n !== name);
	if (f.pin?.name === name) delete f.pin;
	saveAuth(withBundle(ctx, vault), f);
}
