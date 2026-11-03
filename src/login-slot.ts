import {randomBytes} from 'node:crypto';
import {lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const FILE_MAX = 1024 * 1024;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const loginCredentialsFile = (configDir: string): string => path.join(configDir, '.credentials.json');
export const claudeJsonFile = (configDir: string): string => path.join(configDir, '.claude.json');

export function writeAtomic(file: string, data: string): void {
	mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
	const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
	try {
		writeFileSync(tmp, data, {flag: 'wx', mode: 0o600});
		renameSync(tmp, file);
	} catch (err) {
		rmSync(tmp, {force: true});
		throw err;
	}
}

export function readJson(file: string): unknown {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size === 0 || st.size > FILE_MAX) return undefined;
		return JSON.parse(readFileSync(file, 'utf8')) as unknown;
	} catch {
		return undefined;
	}
}

// Claude Code's login stays Claude Code's: only its presence is checked, the file is never opened.
export function loginPresent(configDir: string): boolean {
	try {
		const st = lstatSync(loginCredentialsFile(configDir));
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}
