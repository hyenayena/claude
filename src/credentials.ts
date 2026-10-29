import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
import type {LoginProbe} from './claude-login.js';
import {
	type Account,
	type AccountsCtx,
	addSecretAccount,
	chooseAccount,
	listAccounts,
	prepareAccount,
	removeAllAccounts,
	storedEntries,
} from './accounts.js';
import {loginSyncFor} from './login-sync.js';
import {migrateLegacy} from './migrate.js';
import {noopLog} from './log.js';
import type {Credential, CredentialInfo, CredentialKind, CredentialSource} from './types.js';
import {bundleSecrets, type ClaudeVault, type CredentialBundle, degradedReason, hostVault} from './vault.js';

// Secret shapes masked in everything the chat shows. Unlike the host log's redactor there is no
// "token: <rest of line>" rule here: chat text talks about tokens and keys all the time.
const SECRET_PATTERNS = [
	/-----BEGIN [A-Z ]{0,30}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z ]{0,30}PRIVATE KEY-----|$)/g,
	/sk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9]{20,}/g,
	/\bgh[pousr]_[A-Za-z0-9]{30,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
];

const makeCredential = (kind: CredentialKind, source: CredentialSource, value: string, account?: string): Credential => {
	const cred = {kind, source, ...(account !== undefined && {account})};
	Object.defineProperty(cred, 'value', {value, enumerable: false});
	Object.defineProperty(cred, 'toJSON', {value: () => ({kind, source, value: '[redacted]'}), enumerable: false});
	Object.defineProperty(cred, inspect.custom, {value: () => `Credential<${kind}, ${source}> [redacted]`, enumerable: false});
	Object.defineProperty(cred, 'toString', {value: () => '[redacted]', enumerable: false});
	return cred as Credential;
};

export type CredentialOpts = {
	env: NodeJS.ProcessEnv;
	dataDir: string;
	/** Where stored accounts come from; without one only the environment variables count. */
	vault?: ClaudeVault;
	log?: Logger;
	// Kept for callers that pass it; accounts are read from the bundle, not by asking the CLI.
	probeLogin?: LoginProbe;
	now?: () => number;
};

// Created on first use: vault.ts and this file import each other.
let envOnly: ClaudeVault | undefined;
export const vaultOf = (opts: Pick<CredentialOpts, 'vault'>): ClaudeVault => opts.vault ?? (envOnly ??= hostVault(undefined));

export const accountsCtx = (opts: CredentialOpts): AccountsCtx => ({
	dataDir: opts.dataDir,
	configDir: join(opts.dataDir, 'config'),
	env: opts.env,
	...(opts.now && {now: opts.now}),
	bundle: vaultOf(opts).current(),
});

export const loginSyncOf = (opts: CredentialOpts) =>
	loginSyncFor({dataDir: opts.dataDir, configDir: join(opts.dataDir, 'config'), env: opts.env, vault: vaultOf(opts), ...(opts.log && {log: opts.log})});

const started = new WeakMap<ClaudeVault, Promise<unknown>>();

/**
 * Loads the bundle; in yena the first use also moves old stored accounts into the account module
 * (again later while that is deferred) and saves a login a runner left unsaved.
 */
export const loadBundle = async (opts: CredentialOpts): Promise<CredentialBundle> => {
	const vault = vaultOf(opts);
	const bundle = await vault.load();
	if (!vault.channel || bundle.status !== 'ok') return bundle;
	let first = started.get(vault);
	if (!first) {
		first = (async () => {
			const moved = await migrateLegacy({dataDir: opts.dataDir, configDir: join(opts.dataDir, 'config'), vault, log: opts.log ?? noopLog});
			if (moved === 'deferred') started.delete(vault);
			await loginSyncOf(opts).sync();
		})();
		started.set(vault, first);
	}
	await first;
	return vault.current();
};

const sourceOf = (a: Account): CredentialSource => (a.type === 'env' ? 'env' : a.type === 'login' ? 'claude-login' : 'stored');

// The secret of an env, key or token account, read without changing anything on disk.
const secretOf = (opts: CredentialOpts, a: Account): string => {
	if (a.type === 'login') return '';
	try {
		return prepareAccount(accountsCtx(opts), a.name).value;
	} catch {
		return '';
	}
};

const credentialOf = (opts: CredentialOpts, a: Account): Credential => makeCredential(a.kind, sourceOf(a), secretOf(opts, a), a.name);

/** Every usable account in priority order, as credentials (a login's value is empty). */
export const listCredentialSources = async (opts: CredentialOpts): Promise<Credential[]> => {
	await loadBundle(opts);
	return listAccounts(accountsCtx(opts))
		.filter(a => a.unusable === undefined)
		.map(a => credentialOf(opts, a));
};

