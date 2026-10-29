import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type AccountSecretPaths = {
	dataDir: string;
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
