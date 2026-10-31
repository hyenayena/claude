import * as defaultFs from 'node:fs/promises';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';

export type LeftoverKind = 'cc-writes' | 'mcp-json' | 'config-lock';
export type LeftoverFs = Pick<typeof import('node:fs/promises'), 'lstat' | 'readdir' | 'rmdir' | 'unlink'>;

const KIND_ORDER: readonly LeftoverKind[] = ['cc-writes', 'mcp-json', 'config-lock'];

async function quiet<T>(step: () => Promise<T>): Promise<T | undefined> {
	try {
		return await step();
	} catch {
		return undefined;
	}
}

async function isEmptyDir(fs: LeftoverFs, p: string): Promise<boolean> {
	const st = await quiet(() => fs.lstat(p));
	if (!st?.isDirectory()) return false;
	const entries = await quiet(() => fs.readdir(p));
	return entries !== undefined && entries.length === 0;
}

async function removeDir(fs: LeftoverFs, p: string): Promise<boolean> {
	return (await quiet(async () => (await fs.rmdir(p), true))) ?? false;
}

async function removeFile(fs: LeftoverFs, p: string): Promise<boolean> {
	return (await quiet(async () => (await fs.unlink(p), true))) ?? false;
}

async function repoGitDir(fs: LeftoverFs, dir: string): Promise<string | undefined> {
	let at = dir;
	for (;;) {
		const git = path.join(at, '.git');
		const st = await quiet(() => fs.lstat(git));
		if (st) return st.isDirectory() ? git : undefined;
		const up = path.dirname(at);
		if (up === at) return undefined;
		at = up;
	}
}

export async function sweepPlaceholders(
	dirs: readonly string[],
	fs: LeftoverFs = defaultFs,
): Promise<{removed: number; kinds: LeftoverKind[]}> {
	let removed = 0;
	const found = new Set<LeftoverKind>();
	const hit = (kind: LeftoverKind) => {
		removed++;
		found.add(kind);
	};
	const gitDirs = new Set<string>();
	for (const dir of new Set(dirs.map(d => path.resolve(d)))) {
		const claudeDir = path.join(dir, '.claude');
		const ccWrites = path.join(claudeDir, '.cc-writes');
		if ((await isEmptyDir(fs, ccWrites)) && (await removeDir(fs, ccWrites))) {
			hit('cc-writes');
			if ((await isEmptyDir(fs, claudeDir)) && (await removeDir(fs, claudeDir))) removed++;
		}
		const mcp = path.join(dir, '.mcp.json');
		const mcpSt = await quiet(() => fs.lstat(mcp));
		if (mcpSt?.isFile() && mcpSt.size === 0 && (await removeFile(fs, mcp))) hit('mcp-json');
		const git = await repoGitDir(fs, dir);
		if (git !== undefined) gitDirs.add(git);
	}
	for (const git of gitDirs) {
		const lock = path.join(git, 'config.lock');
		const st = await quiet(() => fs.lstat(lock));
		// A real git lock is written with 0644; the sandbox's placeholder is read-only.
		if (st?.isFile() && st.size === 0 && (st.mode & 0o222) === 0 && (await removeFile(fs, lock))) hit('config-lock');
	}
	return {removed, kinds: KIND_ORDER.filter(k => found.has(k))};
}

export type BashTracker = {
	begin(id: string): void;
	end(id: string, cwd?: string): Promise<void>;
};

export type LeftoverSweeper = BashTracker & {
	sweep(extra?: readonly string[]): Promise<void>;
};

const STALE_MS = 15 * 60 * 1000;

export function createLeftoverSweeper(o: {
	dirs: () => readonly string[];
	log: Logger;
	fs?: LeftoverFs;
	now?: () => number;
	staleMs?: number;
}): LeftoverSweeper {
	const now = o.now ?? Date.now;
	const staleMs = o.staleMs ?? STALE_MS;
	const inflight = new Map<string, number>();
	const pendingCwds = new Set<string>();

	const sweep = async (extra: readonly string[] = []): Promise<void> => {
		try {
			const {removed, kinds} = await sweepPlaceholders([...extra, ...o.dirs()], o.fs);
			if (removed > 0) o.log.info('sandbox leftovers removed', {removed, kinds});
		} catch {
			// the sweep is best-effort cleanup and must never fail a tool call
		}
	};

	return {
		begin(id) {
			inflight.set(id, now());
		},
		async end(id, cwd) {
			inflight.delete(id);
			if (cwd !== undefined) pendingCwds.add(cwd);
			const cutoff = now() - staleMs;
			for (const [key, started] of inflight) if (started < cutoff) inflight.delete(key);
			// A running sandboxed command still needs its placeholders; sweep only when none is in flight.
			if (inflight.size > 0) return;
			const extra = [...pendingCwds];
			pendingCwds.clear();
			await sweep(extra);
		},
		sweep,
	};
}
