import {lstatSync, mkdirSync} from 'node:fs';
import path from 'node:path';

export const shellTmpRoot = (uid: number, base = '/tmp'): string => path.join(base, `yena-claude-${uid}`);

export const cliTmpOf = (shellRoot: string, uid: number): string => path.join(shellRoot, `claude-${uid}`);

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

export const sessionDirOf = (shellRoot: string): string => path.join(shellRoot, 'session');

export function ensureSessionDir(opts: {uid?: number; base?: string} = {}): string {
	const uid = opts.uid ?? process.getuid?.();
	if (uid === undefined) throw new Error('No user id available');
	const root = ensureShellTmp({uid, ...(opts.base !== undefined && {base: opts.base})});
	return ensurePrivateDir(sessionDirOf(root), uid, 'Session directory');
}
