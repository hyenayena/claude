import {randomUUID} from 'node:crypto';
import {chmodSync} from 'node:fs';
import net from 'node:net';
import type {CommandBridge, CommandConfirmRequest, CommandInfo, CommandRunResult, Logger} from '../../../../src/api.js';
import type {LivePatch} from '../chat-prefs.js';
import type {ChatSession} from '../chat/chat-session.js';
import type {ChatEvent} from '../chat/events.js';
import type {EngineIo, EngineOpen} from '../chat/engine.js';
import {clip, errClass} from '../log.js';
import {removeLeftoverSocket, type ControlStatus} from '../sessions/control.js';
import type {ClaudeState} from '../types.js';
import {
	createDecoder,
	encodeFrame,
	ProtocolError,
	type ClientFrame,
	type Frame,
	type RunnerFrame,
	type Snapshot,
	type StatePatch,
} from './protocol.js';
import {accepts, runnerSocketPath} from './spawn.js';

export const NO_ATTACH_MS = 10_000;
// Bound for a detached runner that keeps an unsent queue after a failed turn, waiting for the user.
export const LINGER_MS = 30 * 60_000;
// After a background task ends Claude Code usually starts a turn to read its notification; a detached
// runner waits this long for it before it decides nothing is left.
export const TASK_SETTLE_MS = 5000;
const LOG_RING = 200;
const MAX_CLIENTS = 8;
const HELLO_MS = 5000;
const FLUSH_WAIT_MS = 3000;
const CLOSE_WAIT_MS = 300;
const BRIDGE_SLACK_MS = 10_000;
const DEFAULT_BRIDGE_TIMEOUT_MS = 60_000;
const MAX_REDACTORS = 64;

export type RunnerSession = Pick<
	ChatSession,
	| 'state'
	| 'sessionId'
	| 'model'
	| 'mode'
	| 'needsNewSession'
	| 'title'
	| 'pendingPermissions'
	| 'tasks'
	| 'commands'
	| 'rateLimit'
	| 'costUsd'
	| 'subscribe'
	| 'send'
	| 'interrupt'
	| 'setMode'
	| 'answerPermission'
	| 'reset'
	| 'close'
	| 'forget'
	| 'setTitle'
	| 'stopTask'
	| 'backgroundTasks'
	| 'mcpStatus'
	| 'reconnectMcp'
	| 'rewindFiles'
>;

export type RunnerEngine = {
	session: RunnerSession;
	applyLive: (patch: LivePatch) => void;
	close: () => void;
	flush: () => Promise<void>;
};

export type RunnerExit = {reason: string; turns: number; ms: number};

export type RunnerOptions = {
	/** Session directory: `runner.sock` and `control.sock` live here. */
	dir: string;
	/**
	 * Builds the engine for the first attach; `log` is the runner's logger (frames to the client, ring
	 * while detached); `control` answers "claude stop" and status while a turn holds the session lock.
	 */
	createEngine: (open: EngineOpen, io: EngineIo, log: Logger, control: RunnerControl) => Promise<RunnerEngine>;
	store: {update: (patch: Partial<ClaudeState>) => Promise<unknown>};
	/** Local sink for the runner's records (the runner itself has no log file). */
	log?: Logger;
	noAttachMs?: number;
	lingerMs?: number;
	taskSettleMs?: number;
	now?: () => number;
};

export type RunnerControl = {status: () => ControlStatus; stop: () => void};

export type RunnerHandle = {
	readonly socketPath: string;
	readonly done: Promise<RunnerExit>;
	stop: (reason?: string) => Promise<RunnerExit>;
};

type Body<F> = F extends unknown ? Omit<F, 'v'> : never;
type Conn = {socket: net.Socket; role?: 'attach' | 'control'; chain: Promise<void>; helloTimer?: NodeJS.Timeout};

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => {
		const t = setTimeout(resolve, ms);
		t.unref();
	});

const STATE_KEYS = ['lastSessionId', 'lastModel', 'allowedCommands'] as const;

