import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {lstat, readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
import type {LoginProbe} from './claude-login.js';
import {atomicWriteFile} from './fsutil.js';
import type {Credential, CredentialInfo, CredentialKind, CredentialSource} from './types.js';

const API_KEY = /^sk-ant-(?!oat)[A-Za-z0-9_-]{20,}$/;
const SECRET_PATTERN = /sk-ant-[A-Za-z0-9_-]{8,}/g;

const makeCredential = (kind: CredentialKind, source: CredentialSource, value: string): Credential => {
	const cred = {kind, source};
	Object.defineProperty(cred, 'value', {value, enumerable: false});
	Object.defineProperty(cred, 'toJSON', {value: () => ({kind, source, value: '[redacted]'}), enumerable: false});
	Object.defineProperty(cred, inspect.custom, {value: () => `Credential<${kind}, ${source}> [redacted]`, enumerable: false});
	Object.defineProperty(cred, 'toString', {value: () => '[redacted]', enumerable: false});
	return cred as Credential;
};

const nonEmpty = (v: string | undefined): string | undefined => {
	const t = v?.trim();
	return t ? t : undefined;
};

const readText = async (file: string): Promise<string | undefined> => {
	try {
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
};

const OAUTH_TOKEN = /^sk-ant-oat[0-9A-Za-z_-]{20,}$/;

const storedFile = (dataDir: string) => join(dataDir, 'credentials.json');

const readStored = async (dataDir: string): Promise<Credential | undefined> => {
	const text = await readText(storedFile(dataDir));
	if (text === undefined) return undefined;
	try {
		const raw = JSON.parse(text) as unknown;
		if (typeof raw !== 'object' || raw === null) return undefined;
		const r = raw as Record<string, unknown>;
		if (typeof r.value !== 'string') return undefined;
		if (r.kind === 'api-key' && API_KEY.test(r.value)) return makeCredential('api-key', 'stored', r.value);
		if (r.kind === 'oauth' && OAUTH_TOKEN.test(r.value)) return makeCredential('oauth', 'stored', r.value);
		return undefined;
	} catch {
		return undefined;
	}
};

export type CredentialOpts = {
	env: NodeJS.ProcessEnv;
	dataDir: string;
	probeLogin?: LoginProbe;
};

const loginFile = (dataDir: string) => join(dataDir, 'config', '.credentials.json');

// Metadata only: the file holds the login tokens and is never opened.
const loginFileExists = async (dataDir: string): Promise<boolean> => {
	try {
		const st = await lstat(loginFile(dataDir));
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
};

const readLogin = async (opts: CredentialOpts): Promise<Credential | undefined> => {
	const status = opts.probeLogin ? await opts.probeLogin().catch(() => undefined) : undefined;
	if (status) {
		if (!status.loggedIn || !status.method) return undefined;
		return makeCredential(status.method === 'console' ? 'api-key' : 'oauth', 'claude-login', '');
	}
	return (await loginFileExists(opts.dataDir)) ? makeCredential('oauth', 'claude-login', '') : undefined;
};

/** Every available credential, in precedence order; resolveCredential returns the first. */
export const listCredentialSources = async (opts: CredentialOpts): Promise<Credential[]> => {
	const out: Credential[] = [];
	const apiKey = nonEmpty(opts.env.ANTHROPIC_API_KEY);
	if (apiKey) out.push(makeCredential('api-key', 'env', apiKey));
	const oauth = nonEmpty(opts.env.CLAUDE_CODE_OAUTH_TOKEN);
	if (oauth) out.push(makeCredential('oauth', 'env', oauth));
	for (const found of [await readLogin(opts), await readStored(opts.dataDir)]) {
		if (found) out.push(found);
	}
	return out;
};

export const resolveCredential = async (opts: CredentialOpts): Promise<Credential | undefined> => {
	const apiKey = nonEmpty(opts.env.ANTHROPIC_API_KEY);
	if (apiKey) return makeCredential('api-key', 'env', apiKey);
	const oauth = nonEmpty(opts.env.CLAUDE_CODE_OAUTH_TOKEN);
	if (oauth) return makeCredential('oauth', 'env', oauth);
	return (await readLogin(opts)) ?? (await readStored(opts.dataDir));
};

export const requireCredential = async (opts: CredentialOpts): Promise<Credential> => {
	const cred = await resolveCredential(opts);
	if (!cred) {
		throw new Error(
			'No credentials found. Set ANTHROPIC_API_KEY, run "claude auth login", or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
		);
	}
	return cred;
};

const writeStored = async (dataDir: string, kind: 'api-key' | 'oauth', value: string): Promise<void> => {
	const body = {kind, value, savedAt: new Date().toISOString()};
	await atomicWriteFile(storedFile(dataDir), JSON.stringify(body, null, '\t') + '\n', 0o600);
};

export const storeApiKey = async (dataDir: string, value: string): Promise<void> => {
	const key = value.trim();
	if (key.startsWith('sk-ant-oat')) {
		throw new Error(
			'This looks like a subscription (OAuth) token, not an API key. Run "claude auth login --token" or set CLAUDE_CODE_OAUTH_TOKEN instead.',
		);
	}
	if (!API_KEY.test(key)) throw new Error('Invalid API key format. Expected a key starting with "sk-ant-".');
	await writeStored(dataDir, 'api-key', key);
};

/** Saves a subscription (OAuth) token, as from "claude setup-token", to credentials.json (0600), replacing a stored key. */
export const storeOauthToken = async (dataDir: string, value: string): Promise<void> => {
	const token = value.trim();
	if (!OAUTH_TOKEN.test(token)) throw new Error('That is not a subscription token (it should start with "sk-ant-oat").');
	await writeStored(dataDir, 'oauth', token);
};

export const removeStored = async (dataDir: string): Promise<boolean> => {
	const file = storedFile(dataDir);
	try {
		await stat(file);
	} catch {
		return false;
	}
	await rm(file, {force: true});
	return true;
};

export const isSubscription = (info: CredentialInfo): boolean => info.kind === 'oauth';

export const describeCredential = (info: CredentialInfo): string => {
	if (info.source === 'claude-login') {
		return info.kind === 'api-key' ? 'Console API key (Claude Code login)' : 'Claude subscription (Claude Code login)';
	}
	const what = info.kind === 'api-key' ? 'API key' : 'subscription token';
	const where = info.source === 'env' ? 'from environment' : 'stored by yena';
	return `${what} (${where})`;
};

export const inspectFileMode = async (dataDir: string): Promise<string[]> => {
	const warnings: string[] = [];
	for (const name of ['credentials.json', join('config', '.credentials.json')]) {
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

export const makeRedactor = (cred?: Credential): ((text: string) => string) => {
	return text => {
		let out = text;
		if (cred?.value) out = out.split(cred.value).join('[redacted]');
		return out.replace(SECRET_PATTERN, '[redacted]');
	};
};

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
