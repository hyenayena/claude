import {randomBytes} from 'node:crypto';
import {lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import {errClass} from '../log.js';
import {pidAlive, procStart} from '../sessions/proc.js';
import {ensurePrivateDir} from './shell-tmp.js';

export const SCRATCH_DIR = 'scratch';
export const SCRATCH_ID = /^[0-9a-f]{8}$/;
export const SCRATCH_ORPHAN_MS = 60 * 60 * 1000;
const OWNER_MAX_BYTES = 256;
const OWNER_SUFFIX = '.owner';
const ID_TRIES = 5;

export const scratchParentOf = (sessionTmp: string): string => path.join(sessionTmp, SCRATCH_DIR);

export type ScratchDeps = {
	alive?: (pid: number) => boolean;
	procStartOf?: (pid: number) => string | undefined;
	now?: () => number;
	pid?: number;
	randomId?: () => string;
};

type Owner = {pid: number; procStart: string | undefined};

const selfRooted = (parent: string): boolean => {
	try {
		return lstatSync(parent).isDirectory() && realpathSync(parent) === path.resolve(parent);
	} catch {
		return false;
	}
};

function readOwner(file: string): Owner | undefined {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > OWNER_MAX_BYTES) return undefined;
		const data = JSON.parse(readFileSync(file, 'utf8')) as {v?: unknown; pid?: unknown; procStart?: unknown};
		if (data.v !== 1 || typeof data.pid !== 'number' || !Number.isInteger(data.pid)) return undefined;
		return {pid: data.pid, procStart: typeof data.procStart === 'string' ? data.procStart : undefined};
	} catch {
		return undefined;
	}
}

function removeEntry(parent: string, id: string): void {
	const dir = path.join(parent, id);
	try {
		const st = lstatSync(dir);
		if (st.isSymbolicLink() || !st.isDirectory()) unlinkSync(dir);
		else rmSync(dir, {recursive: true, force: true});
	} catch {}
	try {
		unlinkSync(path.join(parent, id + OWNER_SUFFIX));
	} catch {}
}

export function sweepScratch(parent: string, deps: ScratchDeps = {}): number {
	if (!selfRooted(parent)) return 0;
	const alive = deps.alive ?? pidAlive;
	const startOf = deps.procStartOf ?? procStart;
	const now = (deps.now ?? Date.now)();
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch {
		return 0;
	}
	const ids = new Set<string>();
	for (const name of names) {
		const id = name.endsWith(OWNER_SUFFIX) ? name.slice(0, -OWNER_SUFFIX.length) : name;
		if (SCRATCH_ID.test(id)) ids.add(id);
	}
	let removed = 0;
	for (const id of ids) {
		const owner = readOwner(path.join(parent, id + OWNER_SUFFIX));
		let stale: boolean;
		if (owner) {
			const current = alive(owner.pid) ? startOf(owner.pid) : undefined;
			stale = !alive(owner.pid) || (current !== undefined && current !== owner.procStart);
		} else {
			let mtime: number;
			try {
				mtime = lstatSync(path.join(parent, id)).mtimeMs;
			} catch {
				try {
					mtime = lstatSync(path.join(parent, id + OWNER_SUFFIX)).mtimeMs;
				} catch {
					continue;
				}
			}
			stale = now - mtime > SCRATCH_ORPHAN_MS;
		}
		if (!stale) continue;
		removeEntry(parent, id);
		removed += 1;
	}
	return removed;
}

export type Scratch = {dir: string; remove(): void};

export function createScratch(opts: {sessionTmp: string; uid: number; log: Logger} & ScratchDeps): Scratch | undefined {
	const {sessionTmp, uid, log} = opts;
	const parent = scratchParentOf(sessionTmp);
	try {
		mkdirSync(sessionTmp, {recursive: true, mode: 0o700});
		ensurePrivateDir(parent, uid, 'Scratch');
		if (!selfRooted(parent)) throw new Error('Scratch folder is not a plain directory');
		const swept = sweepScratch(parent, opts);
		if (swept > 0) log.info('scratch swept', {removed: swept});
		const pid = opts.pid ?? process.pid;
		const startOf = opts.procStartOf ?? procStart;
		const randomId = opts.randomId ?? (() => randomBytes(4).toString('hex'));
		let id: string | undefined;
		for (let i = 0; i < ID_TRIES && id === undefined; i++) {
			const candidate = randomId();
			try {
				writeFileSync(path.join(parent, candidate + OWNER_SUFFIX), JSON.stringify({v: 1, pid, procStart: startOf(pid)}), {
					flag: 'wx',
					mode: 0o600,
				});
				id = candidate;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			}
		}
		if (id === undefined) throw new Error('No free scratch id');
		const dir = path.join(parent, id);
		try {
			ensurePrivateDir(dir, uid, 'Scratch');
		} catch (err) {
			removeEntry(parent, id);
			throw err;
		}
		return {
			dir,
			remove() {
				if (!selfRooted(parent)) return;
				removeEntry(parent, id);
			},
		};
	} catch (err) {
		log.warn('scratch unavailable', {error: errClass(err)});
		return undefined;
	}
}