const toStatePatch = (patch: Partial<ClaudeState>): StatePatch => {
	const out: StatePatch = {};
	for (const k of STATE_KEYS) {
		const v = patch[k];
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
};

const policyFor = (list: CommandInfo[], line: string): {request: CommandConfirmRequest; policy: string} | undefined => {
	const [first, second] = line.trim().split(/\s+/);
	const cmd = list.find(c => c.name === first);
	if (!cmd) return undefined;
	const sub = second === undefined ? undefined : cmd.subcommands.find(s => s.name === second || s.aliases.includes(second));
	return {
		policy: sub?.policy ?? cmd.policy,
		request: {line, command: cmd.name, ...(sub && {subcommand: sub.name}), caller: ''},
	};
};

/**
 * Serves one chat to at most one attached client, outliving the client when it asked for that.
 * Resolves `done` once everything is released; it never touches the process itself.
 */
export async function runRunner(opts: RunnerOptions): Promise<RunnerHandle> {
	const now = opts.now ?? Date.now;
	const startedAt = now();
	const socketPath = runnerSocketPath(opts.dir);

	let client: Conn | undefined;
	let engine: RunnerEngine | undefined;
	let opening = false;
	let keep = false;
	let closing: Promise<RunnerExit> | undefined;
	let turns = 0;
	let queued: string[] = [];
	let lastCommands: CommandInfo[] = [];
	let lastSessionId: string | undefined;
	let noAttachTimer: NodeJS.Timeout | undefined;
	let lingerTimer: NodeJS.Timeout | undefined;
	let finish!: (exit: RunnerExit) => void;
	const done = new Promise<RunnerExit>(resolve => {
		finish = resolve;
	});
	const conns = new Set<Conn>();
	const pendingRuns = new Map<string, (r: CommandRunResult) => void>();

	const redactors: Array<(s: string) => string> = [];
	const redact = (s: string): string => {
		let out = s;
		for (const fn of redactors) {
			try {
				const next = fn(out);
				out = typeof next === 'string' ? next : '[unredactable]';
			} catch {
				out = '[unredactable]';
			}
		}
		return out;
	};

	const ring: Array<Extract<RunnerFrame, {type: 'log'}>> = [];
	const wireFields = (fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
		if (!fields) return undefined;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(fields).slice(0, 20)) {
			const v = fields[k];
			if (typeof v === 'string') out[k] = redact(v).slice(0, 1024);
			else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
			else if (typeof v === 'boolean' || v === null) out[k] = v;
			else if (v instanceof Error) out[k] = redact(`${v.name}: ${v.message}`).slice(0, 1024);
		}
		return out;
	};

	const write = (conn: Conn, body: Body<RunnerFrame>): void => {
		try {
			conn.socket.write(encodeFrame({v: 1, ...body} as Frame));
		} catch (err) {
			if (err instanceof ProtocolError) opts.log?.warn('runner frame dropped', {type: body.type, err});
		}
	};

	const makeLogger = (): Logger => {
		const emit = (level: 'error' | 'warn' | 'info' | 'debug') => (msg: string, fields?: Record<string, unknown>) => {
			opts.log?.[level](msg, fields);
			const wire = wireFields(fields);
			const frame = {v: 1 as const, type: 'log' as const, level, msg: redact(msg).slice(0, 4096), ...(wire && {fields: wire})};
			if (client) write(client, frame);
			else {
				ring.push(frame);
				if (ring.length > LOG_RING) ring.shift();
			}
		};
		const logger: Logger = {
			error: emit('error'),
			warn: emit('warn'),
			info: emit('info'),
			debug: emit('debug'),
			child: () => logger,
			addRedactor: fn => {
				if (redactors.length < MAX_REDACTORS) redactors.push(fn);
			},
		};
		return logger;
	};
	const log = makeLogger();

	const queueCount = (): number => queued.length;

	const status = (): ControlStatus => {
		const s = engine?.session;
		const pending = s?.pendingPermissions.length ?? 0;
		const id = s?.sessionId;
		return {
			kind: 'chat',
			where: 'runner',
			state: s?.state === 'running' ? (pending > 0 ? 'waiting-permission' : 'running') : 'idle',
			...(s?.title !== undefined && {title: s.title}),
			...(id !== undefined && /^[0-9a-f]{8}/i.test(id) && {sessionId8: id.slice(0, 8)}),
			startedAt,
			pending,
			queued: queueCount(),
			attached: client !== undefined,
		};
	};

	const failPending = (): void => {
		for (const resolve of [...pendingRuns.values()]) {
			resolve({status: 'off', output: '', truncated: false, ms: 0, reason: 'yena is closed'});
		}
		pendingRuns.clear();
	};

	const bridge: CommandBridge = {
		list: () => lastCommands,
		run: req =>
			new Promise<CommandRunResult>(resolve => {
				const c = client;
				const t0 = now();
				const off = (): CommandRunResult => ({status: 'off', output: '', truncated: false, ms: 0, reason: 'yena is closed'});
				if (!c) {
					resolve(off());
					return;
				}
				const id = randomUUID();
				let timer: NodeJS.Timeout | undefined;
				let settled = false;
				const finish = (r: CommandRunResult): void => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					req.signal?.removeEventListener('abort', onAbort);
					pendingRuns.delete(id);
					resolve(r);
				};
				const onAbort = (): void => {
					if (client) write(client, {type: 'bridgeAbort', id});
					finish({status: 'aborted', output: '', truncated: false, ms: now() - t0, reason: 'Aborted'});
				};
				if (req.signal?.aborted) {
					finish({status: 'aborted', output: '', truncated: false, ms: 0, reason: 'Aborted'});
					return;
				}
				req.signal?.addEventListener('abort', onAbort, {once: true});

				const run = (approved = false): void => {
					if (settled) return;
					const target = client;
					if (!target) {
						finish(off());
						return;
					}
					const timeoutMs = req.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
					pendingRuns.set(id, finish);
					timer = setTimeout(() => {
						if (client) write(client, {type: 'bridgeAbort', id});
						finish({status: 'timeout', output: '', truncated: false, ms: now() - t0, reason: 'The command did not answer in time'});
					}, timeoutMs + BRIDGE_SLACK_MS);
					timer.unref();
					write(target, {type: 'bridgeRun', id, line: req.line, timeoutMs, ...(approved && {approved: true})});
				};

				// The chat's own confirmation decides, as in a chat without the runner: auto mode, a saved "always",
				// or the prompt through the chat's permission queue (shown by the attached client). The client
				// still asks itself for a line the runner thought needed nothing, if its bridge says it does.
				const found = req.confirm ? policyFor(lastCommands, req.line) : undefined;
				const confirm = req.confirm;
				if (found && found.policy === 'confirm' && confirm) {
					Promise.resolve()
						.then(() => confirm({...found.request, caller: req.caller}))
						.then(
							ok => ok === true,
							() => false,
						)
						.then(ok => {
							if (!ok) finish({status: 'declined', output: '', truncated: false, ms: now() - t0, reason: 'The command was not confirmed'});
							else run(true);
						});
					return;
				}
				run();
			}),
	};

	const io: EngineIo = {
		commandBridge: bridge,
		stateUpdate: async patch => {
			if (client) {
				write(client, {type: 'stateUpdate', patch: toStatePatch(patch)});
				return;
			}
			await opts.store.update(patch);
		},
		warn: text => log.warn('engine warning', {text}),
	};

	const snapshot = (s: RunnerSession): Body<RunnerFrame> => {
		const body: Snapshot = {
			state: s.state,
			...(s.sessionId !== undefined && {sessionId: s.sessionId}),
			...(s.model !== undefined && {model: s.model}),
			mode: s.mode,
			needsNewSession: s.needsNewSession,
			...(s.title !== undefined && {title: s.title}),
			pendingPermissions: [...s.pendingPermissions],
			tasks: [...s.tasks],
			commands: [...s.commands],
			...(s.rateLimit !== undefined && {rateLimit: s.rateLimit}),
			...(s.costUsd !== undefined && {costUsd: s.costUsd}),
			queued: [...queued],
			startedAt,
		};
		return {type: 'snapshot', ...body};
	};

	const greet = (c: Conn): void => {
		if (!engine) return;
		write(c, snapshot(engine.session));
		for (const frame of ring.splice(0)) write(c, frame);
	};

	const armLinger = (): void => {
		if (lingerTimer || closing) return;
		lingerTimer = setTimeout(() => void shutdown('abandoned'), opts.lingerMs ?? LINGER_MS);
		lingerTimer.unref();
	};

	// Detached with nothing to wait for: leave right away; a kept queue waits for the user.
	const settleDetached = (): void => {
		if (closing || client || !engine) return;
		const s = engine.session;
		if (s.state === 'running' || s.pendingPermissions.length > 0) return;
		if (s.tasks.some(t => t.status === 'running')) return;
		if (queued.length === 0) void shutdown('idle');
		else armLinger();
	};

	const onTurnEnd = (outcome: string): void => {
		turns++;
		if (client || closing || !engine) return;
		const s = engine.session;
		if (outcome === 'ok' && queued.length > 0) {
			const text = queued.join('\n\n');
			const count = queued.length;
			queued = [];
			setImmediate(() => {
				if (closing || client) return;
				try {
					s.send(text);
					log.info('queue flushed', {count});
				} catch (err) {
					log.warn('queue flush failed', {err});
					void shutdown('error');
				}
			});
			return;
		}
		settleDetached();
	};

	const onEvent = (e: ChatEvent): void => {
		if (closing) return;
		if (client) write(client, {type: 'event', event: e});
		const id = engine?.session.sessionId;
		if (id && id !== lastSessionId) lastSessionId = id;
		if (e.type === 'turn-end') onTurnEnd(e.outcome);
		if (e.type === 'ui' && e.event.kind === 'task' && e.event.status !== 'running' && !client) {
			const t = setTimeout(settleDetached, opts.taskSettleMs ?? TASK_SETTLE_MS);
			t.unref();
		}
	};

	const shutdown = (reason: string, byeReason = reason): Promise<RunnerExit> => {
		closing ??= (async () => {
			if (noAttachTimer) clearTimeout(noAttachTimer);
			if (lingerTimer) clearTimeout(lingerTimer);
			failPending();
			if (engine) {
				void engine.session.interrupt().catch(() => undefined);
				engine.close();
				await Promise.race([engine.flush().catch(() => undefined), sleep(FLUSH_WAIT_MS)]);
			}
			const ms = now() - startedAt;
			log.info('runner exit', {reason, turns, ms});
			if (client) write(client, {type: 'bye', reason: byeReason});
			const sockets = [...conns].map(c => c.socket);
			const closed = Promise.all(sockets.map(s => new Promise<void>(r => (s.destroyed ? r() : s.once('close', () => r())))));
			for (const s of sockets) s.end();
			await Promise.race([closed, sleep(CLOSE_WAIT_MS)]);
			for (const s of sockets) s.destroy();
			await new Promise<void>(r => server.close(() => r()));
			const exit = {reason, turns, ms};
			finish(exit);
			return exit;
		})();
		return closing;
	};

	const runRpc = async (frame: Extract<ClientFrame, {type: 'rpc'}>, s: RunnerSession): Promise<unknown> => {
		switch (frame.op) {
			case 'stopTask':
				return s.stopTask(frame.args.id);
			case 'mcpStatus':
				return s.mcpStatus();
			case 'reconnectMcp':
				return s.reconnectMcp(frame.args.name);
			case 'rewindFiles':
				return s.rewindFiles(frame.args.userMessageId);
			case 'backgroundTasks':
				return s.backgroundTasks();
		}
	};

	const open = async (c: Conn, frame: Extract<ClientFrame, {type: 'open'}>): Promise<void> => {
		if (engine || opening || closing) return;
		opening = true;
		if (noAttachTimer) clearTimeout(noAttachTimer);
		keep = frame.keep;
		const spec = frame.open;
		let created: RunnerEngine;
		try {
			created = await opts.createEngine(
				{
					fresh: spec.fresh,
					...(spec.model !== undefined && {model: spec.model}),
					tuning: frame.tuning,
					...(spec.resume !== undefined && {resume: spec.resume}),
					...(spec.fork !== undefined && {fork: spec.fork}),
					...(spec.resumeAt !== undefined && {resumeAt: spec.resumeAt}),
				},
				io,
				log,
				{status, stop: () => void shutdown('stopped')},
			);
		} catch (err) {
			opening = false;
			log.error('runner open failed', {error: errClass(err)});
			const message = err instanceof Error ? err.message : 'Could not open the chat';
			await shutdown('open-failed', clip(redact(message), 1000));
			return;
		}
		opening = false;
		engine = created;
		if (closing) {
			created.close();
			return;
		}
		if (frame.mode && frame.mode !== created.session.mode) {
			try {
				created.session.setMode(frame.mode);
			} catch (err) {
				log.warn('initial mode rejected', {err});
			}
		}
		created.session.subscribe(onEvent);
		lastSessionId = created.session.sessionId;
		if (client === c) greet(c);
		else settleDetached();
	};

	const handleAttached = async (c: Conn, frame: ClientFrame): Promise<void> => {
		if (frame.type === 'open') {
			await open(c, frame);
			return;
		}
		if (frame.type === 'status') {
			write(c, {type: 'statusReply', status: status()});
			return;
		}
		if (frame.type === 'stop' || frame.type === 'close') {
			void shutdown(frame.type === 'stop' ? 'stopped' : 'closed');
			return;
		}
		if (frame.type === 'queue') {
			queued = frame.lines;
			return;
		}
		if (frame.type === 'setKeep') {
			keep = frame.keep;
			return;
		}
		if (frame.type === 'commands') {
			lastCommands = frame.list;
			return;
		}
		if (frame.type === 'bridgeResult') {
			pendingRuns.get(frame.id)?.(frame.result);
			return;
		}
		// Older runners asked the client with bridgeAsk; this one confirms through the chat, so answers are ignored.
		if (frame.type === 'bridgeConfirm') return;
		const s = engine?.session;
		if (!s) return;
		try {
			switch (frame.type) {
				case 'send':
					try {
						s.send(frame.text, frame.command ? {command: true} : {});
					} catch (err) {
						// The client already shows the turn as running: end it with the reason instead of leaving it hanging.
						const error = clip(redact(err instanceof Error ? err.message : 'The message was not sent'), 1000);
						write(c, {type: 'event', event: {type: 'turn-end', outcome: 'error', error}});
						write(c, {type: 'event', event: {type: 'state', state: 'idle'}});
					}
					break;
				case 'interrupt':
					await s.interrupt();
					break;
				case 'setMode':
					s.setMode(frame.mode);
					break;
				case 'answer':
					s.answerPermission(frame.id, frame.decision);
					break;
				case 'reset':
					s.reset();
					break;
				case 'applyLive':
					engine?.applyLive(frame.patch);
					break;
				case 'setTitle':
					s.setTitle(frame.title);
					break;
				case 'forget':
					s.forget(frame.key);
					break;
				case 'rpc':
					try {
						const value = await runRpc(frame, s);
						write(c, {type: 'rpcResult', id: frame.id, ok: true, ...(value !== undefined && {value})});
					} catch (err) {
						const msg = err instanceof Error ? err.message : 'The request failed';
						write(c, {type: 'rpcResult', id: frame.id, ok: false, error: clip(redact(msg), 4000)});
					}
					break;
				default:
					break;
			}
		} catch (err) {
			log.warn('runner request failed', {type: frame.type, error: errClass(err)});
		}
	};

	const handleFrame = async (c: Conn, frame: ClientFrame): Promise<void> => {
		if (frame.type === 'hello') {
			if (c.role) return;
			if (c.helloTimer) clearTimeout(c.helloTimer);
			if (frame.role === 'control') {
				c.role = 'control';
				return;
			}
			if (client) {
				write(c, {type: 'bye', reason: 'attached elsewhere'});
				c.socket.end();
				return;
			}
			c.role = 'attach';
			client = c;
			if (lingerTimer) clearTimeout(lingerTimer);
			lingerTimer = undefined;
			log.info('runner attached', {keep});
			greet(c);
			return;
		}
		if (c.role === 'control') {
			if (frame.type === 'status') {
				write(c, {type: 'statusReply', status: status()});
				c.socket.end();
			} else if (frame.type === 'stop') {
				void shutdown('stopped');
			}
			return;
		}
		if (c.role === 'attach' && client === c) await handleAttached(c, frame);
	};

	const onClosed = (c: Conn): void => {
		conns.delete(c);
		if (c.helloTimer) clearTimeout(c.helloTimer);
		if (client !== c) return;
		client = undefined;
		failPending();
		log.info('runner detached', {keep});
		if (closing) return;
		if (opening) return;
		if (!engine) {
			void shutdown('detached');
			return;
		}
		if (!keep) {
			void shutdown('detached');
			return;
		}
		settleDetached();
	};

	const server = net.createServer(socket => {
		if (conns.size >= MAX_CLIENTS || closing) {
			socket.destroy();
			return;
		}
		const c: Conn = {socket, chain: Promise.resolve()};
		conns.add(c);
		const decoder = createDecoder('toRunner');
		c.helloTimer = setTimeout(() => socket.destroy(), HELLO_MS);
		c.helloTimer.unref();
		socket.on('error', () => socket.destroy());
		socket.on('close', () => onClosed(c));
		socket.on('data', chunk => {
			let frames: Frame[];
			try {
				frames = decoder.push(chunk);
			} catch (err) {
				if (c.role === 'attach') log.warn('runner protocol error', {error: errClass(err)});
				socket.destroy();
				return;
			}
			for (const f of frames) {
				c.chain = c.chain
					.then(() => handleFrame(c, f as ClientFrame))
					.catch(err => void log.warn('runner frame failed', {error: errClass(err)}));
			}
		});
	});

	// A live runner (idle, attached to another yena) keeps its socket; this one does not start.
	if (await accepts(socketPath)) throw new Error('A background chat is already running');
	removeLeftoverSocket(socketPath);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(socketPath, () => {
			server.off('error', reject);
			resolve();
		});
	});
	server.on('error', err => log.warn('runner server error', {err}));
	chmodSync(socketPath, 0o600);

	noAttachTimer = setTimeout(() => void shutdown('no-attach'), opts.noAttachMs ?? NO_ATTACH_MS);
	noAttachTimer.unref();

	return {socketPath, done, stop: reason => shutdown(reason ?? 'stopped')};
}
