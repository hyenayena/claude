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
	API_KEY_RE,
	chooseAccount,
	listAccounts,
	OAUTH_TOKEN_RE,
	prepareAccount,
	removeAllAccounts,
} from './accounts.js';
import type {Credential, CredentialInfo, CredentialKind, CredentialSource} from './types.js';

const SECRET_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/g;

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
	'No credentials found. Set ANTHROPIC_API_KEY, run "claude auth login", or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".';

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

/** Stores an API key as an account (named "key" unless given). */
export const storeApiKey = async (dataDir: string, value: string, name?: string, env: NodeJS.ProcessEnv = {}): Promise<Account> => {
	const key = value.trim();
	if (key.startsWith('sk-ant-oat')) {
		throw new Error(
			'This looks like a subscription (OAuth) token, not an API key. Run "claude auth login --token" or set CLAUDE_CODE_OAUTH_TOKEN instead.',
		);
	}
	if (!API_KEY_RE.test(key)) throw new Error('Invalid API key format. Expected a key starting with "sk-ant-".');
	return addSecretAccount(accountsCtx({dataDir, env}), name, key);
};

/** Stores a subscription (setup-token) token as an account (named "token" unless given). */
export const storeOauthToken = async (dataDir: string, value: string, name?: string, env: NodeJS.ProcessEnv = {}): Promise<Account> => {
	const token = value.trim();
	if (!OAUTH_TOKEN_RE.test(token)) throw new Error('That is not a subscription token (it should start with "sk-ant-oat").');
	return addSecretAccount(accountsCtx({dataDir, env}), name, token);
};

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
		return out.replace(SECRET_PATTERN, '[redacted]');
	};
};

/** Every secret yena may hand to Claude Code (stored accounts and the environment variables), for redaction. */
export const allSecrets = (opts: CredentialOpts): string[] => [
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
