import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type AccountSecretPaths = {
	dataDir: string;
	secretDirs: string[];
};

export type RetiredCredentials = {at: string; logins: number; tokens: number};

const ENTRY = new URL('../../../account/src/public.ts', import.meta.url);
const MANIFEST = new URL('../../../account/yena.json', import.meta.url);

type PublicEntry = {
	accountDataDirFor?: (moduleDataDir: string) => unknown;
	deniedPathsFor?: (moduleDataDir: string) => unknown;
	secretDirsFor?: (moduleDataDir: string) => unknown;
	retiredCredentialsFor?: (moduleDataDir: string) => unknown;
};

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(s => typeof s === 'string' && s !== '');

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

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

export async function loadRetiredCredentials(moduleDataDir: string): Promise<RetiredCredentials | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	const mod = (await import(ENTRY.href)) as PublicEntry;
	const r = mod.retiredCredentialsFor?.(moduleDataDir);
	if (typeof r !== 'object' || r === null) return undefined;
	const {at, logins, tokens} = r as Record<string, unknown>;
	if (typeof at !== 'string' || at === '' || at.length > 40 || !isCount(logins) || !isCount(tokens)) return undefined;
	return {at, logins, tokens};
}
