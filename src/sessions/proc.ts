import {readFileSync} from 'node:fs';

export function procStart(pid: number, procRoot = '/proc'): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
		const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
		const start = rest[19];
		return start && /^\d+$/.test(start) ? start : undefined;
	} catch {
		return undefined;
	}
}

export function procCmdline(pid: number, procRoot = '/proc'): string[] | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		return readFileSync(`${procRoot}/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
	} catch {
		return undefined;
	}
}

export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM';
	}
}
