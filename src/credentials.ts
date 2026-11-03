import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
import type {LoginProbe, LoginStatus} from './claude-login.js';
import {
	type Account,
	type AccountsCtx,
	addSecretAccount,
	chooseAccount,
	listAccounts,
	prepareAccount,
	storedEntries,
	type ChooseOpts,
} from './accounts.js';
import {loginPresent} from './login-slot.js';
import {migrateAuthState, migrateLegacy} from './migrate.js';
import {errClass, noopLog} from './log.js';
import type {Credential, CredentialInfo, CredentialKind, CredentialSource} from './types.js';
import {bundleSecrets, type ClaudeVault, type CredentialBundle, degradedReason, hostVault} from './vault.js';

const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
	/sk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
];

const makeCredential = (kind: CredentialKind, source: CredentialSource, value: string, account?: string, passthrough?: true): Credential => {
	const cred = {kind, source, ...(account !== undefined && {account}), ...(passthrough && {passthrough})};
	Object.defineProperty(cred, 'value', {value, enumerable: false});
	Object.defineProperty(cred, 'toJSON', {value: () => ({kind, source, value: '[redacted]'}), enumerable: false});
	Object.defineProperty(cred, inspect.custom, {value: () => `Credential<${kind}, ${source}> [redacted]`, enumerable: false});
	Object.defineProperty(cred, 'toString', {value: () => '[redacted]', enumerable: false});
	return cred as Credential;
};

export type CredentialOpts = {
	env: NodeJS.ProcessEnv;
	dataDir: string;
	vault?: ClaudeVault;
	log?: Logger;
	probeLogin?: LoginProbe;
	now?: () => number;
};

let envOnly: ClaudeVault | undefined;
export const vaultOf = (opts: Pick<CredentialOpts, 'vault'>): ClaudeVault => opts.vault ?? (envOnly ??= hostVault(undefined));

const LOGIN_TTL_MS = 60_000;
const loginInfo = new Map<string, {at: number; status: LoginStatus | undefined}>();

export const refreshLoginInfo = async (opts: CredentialOpts, force = false): Promise<void> => {
	if (!opts.probeLogin) return;
	const now = (opts.now ?? Date.now)();
	const seen = loginInfo.get(opts.dataDir);
	if (!force && seen && now - seen.at < LOGIN_TTL_MS) return;
	let status: LoginStatus | undefined;
	try {
		status = await opts.probeLogin();
	} catch {
	}
	loginInfo.set(opts.dataDir, {at: now, status});
};

export const accountsCtx = (opts: CredentialOpts): AccountsCtx => {
	const configDir = join(opts.dataDir, 'config');
	const status = loginInfo.get(opts.dataDir)?.status;
	const signedIn = status?.loggedIn === true;
	return {
		dataDir: opts.dataDir,
		configDir,
		env: opts.env,
		bundle: vaultOf(opts).current(),
		login: {
			present: loginPresent(configDir) || signedIn,
			kind: signedIn && status.method === 'console' ? 'api-key' : 'oauth',
			...(signedIn && status.email !== undefined && {email: status.email}),
		},
	};
};

const started = new WeakMap<ClaudeVault, Promise<unknown>>();
const stateMigrated = new Set<string>();

export const loadBundle = async (opts: CredentialOpts): Promise<CredentialBundle> => {
	const vault = vaultOf(opts);
	if (!stateMigrated.has(opts.dataDir)) {
		stateMigrated.add(opts.dataDir);
		try {
			migrateAuthState(opts.dataDir, opts.log ?? noopLog);
		} catch (err) {
			stateMigrated.delete(opts.dataDir);
			(opts.log ?? noopLog).warn('auth state not migrated', {errClass: errClass(err)});
		}
	}
	await refreshLoginInfo(opts);
	const bundle = await vault.load();
	if (!vault.channel || bundle.status !== 'ok') return bundle;
	let first = started.get(vault);
	if (!first) {
		first = (async () => {
			const moved = await migrateLegacy({dataDir: opts.dataDir, vault, log: opts.log ?? noopLog});
			if (moved === 'deferred') started.delete(vault);
		})();
		started.set(vault, first);
	}
	await first;
	return vault.current();
};

const sourceOf = (a: Account): CredentialSource => (a.type === 'env' ? 'env' : a.type === 'login' ? 'claude-login' : 'stored');

const credentialOf = (opts: CredentialOpts, a: Account): Credential => {
	let value = '';
	let passthrough: true | undefined;
	if (a.type !== 'login') {
		try {
			const p = prepareAccount(accountsCtx(opts), a.name);
			value = p.value;
			passthrough = p.passthrough;
		} catch {
		}
	}
	return makeCredential(a.kind, sourceOf(a), value, a.name, passthrough);
};

export const listCredentialSources = async (opts: CredentialOpts): Promise<Credential[]> => {
	await loadBundle(opts);
	return listAccounts(accountsCtx(opts))
		.filter(a => a.unusable === undefined)
		.map(a => credentialOf(opts, a));
};

export const resolveCredential = async (opts: CredentialOpts, sel: ChooseOpts = {}): Promise<Credential | undefined> => {
	await loadBundle(opts);
	const a = chooseAccount(accountsCtx(opts), sel);
	return a ? credentialOf(opts, a) : undefined;
};

