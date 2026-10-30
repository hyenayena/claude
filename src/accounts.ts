import path from 'node:path';
import {clearLogin, expiresAt, installSlot, isRecord, readJson, readWorkingCopy, sameClaudeAccount, slotDigest, type LoginSlot, writeAtomic} from './login-slot.js';
import type {ClaudeVault, CredentialBundle, VaultEntry} from './vault.js';

export type AccountKind = 'api-key' | 'oauth';
export type AccountType = 'key' | 'token' | 'login' | 'env';
export type LimitReason = 'usage-limit' | 'billing';

export type Account = {
	readonly name: string;
	readonly type: AccountType;
	readonly kind: AccountKind;
	readonly email?: string;
};

export type Unusable = 'disabled' | 'reserved' | 'missing';

export type AccountView = Account & {limitedUntil?: number; reason?: LimitReason; installed?: boolean; unusable?: Unusable};

type Limit = {until: number; reason: LimitReason};
export type AuthState = {v: 1; order: string[]; limits: Record<string, Limit>; installed?: string; migrated?: {at: string; accounts: number}};

export const ENV_KEY = 'env-key';
export const ENV_TOKEN = 'env-token';
export const RESERVED = new Set([ENV_KEY, ENV_TOKEN]);
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_NAMES = 64;
export const API_KEY_RE = /^sk-ant-(?!oat)[A-Za-z0-9_-]{20,}$/;
export const OAUTH_TOKEN_RE = /^sk-ant-oat[0-9A-Za-z_-]{20,}$/;

export type AccountsCtx = {dataDir: string; configDir: string; env: NodeJS.ProcessEnv; now?: () => number; bundle: CredentialBundle};

export const authFile = (dataDir: string): string => path.join(dataDir, 'auth.json');
const nowSec = (ctx: AccountsCtx) => Math.floor((ctx.now?.() ?? Date.now()) / 1000);

export class LoginUnsavedError extends Error {
	override name = 'LoginUnsavedError';
	constructor() {
		super('The Claude login was refreshed and is not saved yet; try again in a moment');
	}
}

export function checkAccountName(name: string | undefined): string {
	if (name === undefined || !ACCOUNT_NAME_RE.test(name)) {
		throw new Error('An account name is up to 32 lowercase letters, digits, _ and -, starting with a letter or digit (e.g. work)');
	}
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
	const out: AuthState = {v: 1, order: [], limits: {}};
	if (!isRecord(raw)) return out;
	if (Array.isArray(raw.order)) out.order = [...new Set(raw.order.filter((n): n is string => typeof n === 'string' && ACCOUNT_NAME_RE.test(n)))].slice(0, MAX_NAMES);
	if (isRecord(raw.limits)) {
		for (const [name, l] of Object.entries(raw.limits)) {
			if (!ACCOUNT_NAME_RE.test(name) || !isRecord(l) || typeof l.until !== 'number' || !Number.isFinite(l.until)) continue;
			out.limits[name] = {until: l.until, reason: l.reason === 'billing' ? 'billing' : 'usage-limit'};
		}
	}
	if (typeof raw.installed === 'string' && ACCOUNT_NAME_RE.test(raw.installed)) out.installed = raw.installed;
	const m = raw.migrated;
	if (isRecord(m) && typeof m.at === 'string' && typeof m.accounts === 'number') out.migrated = {at: m.at.slice(0, 40), accounts: m.accounts};
	return out;
}

export const writeAuth = (dataDir: string, f: AuthState): void => writeAtomic(authFile(dataDir), JSON.stringify(f, null, '\t') + '\n');

export const storedEntries = (bundle: CredentialBundle): readonly VaultEntry[] => (bundle.status === 'ok' ? bundle.entries : []);

const unusableOf = (e: VaultEntry): Unusable | undefined =>
	e.reserved ? 'reserved' : e.disabled ? 'disabled' : e.value === undefined && e.slot === undefined ? 'missing' : undefined;

