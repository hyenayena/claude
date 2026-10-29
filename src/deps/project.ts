import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export type ProjectAccess = {
	roots: string[];
	docs: string;
	managed: string[];
	writable: string[];
};

export type ProjectAccessReader = {
	dataDir: string;
	read(): Promise<ProjectAccess | undefined>;
	readSync(): ProjectAccess | undefined;
};

const ENTRY = new URL('../../../project/src/public.ts', import.meta.url);
const MANIFEST = new URL('../../../project/yena.json', import.meta.url);

const isReader = (v: unknown): v is ProjectAccessReader => {
	const r = v as Partial<ProjectAccessReader> | null;
	return typeof r?.dataDir === 'string' && typeof r.read === 'function' && typeof r.readSync === 'function';
};

export async function loadProjectAccess(moduleDataDir: string, hubDir: string): Promise<ProjectAccessReader | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	try {
		const mod = (await import(ENTRY.href)) as {accessReader?: (dataDir: string) => unknown};
		const reader = typeof mod.accessReader === 'function' ? mod.accessReader(moduleDataDir) : undefined;
		if (isReader(reader)) return reader;
	} catch {
	}
	const locked: ProjectAccess = {roots: [], docs: hubDir, managed: [hubDir], writable: []};
	return {dataDir: '', read: async () => locked, readSync: () => locked};
}