export const NO_CREDENTIALS =
	'No credentials found. Run "claude auth login" to sign in with Claude Code, or "claude auth add" to paste an API key. See "claude auth status".';

export const API_KEY_ONLY =
	'A chat started by the scheduler runs only on an API key: Claude subscription plans are for your own interactive use. Add one with "claude auth add" or set ANTHROPIC_API_KEY.';

export const noCredentials = (bundle: CredentialBundle): string => {
	const reason = degradedReason(bundle.status);
	return reason ? `No credentials found. ${reason}` : NO_CREDENTIALS;
};

export const requireCredential = async (opts: CredentialOpts, sel: ChooseOpts = {}): Promise<Credential> => {
	const cred = await resolveCredential(opts, sel);
	if (!cred) throw new Error(sel.apiKeyOnly ? API_KEY_ONLY : noCredentials(vaultOf(opts).current()));
	return cred;
};

export const prepareCredential = (opts: CredentialOpts, sel: ChooseOpts = {}): Credential => {
	const ctx = accountsCtx(opts);
	const a = chooseAccount(ctx, sel);
	if (!a) throw new Error(sel.apiKeyOnly ? API_KEY_ONLY : noCredentials(ctx.bundle));
	const p = prepareAccount(ctx, a.name);
	return makeCredential(p.kind, sourceOf(p.account), p.value, p.account.name, p.passthrough);
};

export const storeSecret = async (opts: CredentialOpts, value: string, name?: string): Promise<Account> => {
	await loadBundle(opts);
	return addSecretAccount(accountsCtx(opts), vaultOf(opts), name, value);
};

export const isSubscription = (info: CredentialInfo): boolean => info.kind === 'oauth';

export const describeCredential = (info: CredentialInfo): string => {
	const named = info.account !== undefined && info.source !== 'env' ? `account "${info.account}": ` : '';
	if (info.source === 'claude-login') return `${named}Claude Code login (${info.kind === 'api-key' ? 'Console' : 'subscription'})`;
	if (info.source === 'env') return info.kind === 'api-key' ? 'API key (from environment)' : 'subscription token (from environment)';
	return `${named}API key (stored in the account module)`;
};

export const inspectFileMode = async (dataDir: string): Promise<string[]> => {
	const warnings: string[] = [];
	for (const name of ['auth.json', join('config', '.credentials.json')]) {
		try {
			const {mode} = await stat(join(dataDir, name));
			if (mode & 0o077) {
				warnings.push(
					`${name} is readable by other users (mode ${(mode & 0o777).toString(8)}). Run: chmod 600 ${join(dataDir, name)}`,
				);
			}
		} catch {
		}
	}
	return warnings;
};

export const makeRedactor = (
	cred?: Credential,
	others: readonly string[] | (() => readonly string[]) = [],
	extra?: (text: string) => string,
): ((text: string) => string) => {
	const own = cred?.value ?? '';
	const valuesOf = (list: readonly string[]) => [...new Set([own, ...list].filter(v => v.length >= 8))].sort((a, b) => b.length - a.length);
	let lastList: readonly string[] | undefined;
	let values = typeof others === 'function' ? [] : valuesOf(others);
	return text => {
		if (typeof others === 'function') {
			const list = others();
			if (list !== lastList) {
				lastList = list;
				values = valuesOf(list);
			}
		}
		let out = text;
		for (const v of values) out = out.split(v).join('[redacted]');
		for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
		if (extra) {
			try {
				out = extra(out);
			} catch {
			}
		}
		return out;
	};
};

const envSecrets = (env: NodeJS.ProcessEnv): string[] => [env.ANTHROPIC_API_KEY].flatMap(v => (v?.trim() ? [v.trim()] : []));

export const allSecrets = (opts: CredentialOpts): string[] => [...bundleSecrets(vaultOf(opts).current()), ...envSecrets(opts.env)];

export const liveSecrets = (opts: CredentialOpts): (() => readonly string[]) => {
	let bundle: CredentialBundle | undefined;
	let list: readonly string[] = [];
	return () => {
		const now = vaultOf(opts).current();
		if (now !== bundle) {
			bundle = now;
			list = allSecrets(opts);
		}
		return list;
	};
};

export const storedCount = (opts: CredentialOpts): number => storedEntries(vaultOf(opts).current()).length;

const registered = new WeakMap<Logger, Set<string>>();

export const registerLogValues = (log: Logger, values: readonly string[]): void => {
	let seen = registered.get(log);
	if (!seen) registered.set(log, (seen = new Set()));
	for (const value of values) {
		if (value.length < 8) continue;
		const digest = createHash('sha256').update(value).digest('hex');
		if (seen.has(digest)) continue;
		seen.add(digest);
		log.addRedactor(text => text.split(value).join('[redacted]'));
	}
};

export const registerLogRedaction = (log: Logger, cred: Credential): void => {
	if (cred.value === '') return;
	const digest = createHash('sha256').update(cred.value).digest('hex');
	let seen = registered.get(log);
	if (!seen) registered.set(log, (seen = new Set()));
	if (seen.has(digest)) return;
	seen.add(digest);
	log.addRedactor(makeRedactor(cred));
};

export const noteLoginStatus = (opts: CredentialOpts, status: LoginStatus | undefined): void => {
	loginInfo.set(opts.dataDir, {at: (opts.now ?? Date.now)(), status});
};
