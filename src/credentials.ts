import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
import type {LoginProbe} from './claude-login.js';
import {
	type Account,
	type AccountsCtx,
	accountSecrets,
	addSecretAccount,
	chooseAccount,
	listAccounts,
	prepareAccount,
	removeAllAccounts,
} from './accounts.js';
import {accountSecretValues} from './deps/account.js';
import type {Credential, CredentialInfo, CredentialKind, CredentialSource} from './types.js';

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
	// Kept for callers that pass it; accounts are read from the files, not by asking the CLI.
	probeLogin?: LoginProbe;
	now?: () => number;
};

export const accountsCtx = (opts: CredentialOpts): AccountsCtx => ({
	dataDir: opts.dataDir,
	configDir: join(opts.dataDir, 'config'),
	env: opts.env,
	...(opts.now && {now: opts.now}),
});

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

/** Every account in priority order, as credentials (a login's value is empty). */
export const listCredentialSources = async (opts: CredentialOpts): Promise<Credential[]> =>
	listAccounts(accountsCtx(opts)).map(a => credentialOf(opts, a));

/** The account a new turn would use; nothing on disk changes (a login is not swapped in). */
export const resolveCredential = async (opts: CredentialOpts): Promise<Credential | undefined> => {
	const a = chooseAccount(accountsCtx(opts));
	return a ? credentialOf(opts, a) : undefined;
};

export const NO_CREDENTIALS =
	'No credentials found. Run "claude auth login" to sign in through the browser, or "claude auth add" to paste an API key or a subscription token. See "claude auth status".';

export const requireCredential = async (opts: CredentialOpts): Promise<Credential> => {
	const cred = await resolveCredential(opts);
	if (!cred) throw new Error(NO_CREDENTIALS);
	return cred;
};

/**
 * The credential for Claude Code about to start: the chosen account, a login swapped into the config dir.
 * Call it only while the session lock is held.
 */
export const prepareCredential = (opts: CredentialOpts): Credential => {
	const ctx = accountsCtx(opts);
	const a = chooseAccount(ctx);
	if (!a) throw new Error(NO_CREDENTIALS);
	const p = prepareAccount(ctx, a.name);
	return makeCredential(p.kind, sourceOf(p.account), p.value, p.account.name);
};

/**
 * Stores an API key (sk-ant-…) or a subscription token (sk-ant-oat…) as an account; the prefix decides
 * which. Named "key" or "token" (then "-2"…) unless given.
 */
export const storeSecret = async (dataDir: string, value: string, name?: string, env: NodeJS.ProcessEnv = {}): Promise<Account> =>
	addSecretAccount(accountsCtx({dataDir, env}), name, value);

/** Forgets every stored account and the Claude Code login; true when there was anything. */
export const removeStored = async (dataDir: string): Promise<boolean> => {
	const ctx = accountsCtx({dataDir, env: {}});
	const had = listAccounts(ctx).length > 0;
	removeAllAccounts(ctx);
	return had;
};

export const isSubscription = (info: CredentialInfo): boolean => info.kind === 'oauth';

export const describeCredential = (info: CredentialInfo): string => {
	const named = info.account !== undefined && info.source !== 'env' ? `account "${info.account}": ` : '';
	if (info.source === 'claude-login') {
		return `${named}${info.kind === 'api-key' ? 'Console API key (Claude Code login)' : 'Claude subscription (Claude Code login)'}`;
	}
	const what = info.kind === 'api-key' ? 'API key' : 'subscription token';
	const where = info.source === 'env' ? 'from environment' : 'stored by yena';
	return `${named}${what} (${where})`;
};

export const inspectFileMode = async (dataDir: string): Promise<string[]> => {
	const warnings: string[] = [];
	for (const name of ['accounts.json', join('config', '.credentials.json')]) {
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

export const makeRedactor = (cred?: Credential, others: readonly string[] = []): ((text: string) => string) => {
	const values = [...new Set([cred?.value ?? '', ...others].filter(v => v.length >= 8))];
	return text => {
		let out = text;
		for (const v of values) out = out.split(v).join('[redacted]');
		for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
		return out;
	};
};

/**
 * Every secret yena may hand to Claude Code (stored accounts and the environment variables) and the
 * account module's secrets as last read by refreshAccountSecretValues, for redaction.
 */
export const allSecrets = (opts: CredentialOpts): string[] => [
	...accountSecretValues(),
	...accountSecrets(accountsCtx(opts)),
	...[opts.env.ANTHROPIC_API_KEY, opts.env.CLAUDE_CODE_OAUTH_TOKEN].flatMap(v => (v?.trim() ? [v.trim()] : [])),
];

// Keyed by a SHA-256 digest so the registry never holds the secret itself.
const registered = new WeakMap<Logger, Set<string>>();

export const registerLogRedaction = (log: Logger, cred: Credential): void => {
	if (cred.value === '') return;
	const digest = createHash('sha256').update(cred.value).digest('hex');
	let seen = registered.get(log);
	if (!seen) registered.set(log, (seen = new Set()));
	if (seen.has(digest)) return;
	seen.add(digest);
	log.addRedactor(makeRedactor(cred));
};
