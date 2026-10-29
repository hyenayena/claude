// The only file that reaches the account module. It is an optional dependency (not in yena.json):
// loaded at runtime; absent means there are no account secrets to guard. Types are structural copies
// of what the account module's public entry (src/public.ts) exports. Secret values never come from
// here: claude reads its own credentials through the host's credential channel.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type AccountSecretPaths = {
	/** The account module's data dir; shell commands naming it are refused. */
	dataDir: string;
	/** Files and dirs of the account data dir that every tool is denied (all of it but ssh_config). */
	secretDirs: string[];
};

const ENTRY = new URL('../../../account/src/public.ts', import.meta.url);
const MANIFEST = new URL('../../../account/yena.json', import.meta.url);

type PublicEntry = {
	accountDataDirFor?: (moduleDataDir: string) => unknown;
	deniedPathsFor?: (moduleDataDir: string) => unknown;
	secretDirsFor?: (moduleDataDir: string) => unknown;
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s !== '');

/** Undefined when the account module is not installed. Installed but unloadable: an error, so the chat does not start unguarded. */
export async function loadAccountSecretPaths(moduleDataDir: string): Promise<AccountSecretPaths | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	const mod = (await import(ENTRY.href)) as PublicEntry;
	const dataDir = mod.accountDataDirFor?.(moduleDataDir);
	const secretDirs = (mod.deniedPathsFor ?? mod.secretDirsFor)?.(moduleDataDir);
	if (typeof dataDir !== 'string' || dataDir === '' || !isStringList(secretDirs)) {
		throw new Error('The account module does not say where its secrets are; the chat cannot guard them');
	}
	return {dataDir, secretDirs};
}