/** The account a new turn would use; nothing on disk changes (a login is not swapped in). */
export const resolveCredential = async (opts: CredentialOpts): Promise<Credential | undefined> => {
	await loadBundle(opts);
	const a = chooseAccount(accountsCtx(opts));
	return a ? credentialOf(opts, a) : undefined;
};

export const NO_CREDENTIALS =
	'No credentials found. Run "claude auth login" to sign in through the browser, or "claude auth add" to paste an API key or a subscription token. See "claude auth status".';

/** Why nothing was found: the plain message, or the reason stored accounts cannot be used. */
export const noCredentials = (bundle: CredentialBundle): string => {
	const reason = degradedReason(bundle.status);
	return reason ? `No credentials found. ${reason}` : NO_CREDENTIALS;
};

export const requireCredential = async (opts: CredentialOpts): Promise<Credential> => {
	const cred = await resolveCredential(opts);
	if (!cred) throw new Error(noCredentials(vaultOf(opts).current()));
	return cred;
};

/**
 * The credential for Claude Code about to start: the chosen account, a login swapped into the config dir.
 * Call it only while the session lock is held; throws LoginUnsavedError while a refreshed login is unsaved.
 */
export const prepareCredential = (opts: CredentialOpts): Credential => {
	const ctx = accountsCtx(opts);
	const a = chooseAccount(ctx);
	if (!a) throw new Error(noCredentials(ctx.bundle));
	const p = prepareAccount(ctx, a.name);
	return makeCredential(p.kind, sourceOf(p.account), p.value, p.account.name);
};

/**
 * Stores an API key (sk-ant-…) or a subscription token (sk-ant-oat…) as an account in the account
 * module; the prefix decides which. Named "key" or "token" (then "-2"…) unless given.
 */
export const storeSecret = async (opts: CredentialOpts, value: string, name?: string): Promise<Account> => {
	await loadBundle(opts);
	return addSecretAccount(accountsCtx(opts), vaultOf(opts), name, value);
};

/** Removes every stored Claude account and the Claude Code login; true when an account was removed. */
export const removeStored = async (opts: CredentialOpts): Promise<boolean> => {
	await loadBundle(opts);
	return (await removeAllAccounts(accountsCtx(opts), vaultOf(opts))) > 0;
};

export const isSubscription = (info: CredentialInfo): boolean => info.kind === 'oauth';

export const describeCredential = (info: CredentialInfo): string => {
	const named = info.account !== undefined && info.source !== 'env' ? `account "${info.account}": ` : '';
	if (info.source === 'claude-login') {
		return `${named}${info.kind === 'api-key' ? 'Console API key (Claude Code login)' : 'Claude subscription (Claude Code login)'}`;
	}
	const what = info.kind === 'api-key' ? 'API key' : 'subscription token';
	const where = info.source === 'env' ? 'from environment' : 'stored in the account module';
	return `${named}${what} (${where})`;
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
			// missing file: nothing to warn about
		}
	}
	return warnings;
};

/**
 * Masks the credential, the other secrets (a list, or a function read on every call) and common secret
 * shapes; `extra` (the host's `log.redact`) masks what other modules registered.
 */
export const makeRedactor = (
	cred?: Credential,
	others: readonly string[] | (() => readonly string[]) = [],
	extra?: (text: string) => string,
): ((text: string) => string) => {
	const own = cred?.value ?? '';
	// Longest first, so a value that contains another one is masked whole.
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
				// the host's redactor must not break what the chat shows
			}
		}
		return out;
	};
};

const envSecrets = (env: NodeJS.ProcessEnv): string[] => [env.ANTHROPIC_API_KEY, env.CLAUDE_CODE_OAUTH_TOKEN].flatMap(v => (v?.trim() ? [v.trim()] : []));

/** Every secret yena may hand to Claude Code (the bundle and the environment variables), for redaction. */
export const allSecrets = (opts: CredentialOpts): string[] => [...bundleSecrets(vaultOf(opts).current()), ...envSecrets(opts.env)];

/** allSecrets as a function that returns the same list until the bundle changes (for makeRedactor). */
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

/** How many stored accounts the bundle holds (none while degraded). */
export const storedCount = (opts: CredentialOpts): number => storedEntries(vaultOf(opts).current()).length;

// Keyed by a SHA-256 digest so the registry never holds the secret itself.
const registered = new WeakMap<Logger, Set<string>>();

/** Registers an exact-value redactor for each secret not registered with this logger yet. */
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
