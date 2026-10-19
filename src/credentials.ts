import {createHash} from 'node:crypto';
import {inspect} from 'node:util';
import {readFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import type {Logger} from '../../../src/api.js';
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

const storedFile = (dataDir: string) => join(dataDir, 'credentials.json');

const readStored = async (dataDir: string): Promise<Credential | undefined> => {
	const text = await readText(storedFile(dataDir));
	if (text === undefined) return undefined;
	try {
		const raw = JSON.parse(text) as unknown;
		if (typeof raw !== 'object' || raw === null) return undefined;
		const r = raw as Record<string, unknown>;
		if (r.kind !== 'api-key' || typeof r.value !== 'string' || !API_KEY.test(r.value)) return undefined;
		return makeCredential('api-key', 'stored', r.value);
	} catch {
		return undefined;
	}
};

export const resolveCredential = async (opts: {
	env: NodeJS.ProcessEnv;
	dataDir: string;
}): Promise<Credential | undefined> => {
	const apiKey = nonEmpty(opts.env.ANTHROPIC_API_KEY);
	if (apiKey) return makeCredential('api-key', 'env', apiKey);
	const oauth = nonEmpty(opts.env.CLAUDE_CODE_OAUTH_TOKEN);
	if (oauth) return makeCredential('oauth', 'env', oauth);
	const stored = await readStored(opts.dataDir);
	if (stored) return stored;
	// Same parsing as bin/claude: every space, newline and CR is dropped.
	const legacy = (await readText(join(opts.dataDir, '.token')))?.replace(/[ \n\r]/g, '');
	if (legacy) return makeCredential('oauth', 'legacy-file', legacy);
	return undefined;
};

export const requireCredential = async (opts: {env: NodeJS.ProcessEnv; dataDir: string}): Promise<Credential> => {
	const cred = await resolveCredential(opts);
	if (!cred) {
		throw new Error(
			'No credentials found. Set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
		);
	}
	return cred;
};

export const storeApiKey = async (dataDir: string, value: string): Promise<void> => {
	const key = value.trim();
	if (key.startsWith('sk-ant-oat')) {
		throw new Error(
			'This looks like a subscription (OAuth) token, not an API key. Put it in <data dir>/.token or set CLAUDE_CODE_OAUTH_TOKEN instead.',
		);
	}
	if (!API_KEY.test(key)) throw new Error('Invalid API key format. Expected a key starting with "sk-ant-".');
	const body = {kind: 'api-key', value: key, savedAt: new Date().toISOString()};
	await atomicWriteFile(storedFile(dataDir), JSON.stringify(body, null, '\t') + '\n', 0o600);
};

const OAUTH_TOKEN = /^sk-ant-oat[0-9A-Za-z_-]{20,}$/;

/** Saves a subscription (OAuth) token, as from "claude setup-token", to the legacy file .token (0600). */
export const storeOauthToken = async (dataDir: string, value: string): Promise<void> => {
	const token = value.trim();
	if (!OAUTH_TOKEN.test(token)) throw new Error('That is not a subscription token (it should start with "sk-ant-oat").');
	await atomicWriteFile(join(dataDir, '.token'), `${token}\n`, 0o600);
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
	const what = info.kind === 'api-key' ? 'API key' : 'subscription token';
	const where =
		info.source === 'env' ? 'from environment' : info.source === 'stored' ? 'stored by yena' : 'from legacy file .token';
	return `${what} (${where})`;
};

export const inspectFileMode = async (dataDir: string): Promise<string[]> => {
	const warnings: string[] = [];
	for (const name of ['.token', 'credentials.json']) {
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
	const digest = createHash('sha256').update(cred.value).digest('hex');
	let seen = registered.get(log);
	if (!seen) registered.set(log, (seen = new Set()));
	if (seen.has(digest)) return;
	seen.add(digest);
	log.addRedactor(makeRedactor(cred));
};
