import {lstatSync, mkdirSync} from 'node:fs';
import path from 'node:path';

// Claude Code writes the output of a running shell command below CLAUDE_CODE_TMPDIR; a private
// root we own keeps that output unreadable by other users and gives the watcher a known place.
export const shellTmpRoot = (uid: number, base = '/tmp'): string => path.join(base, `yena-claude-${uid}`);

export function ensureShellTmp(opts: {uid?: number; base?: string} = {}): string {
	const uid = opts.uid ?? process.getuid?.();
	if (uid === undefined) throw new Error('No user id available');
	const dir = shellTmpRoot(uid, opts.base);
	try {
		mkdirSync(dir, {mode: 0o700});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
	}
	const st = lstatSync(dir);
	if (!st.isDirectory()) throw new Error('Shell tmp is not a directory');
	if (st.uid !== uid) throw new Error('Shell tmp is owned by another user');
	if ((st.mode & 0o077) !== 0) throw new Error('Shell tmp is accessible to others');
	return dir;
}