function saveAuth(ctx: AccountsCtx, f: AuthState): void {
	if (ctx.bundle.status === 'ok') {
		const known = new Set([ENV_KEY, ENV_TOKEN, ...ctx.bundle.entries.map(e => e.name)]);
		f.order = f.order.filter(n => known.has(n));
		for (const n of Object.keys(f.limits)) if (!known.has(n)) delete f.limits[n];
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

function ordered(ctx: AccountsCtx, f: AuthState): Array<Account & {unusable?: Unusable}> {
	const stored = storedEntries(ctx.bundle);
	const withMark = (e: VaultEntry) => {
		const u = unusableOf(e);
		return {...publicOf(e), ...(u && {unusable: u})};
	};
	const all = [
		...envAccounts(ctx.env),
		...stored.filter(e => e.type === 'login').map(withMark),
		...stored.filter(e => e.type !== 'login').map(withMark),
	];
	const rank = (a: Account) => {
		const i = f.order.indexOf(a.name);
		return i < 0 ? f.order.length + all.indexOf(a) : i;
	};
	return [...all].sort((a, b) => rank(a) - rank(b));
}

export function listAccounts(ctx: AccountsCtx): AccountView[] {
	const f = readAuth(ctx.dataDir);
	const now = nowSec(ctx);
	return ordered(ctx, f).map(a => {
		const l = f.limits[a.name];
		return {...a, ...(l && l.until > now && {limitedUntil: l.until, reason: l.reason}), ...(f.installed === a.name && {installed: true})};
	});
}

export function chooseAccount(ctx: AccountsCtx): AccountView | undefined {
	const list = listAccounts(ctx).filter(a => a.unusable === undefined);
	return list.find(a => a.limitedUntil === undefined) ?? [...list].sort((a, b) => (a.limitedUntil ?? 0) - (b.limitedUntil ?? 0))[0];
}

export function ranksAbove(ctx: AccountsCtx, a: string, b: string): boolean {
	const names = listAccounts(ctx).map(x => x.name);
	const i = names.indexOf(a);
	const j = names.indexOf(b);
	return i >= 0 && j >= 0 && i < j;
}

export type Prepared = {account: Account; kind: AccountKind; value: string; login: boolean};

export function workingCopyDirty(ctx: AccountsCtx): boolean {
	const wc = readWorkingCopy(ctx.configDir);
	if (wc.state === 'none') return false;
	if (wc.state === 'bad') return true;
	const f = readAuth(ctx.dataDir);
	const inst = storedEntries(ctx.bundle).find(e => e.name === f.installed && e.type === 'login');
	if (!inst?.slot) return true;
	if (slotDigest(wc.slot) === slotDigest(inst.slot)) return false;
	return !(sameClaudeAccount(wc.slot, inst.slot) && (expiresAt(wc.slot) ?? 0) < (expiresAt(inst.slot) ?? 0));
}

export function prepareAccount(ctx: AccountsCtx, name: string): Prepared {
	if (name === ENV_KEY || name === ENV_TOKEN) {
		const value = nonEmpty(name === ENV_KEY ? ctx.env.ANTHROPIC_API_KEY : ctx.env.CLAUDE_CODE_OAUTH_TOKEN);
		if (!value) throw new Error(`The environment variable for "${name}" is not set`);
		return {account: {name, type: 'env', kind: name === ENV_KEY ? 'api-key' : 'oauth'}, kind: name === ENV_KEY ? 'api-key' : 'oauth', value, login: false};
	}
	const entry = storedEntries(ctx.bundle).find(e => e.name === name);
	if (!entry || entry.reserved) throw new Error(`No account "${name}"; "claude auth status" lists them`);
	if (entry.disabled) throw new Error(`Account "${name}" is disabled in the account module`);
	if (entry.type !== 'login') {
		if (entry.value === undefined) throw new Error(`Account "${name}" has no secret set in the account module`);
		return {account: publicOf(entry), kind: entry.kind, value: entry.value, login: false};
	}
	const slot = entry.slot;
	if (!slot) throw new Error(`The login of account "${name}" is missing; sign in again with "claude auth login --name ${name}"`);
	const f = readAuth(ctx.dataDir);
	const wc = readWorkingCopy(ctx.configDir);
	const there = f.installed === name && wc.state === 'ok' && sameClaudeAccount(wc.slot, slot) && (expiresAt(wc.slot) ?? 0) >= (expiresAt(slot) ?? 0);
	if (!there) {
		if (workingCopyDirty(ctx)) throw new LoginUnsavedError();
		installSlot(ctx.configDir, slot);
		f.installed = name;
		saveAuth(ctx, f);
	}
	return {account: publicOf(entry), kind: entry.kind, value: '', login: true};
}

export function markLimited(ctx: AccountsCtx, name: string, until: number, reason: LimitReason): void {
	const f = readAuth(ctx.dataDir);
	f.limits[name] = {until: Math.floor(until), reason};
	const now = nowSec(ctx);
	for (const [n, l] of Object.entries(f.limits)) if (l.until <= now) delete f.limits[n];
	saveAuth(ctx, f);
}

export const secretType = (value: string): 'key' | 'token' => {
	const type = OAUTH_TOKEN_RE.test(value) ? 'token' : API_KEY_RE.test(value) ? 'key' : undefined;
	if (!type) throw new Error('That is neither an Anthropic API key (sk-ant-…) nor a subscription token (sk-ant-oat…)');
	return type;
};

export function suggestSecretName(ctx: AccountsCtx, raw: string): string {
	const value = raw.trim();
	const type = secretType(value);
	const stored = storedEntries(ctx.bundle);
	const dup = stored.find(e => e.value === value);
	if (dup) throw new Error(`That ${type === 'key' ? 'key' : 'token'} is already account "${dup.name}"`);
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
	setOrder(ctx, [name]);
	const f = readAuth(ctx.dataDir);
	delete f.limits[name];
	saveAuth(ctx, f);
	return listAccounts(ctx);
}

const withBundle = (ctx: AccountsCtx, vault: ClaudeVault): AccountsCtx => ({...ctx, bundle: vault.current()});

export async function addSecretAccount(ctx: AccountsCtx, vault: ClaudeVault, rawName: string | undefined, raw: string): Promise<Account> {
	const account = await vault.addSecret(rawName, raw);
	const f = readAuth(ctx.dataDir);
	delete f.limits[account.name];
	saveAuth(withBundle(ctx, vault), f);
	return account;
}

export async function adoptLoginAccount(ctx: AccountsCtx, vault: ClaudeVault, rawName: string | undefined, slot: LoginSlot): Promise<Account> {
	const same = storedEntries(vault.current()).find(e => e.type === 'login' && e.slot !== undefined && sameClaudeAccount(e.slot, slot));
	const account = await vault.adoptLogin(rawName, slot);
	const f = readAuth(ctx.dataDir);
	if (same && same.name !== account.name) f.order = f.order.map(n => (n === same.name ? account.name : n));
	f.installed = account.name;
	delete f.limits[account.name];
	saveAuth(withBundle(ctx, vault), f);
	return account;
}

export async function removeAccount(ctx: AccountsCtx, vault: ClaudeVault, name: string): Promise<{wasInstalled: boolean}> {
	if (RESERVED.has(name)) throw new Error(`"${name}" comes from an environment variable; unset the variable instead`);
	await vault.remove(name);
	const f = readAuth(ctx.dataDir);
	f.order = f.order.filter(n => n !== name);
	delete f.limits[name];
	const wasInstalled = f.installed === name;
	if (wasInstalled) {
		delete f.installed;
		clearLogin(ctx.configDir);
	}
	saveAuth(withBundle(ctx, vault), f);
	return {wasInstalled};
}

export async function removeAllAccounts(ctx: AccountsCtx, vault: ClaudeVault): Promise<number> {
	const removed = await vault.removeAll();
	clearLogin(ctx.configDir);
	const f = readAuth(ctx.dataDir);
	delete f.installed;
	saveAuth(withBundle(ctx, vault), f);
	return removed;
}
