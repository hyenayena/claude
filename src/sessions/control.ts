import {chmodSync, lstatSync, unlinkSync} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import type {LockKind, LockWhere} from './lock.js';

export const CONTROL_SOCKET = 'control.sock';
export const controlSocketPath = (dir: string): string => path.join(dir, CONTROL_SOCKET);

export type SessionState = 'idle' | 'running' | 'waiting-permission';

export type ControlStatus = {
	kind: LockKind;
	where: LockWhere;
	state: SessionState;
	title?: string;
	sessionId8?: string;
	startedAt: number;
	pending: number;
	queued: number;
	attached: boolean;
};

export type ControlHandlers = {
	status(): ControlStatus | Promise<ControlStatus>;
	/** Interrupts the turn, then closes the chat or aborts the ask. Not awaited by the server. */
	stop(): void | Promise<void>;
};

export type ControlServer = {
	readonly path: string;
	/** Starts closing; the socket file is unlinked before this returns. */
	close(): Promise<void>;
};

const MAX_REQUEST_BYTES = 4096;
const MAX_RESPONSE_BYTES = 64 * 1024;
const SERVER_IDLE_MS = 2000;
const DEFAULT_CLIENT_TIMEOUT_MS = 1000;
const MAX_TITLE = 200;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;

export function parseStatus(raw: unknown): ControlStatus | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (r.kind !== 'chat' && r.kind !== 'ask') return undefined;
	if (r.where !== 'local' && r.where !== 'runner') return undefined;
	if (r.state !== 'idle' && r.state !== 'running' && r.state !== 'waiting-permission') return undefined;
	if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return undefined;
	if (!isCount(r.pending) || !isCount(r.queued) || typeof r.attached !== 'boolean') return undefined;
	if (r.title !== undefined && typeof r.title !== 'string') return undefined;
	if (r.sessionId8 !== undefined && (typeof r.sessionId8 !== 'string' || !/^[0-9a-f]{8}$/i.test(r.sessionId8))) return undefined;
	return {
		kind: r.kind,
		where: r.where,
		state: r.state,
		startedAt: r.startedAt,
		pending: r.pending,
		queued: r.queued,
		attached: r.attached,
		...(r.title !== undefined && {title: r.title.slice(0, MAX_TITLE)}),
		...(r.sessionId8 !== undefined && {sessionId8: r.sessionId8}),
	};
}

// Only the holder of the lock serves the socket, so a socket file already there is a leftover.
export function removeLeftoverSocket(file: string): void {
	let st;
	try {
		st = lstatSync(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw err;
	}
	if (!st.isSocket()) throw new Error('The control socket path is not a socket');
	unlinkSync(file);
}

export async function serveControl(opts: {dir: string; handlers: ControlHandlers; log?: Logger}): Promise<ControlServer> {
	const log = opts.log ?? noopLog;
	const file = controlSocketPath(opts.dir);
	removeLeftoverSocket(file);
	const sockets = new Set<net.Socket>();

	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.setTimeout(SERVER_IDLE_MS, () => socket.destroy());
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', () => socket.destroy());
		let buf = '';
		let handled = false;
		socket.on('data', chunk => {
			if (handled) return;
			buf += chunk.toString('utf8');
			if (buf.length > MAX_REQUEST_BYTES) {
				socket.destroy();
				return;
			}
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			handled = true;
			void respond(buf.slice(0, nl), socket);
		});
	});

	const reply = (socket: net.Socket, body: Record<string, unknown>): void => {
		socket.end(JSON.stringify({v: 1, ...body}) + '\n');
	};

	const respond = async (line: string, socket: net.Socket): Promise<void> => {
		let op: unknown;
		try {
			const req = JSON.parse(line) as unknown;
			if (typeof req !== 'object' || req === null || (req as {v?: unknown}).v !== 1) throw new Error('bad frame');
			op = (req as {op?: unknown}).op;
		} catch {
			reply(socket, {ok: false, error: 'invalid request'});
			return;
		}
		try {
			if (op === 'status') {
				reply(socket, {ok: true, status: await opts.handlers.status()});
			} else if (op === 'stop') {
				reply(socket, {ok: true});
				Promise.resolve()
					.then(() => opts.handlers.stop())
					.catch((err: unknown) => log.warn('control stop failed', {err}));
			} else {
				reply(socket, {ok: false, error: 'unknown op'});
			}
		} catch (err) {
			log.warn('control request failed', {err});
			reply(socket, {ok: false, error: 'failed'});
		}
	};

	return new Promise<ControlServer>((resolve, reject) => {
		server.once('error', reject);
		server.listen(file, () => {
			server.off('error', reject);
			server.on('error', err => log.warn('control server error', {err}));
			try {
				chmodSync(file, 0o600);
			} catch (err) {
				server.close();
				reject(err);
				return;
			}
			let closing: Promise<void> | undefined;
			resolve({
				path: file,
				close: () => {
					closing ??= new Promise<void>(done => {
						server.close(() => done());
						for (const s of sockets) s.destroy();
					});
					return closing;
				},
			});
		});
	});
}

async function request(dir: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(controlSocketPath(dir));
		let buf = '';
		let settled = false;
		const finish = (err?: Error, value?: Record<string, unknown>): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (err) reject(err);
			else resolve(value!);
		};
		const timer = setTimeout(() => finish(new Error('The session did not answer in time')), timeoutMs);
		socket.on('connect', () => socket.write(JSON.stringify({v: 1, ...body}) + '\n'));
		socket.on('error', err => finish(err));
		socket.on('close', () => finish(new Error('The session closed the connection')));
		socket.on('data', chunk => {
			buf += chunk.toString('utf8');
			if (buf.length > MAX_RESPONSE_BYTES) {
				finish(new Error('The session sent too much data'));
				return;
			}
			const nl = buf.indexOf('\n');
			if (nl < 0) return;
			try {
				const res = JSON.parse(buf.slice(0, nl)) as unknown;
				if (typeof res !== 'object' || res === null || (res as {v?: unknown}).v !== 1) throw new Error('bad frame');
				finish(undefined, res as Record<string, unknown>);
			} catch {
				finish(new Error('The session sent an invalid answer'));
			}
		});
	});
}

export async function queryStatus(dir: string, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS): Promise<ControlStatus> {
	const res = await request(dir, {op: 'status'}, timeoutMs);
	const status = res.ok === true ? parseStatus(res.status) : undefined;
	if (!status) throw new Error('The session sent an invalid status');
	return status;
}

export async function requestStop(dir: string, timeoutMs = DEFAULT_CLIENT_TIMEOUT_MS): Promise<void> {
	const res = await request(dir, {op: 'stop'}, timeoutMs);
	if (res.ok !== true) throw new Error('The session refused to stop');
}
