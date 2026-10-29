import {randomBytes} from 'node:crypto';
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import {pidAlive, procStart} from './proc.js';

export type LockKind = 'chat' | 'ask';
export type LockWhere = 'local' | 'runner';

export type LockInfo = {
	v: 1;
	pid: number;
	procStart: string;
	kind: LockKind;
	where: LockWhere;
	sessionId?: string;
	startedAt: number;
	socket?: string;
};

export const LOCK_FILE = 'session.lock';
const MAX_LOCK_BYTES = 4096;
const UNPARSEABLE_STALE_MS = 5000;

export const lockPath = (dir: string): string => path.join(dir, LOCK_FILE);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLock(text: string): LockInfo | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.v !== 1) return undefined;
	if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return undefined;
	if (typeof r.procStart !== 'string' || !/^\d{1,20}$/.test(r.procStart)) return undefined;
	if (r.kind !== 'chat' && r.kind !== 'ask') return undefined;
	if (r.where !== 'local' && r.where !== 'runner') return undefined;
	if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return undefined;
	if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !UUID.test(r.sessionId))) return undefined;
	if (r.socket !== undefined && (typeof r.socket !== 'string' || r.socket.length > 512 || r.socket.includes('\0'))) return undefined;
	return {
		v: 1,
		pid: r.pid,
		procStart: r.procStart,
		kind: r.kind,
		where: r.where,
		startedAt: r.startedAt,
		...(r.sessionId !== undefined && {sessionId: r.sessionId}),
		...(r.socket !== undefined && {socket: r.socket}),
	};
}

type Read = {bytes: Buffer; ino: number; mtimeMs: number};

function readLockFile(file: string): Read | undefined {
	let fd: number;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return undefined;
		if (code === 'ELOOP') throw new Error('The session lock is a symbolic link');
		throw err;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error('The session lock is not a regular file');
		const buf = Buffer.alloc(MAX_LOCK_BYTES + 1);
		const n = readSync(fd, buf, 0, buf.length, 0);
		return {bytes: buf.subarray(0, Math.min(n, MAX_LOCK_BYTES + 1)), ino: st.ino, mtimeMs: st.mtimeMs};
	} finally {
		closeSync(fd);
	}
}

export type LockState =
	| {state: 'none'}
	| {state: 'held'; info?: LockInfo; read: Read}
	| {state: 'stale'; info?: LockInfo; read: Read};

export type LockDeps = {
	now?: () => number;
	alive?: (pid: number) => boolean;
	procStartOf?: (pid: number) => string | undefined;
};

export function inspectLock(dir: string, deps: LockDeps = {}): LockState {
	const read = readLockFile(lockPath(dir));
	if (!read) return {state: 'none'};
	const now = deps.now ?? Date.now;
	const alive = deps.alive ?? pidAlive;
	const startOf = deps.procStartOf ?? procStart;
	if (read.bytes.length > MAX_LOCK_BYTES) return {state: 'stale', read};
	const text = read.bytes.toString('utf8');
	const info = parseLock(text);
	if (!info) {
		let json = true;
		try {
			JSON.parse(text);
		} catch {
			json = false;
		}
		const young = !json && now() - read.mtimeMs < UNPARSEABLE_STALE_MS;
		return young ? {state: 'held', read} : {state: 'stale', read};
	}
	if (!alive(info.pid)) return {state: 'stale', info, read};
	if (startOf(info.pid) !== info.procStart) return {state: 'stale', info, read};
	return {state: 'held', info, read};
}

function removeIfUnchanged(dir: string, read: Read): boolean {
	const file = lockPath(dir);
	let again: Read | undefined;
	try {
		again = readLockFile(file);
	} catch {
		return false;
	}
	if (!again || again.ino !== read.ino || !again.bytes.equals(read.bytes)) return false;
	try {
		unlinkSync(file);
		return true;
	} catch {
		return false;
	}
}

export type SessionLock = {
	readonly info: LockInfo;
	update(patch: {sessionId?: string; socket?: string}): void;
	release(): void;
};

export type AcquireResult = {ok: true; lock: SessionLock} | {ok: false; holder?: LockInfo; unknown?: true};

export type AcquireOptions = LockDeps & {
	dir: string;
	kind: LockKind;
	where: LockWhere;
	sessionId?: string;
	socket?: string;
	pid?: number;
	log?: Logger;
};

const same = (a: LockInfo, b: LockInfo): boolean => a.pid === b.pid && a.procStart === b.procStart && a.startedAt === b.startedAt;

export function acquireLock(opts: AcquireOptions): AcquireResult {
	const log = opts.log ?? noopLog;
	const file = lockPath(opts.dir);
	const pid = opts.pid ?? process.pid;
	const start = (opts.procStartOf ?? procStart)(pid);
	if (!start) throw new Error('Cannot read the process start time');
	let info: LockInfo = {
		v: 1,
		pid,
		procStart: start,
		kind: opts.kind,
		where: opts.where,
		startedAt: (opts.now ?? Date.now)(),
		...(opts.sessionId !== undefined && {sessionId: opts.sessionId}),
		...(opts.socket !== undefined && {socket: opts.socket}),
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		let fd: number | undefined;
		try {
			fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
		}
		if (fd !== undefined) {
			try {
				writeSync(fd, JSON.stringify(info));
			} catch (err) {
				closeSync(fd);
				try {
					unlinkSync(file);
				} catch {
				}
				throw err;
			}
			closeSync(fd);
			log.info('session lock', {action: 'acquired', kind: info.kind, where: info.where});
			let released = false;
			const lock: SessionLock = {
				get info() {
					return info;
				},
				update: patch => {
					if (released) return;
					let current: Read | undefined;
					try {
						current = readLockFile(file);
					} catch {
						return;
					}
					const parsed = current && parseLock(current.bytes.toString('utf8'));
					if (!parsed || !same(parsed, info)) return;
					const next: LockInfo = {...info, ...patch};
					const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
					try {
						writeFileSync(tmp, JSON.stringify(next), {flag: 'wx', mode: 0o600});
						renameSync(tmp, file);
						info = next;
					} catch {
						try {
							unlinkSync(tmp);
						} catch {
						}
					}
				},
				release: () => {
					if (released) return;
					released = true;
					let current: Read | undefined;
					try {
						current = readLockFile(file);
					} catch {
						return;
					}
					const parsed = current && parseLock(current.bytes.toString('utf8'));
					if (!parsed || !same(parsed, info)) return;
					try {
						unlinkSync(file);
						log.info('session lock', {action: 'released', kind: info.kind, where: info.where});
					} catch {
					}
				},
			};
			return {ok: true, lock};
		}

		const seen = inspectLock(opts.dir, opts);
		if (seen.state === 'none') continue;
		if (seen.state === 'held') return seen.info ? {ok: false, holder: seen.info} : {ok: false, unknown: true};
		if (removeIfUnchanged(opts.dir, seen.read)) {
			log.info('session lock', {action: 'stale-removed', kind: seen.info?.kind, where: seen.info?.where});
		}
	}
	const last = inspectLock(opts.dir, opts);
	if (last.state === 'held' && last.info) return {ok: false, holder: last.info};
	return {ok: false, unknown: true};
}

export function readHolder(dir: string, deps: LockDeps = {}): {holder?: LockInfo; stale?: LockInfo; unknown?: true} {
	const seen = inspectLock(dir, deps);
	if (seen.state === 'none') return {};
	if (seen.state === 'held') return seen.info ? {holder: seen.info} : {unknown: true};
	return seen.info ? {stale: seen.info} : {};
}

export const isSessionId = (value: string): boolean => UUID.test(value);
