import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Reader of the project module's state file (<YENA_DATA>/project/state.json, format v1, owned by
 * that module). Projects in the workplace, their stages and their docs in the md hub are readable;
 * only the isolated projects of the work session are writable. Anything unexpected fails closed.
 */
export type ProjectAccess = {
	/** Extra readable roots: the workplace and the stage dir. */
	roots: string[];
	/** The hub's projects dir, <hub>/projects: docs of every project. */
	docs: string;
	/** Folders under which writes are judged by isolation (roots plus docs). */
	managed: string[];
	/** The isolated projects' folders, docs folders and stages. */
	writable: string[];
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isName = (v: unknown): v is string => typeof v === 'string' && NAME_RE.test(v) && v !== '.' && v !== '..';
const isRoot = (v: unknown): v is string =>
	typeof v === 'string' && path.isAbsolute(v) && path.normalize(v) === v && v !== '/' && !v.includes('\0');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const projectStateFile = (hubDir: string): string => path.join(path.dirname(hubDir), 'project', 'state.json');

/** Nothing readable in the workplace, and the hub's projects dir closed for writes. */
const locked = (hubDir: string): ProjectAccess => {
	const docs = path.join(hubDir, 'projects');
	return {roots: [], docs, managed: [docs], writable: []};
};

/** Anything that is not a valid v1 state locks every project. */
export function parseProjectState(text: string, hubDir: string): ProjectAccess {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return locked(hubDir);
	}
	if (!isRecord(raw) || raw.v !== 1 || !isRoot(raw.workplace) || !isRoot(raw.stage)) return locked(hubDir);
	const {workplace, stage} = raw;
	// Docs always live in this hub, whatever the file says.
	const md = path.join(hubDir, 'projects');
	const access: ProjectAccess = {roots: [workplace, stage], docs: md, managed: [workplace, stage, md], writable: []};
	const session = raw.session ?? null;
	if (session === null) return access;
	if (!isRecord(session) || !Array.isArray(session.isolated) || !Array.isArray(session.stages)) return locked(hubDir);
	if (!session.isolated.every(isName)) return locked(hubDir);
	const isolated = new Set(session.isolated as string[]);
	for (const name of isolated) access.writable.push(path.join(workplace, name), path.join(md, name));
	for (const s of session.stages as unknown[]) {
		if (!isRecord(s) || !isName(s.project) || typeof s.path !== 'string') return locked(hubDir);
		// Only a direct child of the stage dir named after its project counts.
		if (path.dirname(s.path) !== stage || !path.basename(s.path).startsWith(`${s.project}-stage-`)) return locked(hubDir);
		if (isolated.has(s.project)) access.writable.push(s.path);
	}
	return access;
}

// No file means no project module: nothing is managed. Any other read error locks every project.
const onReadError = (error: unknown, hubDir: string): ProjectAccess | undefined =>
	(error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : locked(hubDir);

export async function readProjectAccess(file: string, hubDir: string): Promise<ProjectAccess | undefined> {
	try {
		return parseProjectState(await readFile(file, 'utf8'), hubDir);
	} catch (error) {
		return onReadError(error, hubDir);
	}
}

export function readProjectAccessSync(file: string, hubDir: string): ProjectAccess | undefined {
	try {
		return parseProjectState(readFileSync(file, 'utf8'), hubDir);
	} catch (error) {
		return onReadError(error, hubDir);
	}
}
