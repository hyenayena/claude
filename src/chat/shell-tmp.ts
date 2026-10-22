import {lstatSync, mkdirSync} from 'node:fs';
import path from 'node:path';

// Claude Code writes the output of a running shell command below CLAUDE_CODE_TMPDIR; a private
// root we own keeps that output unreadable by other users and gives the watcher a known place.
export const shellTmpRoot = (uid: number, base = '/tmp'): string => path.join(base, `yena-claude-${uid}`);

/** Creates `dir` (mode 0700) or checks an existing one: a real directory, ours, closed to others. */
export function ensurePrivateDir(dir: string, uid: number, label = 'Directory'): string {
	try {
		mkdirSync(dir, {mode: 0o700});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
	}
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error(`${label} is not a directory`);
	if (st.uid !== uid) throw new Error(`${label} is owned by another user`);
	if ((st.mode & 0o077) !== 0) throw new Error(`${label} is accessible to others`);
	return dir;
}

export function ensureShellTmp(opts: {uid?: number; base?: string} = {}): string {
	const uid = opts.uid ?? process.getuid?.();
	if (uid === undefined) throw new Error('No user id available');
	return ensurePrivateDir(shellTmpRoot(uid, opts.base), uid, 'Shell tmp');
}

/** Lock file and control socket of the running session live here, below the shell tmp root. */
export function ensureSessionDir(opts: {uid?: number; base?: string} = {}): string {
	const uid = opts.uid ?? process.getuid?.();
	if (uid === undefined) throw new Error('No user id available');
	const root = ensureShellTmp({uid, ...(opts.base !== undefined && {base: opts.base})});
	return ensurePrivateDir(path.join(root, 'session'), uid, 'Session directory');
}
