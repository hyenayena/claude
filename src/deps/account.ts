// The only file that reaches the account module. It is an optional dependency (not in yena.json):
// loaded at runtime; absent means there are no account secrets to guard. Types are structural copies
// of what the account module's public entry (src/public.ts) exports.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type AccountSecretPaths = {
	/** The account module's data dir; shell commands naming it are refused. */
	dataDir: string;
	/** Dirs holding secret values and SSH private keys; every tool is denied there. */
	secretDirs: string[];
};

const ENTRY = new URL('../../../account/src/public.ts', import.meta.url);
const MANIFEST = new URL('../../../account/yena.json', import.meta.url);

type PublicEntry = {
	accountDataDirFor?: (moduleDataDir: string) => unknown;
	secretDirsFor?: (moduleDataDir: string) => unknown;
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s !== '');

/** Undefined when the account module is not installed. Installed but unloadable: an error, so the chat does not start unguarded. */
export async function loadAccountSecretPaths(moduleDataDir: string): Promise<AccountSecretPaths | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	const mod = (await import(ENTRY.href)) as PublicEntry;
	const dataDir = mod.accountDataDirFor?.(moduleDataDir);
	const secretDirs = mod.secretDirsFor?.(moduleDataDir);
	if (typeof dataDir !== 'string' || dataDir === '' || !isStringList(secretDirs)) {
		throw new Error('The account module does not say where its secrets are; the chat cannot guard them');
	}
	return {dataDir, secretDirs};
}

type AccountsApi = {
	list(): Promise<{name: string; secrets: string[]}[]>;
	secret(name: string, field: string): Promise<string | undefined>;
};

let secretValues: readonly string[] = [];

/** The secret values last read by refreshAccountSecretValues, for redaction only: never print or log them. */
export const accountSecretValues = (): readonly string[] => secretValues;

/**
 * Reads the values of every stored account secret (disabled accounts give none) so the chat can mask
 * them in what it shows. Missing or broken account module: the cache stays empty.
 */
export async function refreshAccountSecretValues(moduleDataDir: string): Promise<void> {
	if (!existsSync(fileURLToPath(MANIFEST))) return;
	try {
		const mod = (await import(ENTRY.href)) as {accountsFor?: (dir: string) => AccountsApi};
		const accounts = mod.accountsFor?.(moduleDataDir);
		if (!accounts) return;
		const out: string[] = [];
		for (const account of await accounts.list()) {
			for (const field of account.secrets) {
				const value = await accounts.secret(account.name, field);
				if (typeof value === 'string' && value.trim() !== '') out.push(value.trim());
			}
		}
		secretValues = out;
	} catch {
		// Keeps the last values; the shape patterns still apply.
	}
}
