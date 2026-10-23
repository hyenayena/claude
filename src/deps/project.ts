// The only file that reaches the project module. It is an optional dependency (not in yena.json):
// loaded at runtime, and absent means the chat has no project roots. The types are structural copies
// of the project module's public entry (src/public.ts), so claude compiles without it.
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

/**
 * Undefined when the project module is not installed. Installed but unloadable: a reader that locks
 * the whole md hub, so a broken module never leaves project docs writable.
 */
export async function loadProjectAccess(moduleDataDir: string, hubDir: string): Promise<ProjectAccessReader | undefined> {
	if (!existsSync(fileURLToPath(MANIFEST))) return undefined;
	try {
		const mod = (await import(ENTRY.href)) as {accessReader?: (dataDir: string) => unknown};
		const reader = typeof mod.accessReader === 'function' ? mod.accessReader(moduleDataDir) : undefined;
		if (isReader(reader)) return reader;
	} catch {
		// Falls through to the locking reader.
	}
	const locked: ProjectAccess = {roots: [], docs: hubDir, managed: [hubDir], writable: []};
	return {dataDir: '', read: async () => locked, readSync: () => locked};
}
