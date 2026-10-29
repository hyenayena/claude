import {constants} from 'node:fs';
import {type FileHandle, lstat, open, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import type {ChatEvent} from './events.js';

export const MAX_CALLS = 4;
export const MAX_LINES = 200;
export const MAX_BYTES = 32 * 1024;
export const MAX_LINE = 1024;
export const MAX_COMMAND = 200;
export const READ_CHUNK = 64 * 1024;
export const MAX_DIR_ENTRIES = 256;
const POLL_MS = 200;
const SLACK_MS = 2000;
const MAX_TOPS = 8;
const MAX_SLUGS = 64;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const OUTPUT = /^[A-Za-z0-9_-]{1,64}\.output$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ShellCall = {
	toolUseId: string;
	command: string;
	startedAt: number;
	lines: readonly string[];
	bytes: number;
	bound: 'file' | 'task';
};

export type ShellSnapshot = {calls: readonly ShellCall[]};

export interface ShellWatch {
	feed(event: ChatEvent): void;
	get(): ShellSnapshot;
	subscribe(cb: () => void): () => void;
	readonly totalBytes: number;
	close(): void;
}

type Tail = {
	handle?: FileHandle;
	offset: number;
	decoder: StringDecoder;
	partial: string;
	skipping: boolean;
	finished: boolean;
	busy: boolean;
};

type State = 'pending' | 'running' | 'dead';

type Entry = {
	call: ShellCall;
	state: State;
	observedAt: number;
	taskId?: string;
	tail: Tail;
};

type Listing = {dir: string; names: string[]};

export type ShellWatchOptions = {
	root: string | undefined;
	sessionId: () => string | undefined;
	scrub: (s: string) => string;
	log?: Logger;
	now?: () => number;
	pollMs?: number;
};

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const code = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;
const missing = (err: unknown): boolean => code(err) === 'ENOENT' || code(err) === 'ENOTDIR';

export function createShellWatch(opts: ShellWatchOptions): ShellWatch {
	const log = opts.log ?? noopLog;
	const now = opts.now ?? Date.now;
	const pollMs = opts.pollMs ?? POLL_MS;
	const uid = process.getuid?.();
	const entries = new Map<string, Entry>();
	const decoys = new Set<string>();
	const listeners = new Set<() => void>();
	let snapshot: ShellSnapshot = {calls: []};
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	let totalBytes = 0;
	let realRoot: Promise<string | undefined> | undefined;
	let dirsFor: string | undefined;
	let dirs: Promise<string[]> | undefined;
	let known = new Set<string>();
	let knownChain: Promise<void> = Promise.resolve();
	let polling = false;

	const publish = (): void => {
		snapshot = {calls: [...entries.values()].filter(e => e.state === 'running').map(e => e.call)};
		for (const cb of [...listeners]) {
			try {
				cb();
			} catch {
			}
		}
	};

	const getRealRoot = (): Promise<string | undefined> => {
		realRoot ??= opts.root === undefined ? Promise.resolve(undefined) : realpath(opts.root).catch(() => undefined);
		return realRoot;
	};

	const inside = (root: string, file: string): boolean => file.startsWith(root + path.sep);

	const computeDirs = async (session: string): Promise<string[]> => {
		const root = await getRealRoot();
		if (root === undefined) return [];
		const out: string[] = [];
		let tops: string[];
		try {
			tops = (await readdir(root)).filter(n => n.startsWith('claude-')).slice(0, MAX_TOPS);
		} catch {
			return [];
		}
		for (const top of tops) {
			const topPath = path.join(root, top);
			try {
				const st = await lstat(topPath);
				if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
				const slugs = (await readdir(topPath, {withFileTypes: true})).filter(d => d.isDirectory()).slice(0, MAX_SLUGS);
				for (const slug of slugs) out.push(path.join(topPath, slug.name, session, 'tasks'));
			} catch {
			}
		}
		return out;
	};

	const getDirs = (session: string, refresh = false): Promise<string[]> => {
		if (dirsFor !== session) {
			dirsFor = session;
			dirs = undefined;
			known = new Set();
		}
		if (refresh || !dirs) dirs = computeDirs(session);
		return dirs;
	};

	const currentSession = (): string | undefined => {
		const s = opts.sessionId();
		return s !== undefined && UUID.test(s) ? s : undefined;
	};

	type Overflow = {overflow: true};
	const list = async (session: string): Promise<Listing[] | Overflow> => {
		const all = await getDirs(session);
		const root = await getRealRoot();
		if (root === undefined) return [];
		const out: Listing[] = [];
		let anyExists = false;
		for (const dir of all) {
			try {
				const names = await readdir(dir);
				anyExists = true;
				if (names.length > MAX_DIR_ENTRIES) return {overflow: true};
				const real = await realpath(dir);
				if (!inside(root, real)) continue;
				out.push({dir, names});
			} catch (err) {
				if (!missing(err)) log.debug('shell dir unreadable', {code: code(err)});
			}
		}
		if (!anyExists) dirs = undefined;
		return out;
	};

	const keyOf = (dir: string, name: string): string => path.join(dir, name);

	const rememberKnown = (force: boolean): void => {
		const session = currentSession();
		if (session === undefined || opts.root === undefined) return;
		knownChain = knownChain.then(async () => {
			if (closed || (!force && (hasPending() || decoys.size > 0))) return;
			const listing = await list(session).catch(() => []);
			if (!Array.isArray(listing)) return;
			if (currentSession() !== session) return;
			for (const l of listing) for (const n of l.names) known.add(keyOf(l.dir, n));
		});
	};

	const hasPending = (): boolean => [...entries.values()].some(e => e.state === 'pending');

	const addLine = (e: Entry, raw: string): void => {
		const text = opts.scrub(raw.slice(0, MAX_LINE));
		const lines = [...e.call.lines, text];
		let bytes = e.call.bytes + Buffer.byteLength(text) + 1;
		while (lines.length > MAX_LINES || (bytes > MAX_BYTES && lines.length > 1)) {
			bytes -= Buffer.byteLength(lines.shift() as string) + 1;
		}
		e.call = {...e.call, lines, bytes};
	};

	const consume = (e: Entry, text: string): void => {
		const tail = e.tail;
		let rest = text;
		for (;;) {
			const nl = rest.indexOf('\n');
			if (nl < 0) break;
			const piece = rest.slice(0, nl).replace(/\r$/, '');
			if (!tail.skipping) addLine(e, tail.partial + piece);
			tail.partial = '';
			tail.skipping = false;
			rest = rest.slice(nl + 1);
		}
		if (!tail.skipping) {
			tail.partial += rest;
			if (tail.partial.length > MAX_LINE) {
				tail.partial = tail.partial.slice(0, MAX_LINE);
				tail.skipping = true;
			}
		}
	};

	const closeTail = (tail: Tail): void => {
		const handle = tail.handle;
		tail.handle = undefined;
		tail.finished = true;
		void handle?.close().catch(() => {});
	};

	const fail = (e: Entry, fallback: 'ambiguous' | 'nofile', errCode?: string): void => {
		closeTail(e.tail);
		e.state = 'dead';
		log.debug('shell view', {
			shown: false,
			calls: 1,
			ms: 0,
			outputBytes: 0,
			fallback,
			...(errCode !== undefined && {code: errCode}),
		});
	};

	const openFile = async (e: Entry, file: string): Promise<boolean> => {
		const root = await getRealRoot();
		if (root === undefined) return false;
		try {
			const real = await realpath(file);
			if (!inside(root, real)) throw new Error('Outside the root');
			const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
			if (!(await handle.stat()).isFile()) {
				await handle.close();
				throw new Error('Not a regular file');
			}
			if (e.state === 'dead' || closed) {
				await handle.close();
				return false;
			}
			e.tail.handle = handle;
			return true;
		} catch (err) {
			if (missing(err)) e.tail.finished = true;
			else fail(e, 'nofile', code(err));
			return false;
		}
	};

	const bind = async (e: Entry, file: string, how: 'file' | 'task'): Promise<void> => {
		e.state = 'running';
		e.call = {...e.call, startedAt: now(), bound: how};
		if (await openFile(e, file)) await readOne(e);
		publish();
	};

	const readOne = async (e: Entry): Promise<boolean> => {
		const tail = e.tail;
		if (!tail.handle || tail.finished || tail.busy) return false;
		tail.busy = true;
		const before = e.call;
		try {
			const buf = Buffer.allocUnsafe(READ_CHUNK);
			const {bytesRead} = await tail.handle.read(buf, 0, READ_CHUNK, tail.offset);
			if (bytesRead > 0 && e.state === 'running') {
				tail.offset += bytesRead;
				totalBytes += bytesRead;
				consume(e, tail.decoder.write(buf.subarray(0, bytesRead)));
			}
		} catch (err) {
			if (missing(err) || code(err) === 'EBADF') closeTail(tail);
			else fail(e, 'nofile', code(err));
		} finally {
			tail.busy = false;
		}
		return e.call !== before || e.state === 'dead';
	};

	const ambiguous = (pending: Entry[], candidates: string[]): void => {
		for (const k of candidates) known.add(k);
		for (const e of pending) fail(e, 'ambiguous');
	};

	const discover = async (session: string): Promise<boolean> => {
		const pending = [...entries.values()].filter(e => e.state === 'pending');
		if (pending.length === 0) return false;
		const listing = await list(session);
		if (!Array.isArray(listing)) {
			for (const e of pending) fail(e, 'nofile');
			return true;
		}
		const oldest = Math.min(...pending.map(e => e.observedAt)) - SLACK_MS;
		const candidates: {key: string}[] = [];
		const byName = new Map<string, string>();
		for (const l of listing) {
			for (const name of l.names) {
				const key = keyOf(l.dir, name);
				if (known.has(key) || !OUTPUT.test(name)) continue;
				try {
					const st = await lstat(key);
					if (!st.isFile() || (uid !== undefined && st.uid !== uid) || st.mtimeMs < oldest || st.ctimeMs < oldest) {
						known.add(key);
						continue;
					}
				} catch {
					continue;
				}
				candidates.push({key});
				byName.set(name.slice(0, -'.output'.length), key);
			}
		}
		if (candidates.length === 0) return false;
		for (const e of pending) {
			const key = e.taskId !== undefined ? byName.get(e.taskId) : undefined;
			if (key !== undefined && candidates.some(c => c.key === key)) {
				known.add(key);
				await bind(e, key, 'task');
				const rest = pending.filter(p => p.state === 'pending');
				const left = candidates.map(c => c.key).filter(k => k !== key);
				if (rest.length > 0 && left.length > 0) ambiguous(rest, left);
				return true;
			}
		}
		const current = pending.filter(e => e.state === 'pending');
		if (candidates.length === 1 && current.length === 1 && decoys.size === 0) {
			const key = candidates[0]!.key;
			known.add(key);
			await bind(current[0]!, key, 'file');
		} else {
			ambiguous(current, candidates.map(c => c.key));
		}
		return true;
	};

	const poll = async (): Promise<void> => {
		if (polling || closed) return;
		polling = true;
		try {
			await knownChain;
			let changed = false;
			const session = currentSession();
			if (session !== undefined && hasPending()) changed = (await discover(session).catch(() => false)) || changed;
			for (const e of [...entries.values()]) {
				if (e.state === 'running') changed = (await readOne(e)) || changed;
			}
			if (changed && !closed) publish();
			if (![...entries.values()].some(e => e.state === 'pending' || (e.state === 'running' && !e.tail.finished))) stopTimer();
		} finally {
			polling = false;
		}
	};

	const ensureTimer = (): void => {
		if (timer || closed) return;
		timer = setInterval(() => void poll(), pollMs);
		timer.unref();
	};

	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const idleCheck = (): void => {
		if (entries.size === 0 && decoys.size === 0) stopTimer();
		if (!hasPending() && decoys.size === 0) rememberKnown(false);
	};

	const end = (id: string): boolean => {
		const wasDecoy = decoys.delete(id);
		const e = entries.get(id);
		if (e) {
			closeTail(e.tail);
			entries.delete(id);
		}
		idleCheck();
		return e?.state === 'running' || wasDecoy;
	};

	const endAll = (): void => {
		let shown = false;
		for (const e of entries.values()) {
			if (e.state === 'running') shown = true;
			closeTail(e.tail);
		}
		entries.clear();
		decoys.clear();
		stopTimer();
		rememberKnown(false);
		if (shown) publish();
	};

	const start = (toolUseId: string, input: unknown): void => {
		if (opts.root === undefined || currentSession() === undefined) return;
		const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
		if (rec['run_in_background'] === true || entries.size >= MAX_CALLS) {
			decoys.add(toolUseId);
			return;
		}
		if (entries.has(toolUseId)) return;
		const command = typeof rec['command'] === 'string' ? rec['command'] : '';
		if (entries.size === 0 && decoys.size === 0) rememberKnown(true);
		entries.set(toolUseId, {
			call: {
				toolUseId,
				command: oneLine(opts.scrub(command)).slice(0, MAX_COMMAND),
				startedAt: 0,
				lines: [],
				bytes: 0,
				bound: 'file',
			},
			state: 'pending',
			observedAt: now(),
			tail: {offset: 0, decoder: new StringDecoder('utf8'), partial: '', skipping: false, finished: false, busy: false},
		});
		ensureTimer();
	};

	const feed = (event: ChatEvent): void => {
		if (closed) return;
		if (event.type === 'turn-end' || (event.type === 'state' && event.state !== 'running')) {
			endAll();
			return;
		}
		if (event.type !== 'ui') return;
		const ev = event.event;
		if (ev.kind === 'tool-use') {
			if (ev.name === 'Bash') start(ev.toolUseId, ev.input);
		} else if (ev.kind === 'tool-result') {
			if (end(ev.toolUseId)) publish();
		} else if (ev.kind === 'task' && ev.toolUseId !== undefined && ev.taskType === 'local_bash') {
			const e = entries.get(ev.toolUseId);
			if (e && e.state === 'pending' && ev.status === 'running' && ev.background !== true && ID.test(ev.id)) e.taskId = ev.id;
		}
	};

	return {
		feed,
		get: () => snapshot,
		subscribe(cb) {
			listeners.add(cb);
			return () => void listeners.delete(cb);
		},
		get totalBytes() {
			return totalBytes;
		},
		close() {
			if (closed) return;
			endAll();
			closed = true;
			stopTimer();
			listeners.clear();
		},
	};
}
