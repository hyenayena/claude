import {randomUUID} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type {CommandBridge, CommandConfirmRequest, CommandRunResult, Logger} from '../../../../src/api.js';
import type {ChatTuning, LivePatch} from '../chat-prefs.js';
import {errClass, noopLog} from '../log.js';
import {createDecoder, encodeFrame, ProtocolError} from '../runner/protocol.js';
import type {ClientFrame, OpenSpec, RpcCall, RunnerFrame, Snapshot, StatePatch} from '../runner/protocol.js';
import {RESUME_MESSAGE} from '../session.js';
import {readHolder} from '../sessions/lock.js';
import type {RewindResult} from '../types.js';
import type {SlashCommandInfo, TaskInfo} from './chat-session.js';
import type {ChatEvent, ChatState} from './events.js';
import type {ChatHandle} from './handle.js';
import type {RateLimitInfo} from './limits.js';
import {MODE_CYCLE, PERMISSION_IDLE_MS} from './permission.js';
import type {ChatMode, PermissionDecision, PermissionRequest, ToolRequest} from './permission.js';

export const RPC_TIMEOUT_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 30_000;
const MAX_TASKS = 100;
const MAX_QUEUE_LINES = 16;
const MAX_COMMANDS = 500;

export type RemoteOptions = {
	socketPath: string;
	log?: Logger;
	// Runs the console commands the background chat asks for; without it they answer `off`.
	commandBridge?: CommandBridge;
	// Shown in confirmation prompts for console commands.
	cwd: string;
	// Persists what the runner reports about state.json (this process owns the file).
	stateUpdate: (patch: StatePatch) => Promise<unknown>;
	// The connection ended or the chat was closed by the other side.
	onLost?: (reason: string) => void;
	// Sent after the hello when this attach starts a fresh runner.
	open?: {open: OpenSpec; tuning: ChatTuning; mode?: ChatMode; keep: boolean};
	rpcTimeoutMs?: number;
	connectTimeoutMs?: number;
};

type Local = {
	req: ToolRequest;
	resolve: (ok: boolean) => void;
	timer: NodeJS.Timeout;
	detach: () => void;
};

type Rpc = {resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

let seq = 0;

/** A chat that runs in a background process, mirrored locally over the runner's unix socket. */
/** A send refused because another session (another yena or runner) is working right now. */
export const BUSY_SEND = 'Another session is working right now. Your message stays in the input; send it when that session is done.';

export class RemoteChatSession implements ChatHandle {
	readonly detachesOnClose = true;
	/** Set when the attach found a runner that was already working (no `open` was sent). */
	reattached = false;
	/** Whether the chat was still answering when this side detached. */
	detachedWhileRunning = false;

	private readonly log: Logger;
	private readonly listeners = new Set<(e: ChatEvent) => void>();
	private readonly rpcs = new Map<string, Rpc>();
	private readonly runs = new Map<string, AbortController>();
	private readonly locals: Local[] = [];
	private readonly optimistic = new Set<string>();
	// Bridge ids already approved: by the runner's chat (bridgeRun approved) or by the user through a bridgeAsk (older runners).
	private readonly approvedRuns = new Set<string>();
	private remotePending: PermissionRequest[] = [];
	private readonly _tasks = new Map<string, TaskInfo>();
	private _state: ChatState = 'idle';
	private _sessionId: string | undefined;
	private _model: string | undefined;
	private _mode: ChatMode = 'default';
	private _title: string | undefined;
	private _needsNewSession = false;
	private _commands: SlashCommandInfo[] = [];
	private _rateLimit: RateLimitInfo | undefined;
	private _costUsd: number | undefined;
	private _queued: string[] = [];
	private _startedAt = Date.now();
	private lastCommands = '';
	private lostReported = false;
	private readonly socket: net.Socket;
	private readonly opts: RemoteOptions;

	private constructor(opts: RemoteOptions, socket: net.Socket) {
		this.opts = opts;
		this.socket = socket;
		this.log = opts.log ?? noopLog;
	}

	/** Connects, optionally opens a fresh chat, and resolves with the mirror once the first snapshot arrived. */
	static connect(opts: RemoteOptions): Promise<RemoteChatSession> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(opts.socketPath);
			const session = new RemoteChatSession(opts, socket);
			session.reattached = opts.open === undefined;
			const decoder = createDecoder('toClient');
			let settled = false;
			const timeout = setTimeout(
				() => fail(new Error('The background chat did not answer in time')),
				opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
			);
			timeout.unref();
			const fail = (err: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.destroy();
				reject(err);
			};
			const ready = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(session);
			};
			socket.on('connect', () => {
				session.write({v: 1, type: 'hello', role: 'attach'});
				if (opts.open) {
					session.write({
						v: 1,
						type: 'open',
						open: opts.open.open,
						tuning: opts.open.tuning,
						...(opts.open.mode !== undefined && {mode: opts.open.mode}),
						keep: opts.open.keep,
					});
				}
			});
			socket.on('data', chunk => {
				let frames;
				try {
					frames = decoder.push(chunk);
				} catch (err) {
					const message = err instanceof ProtocolError ? err.message : 'Invalid data';
					if (!settled) fail(new Error(`Could not read the background chat: ${message}`));
					else session.lose('The background chat sent invalid data.');
					return;
				}
				for (const frame of frames) {
					if (!settled) {
						if (frame.type === 'snapshot') {
							session.applySnapshot(frame);
							ready();
						} else if (frame.type === 'bye') {
							fail(new Error(frame.reason));
							return;
						}
						continue;
					}
					session.onFrame(frame as RunnerFrame);
				}
			});
			socket.on('error', err => {
				if (!settled) fail(new Error(`Could not connect to the background chat (${errClass(err)})`));
				else session.lose('The connection to the background chat failed.');
			});
			socket.on('close', () => {
				if (!settled) fail(new Error('The background chat closed the connection'));
				else session.lose('Lost the connection to the background chat.');
			});
		});
	}

	get state(): ChatState {
		return this._state;
	}
	get sessionId(): string | undefined {
		return this._sessionId;
	}
	get model(): string | undefined {
		return this._model;
	}
	get needsNewSession(): boolean {
		return this._needsNewSession;
	}
	get mode(): ChatMode {
		return this._mode;
	}
	get title(): string | undefined {
		return this._title;
	}
	get costUsd(): number | undefined {
		return this._costUsd;
	}
	get rateLimit(): RateLimitInfo | undefined {
		return this._rateLimit;
	}
	get startedAt(): number {
		return this._startedAt;
	}
	get queued(): readonly string[] {
		return this._queued;
	}
	get commands(): readonly SlashCommandInfo[] {
		return this._commands;
	}
	get tasks(): readonly TaskInfo[] {
		return [...this._tasks.values()].reverse();
	}
	get pendingPermissions(): readonly PermissionRequest[] {
		return [...this.remotePending, ...this.locals.map(l => l.req)];
	}

	subscribe(cb: (e: ChatEvent) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	send(text: string, opts: {command?: boolean} = {}): void {
		if (this._state === 'closed') throw new Error('The chat is closed');
		if (this._state === 'running') throw new Error('A request is already running');
		if (this._needsNewSession) throw new Error(RESUME_MESSAGE);
		// The runner holds the session lock only while it works, so a lock here is another session's.
		let holder;
		try {
			holder = readHolder(path.dirname(this.opts.socketPath)).holder;
		} catch {
			holder = undefined;
		}
		if (holder) throw new Error(BUSY_SEND);
		// The runner confirms with its own state event; the view needs the flip at once.
		this._state = 'running';
		this.write({v: 1, type: 'send', text, ...(opts.command && {command: true})});
	}

	async interrupt(): Promise<void> {
		if (this._state !== 'running') return;
		this.write({v: 1, type: 'interrupt'});
	}

	setMode(mode: ChatMode): void {
		if (this._state === 'closed') throw new Error('The chat is closed');
		if (!MODE_CYCLE.includes(mode)) throw new Error('Unknown permission mode');
		this._mode = mode;
		this.write({v: 1, type: 'setMode', mode});
	}

	answerPermission(id: string, decision: PermissionDecision): boolean {
		const local = this.locals.findIndex(l => l.req.id === id);
		if (local >= 0) {
			const entry = this.locals[local]!;
			if (decision.kind === 'answers') return false;
			this.dropLocal(entry);
			this.emit({type: 'permission-resolved', id, pending: this.pendingPermissions.length});
			entry.resolve(decision.kind === 'allow');
			return true;
		}
		const at = this.remotePending.findIndex(r => r.id === id);
		if (at < 0) return false;
		const req = this.remotePending[at]!;
		if (decision.kind === 'answers' && req.kind !== 'question') return false;
		if (decision.kind === 'allow' && req.kind !== 'tool') return false;
		this.remotePending.splice(at, 1);
		this.optimistic.add(id);
		this.write({v: 1, type: 'answer', id, decision});
		return true;
	}

	reset(): void {
		if (this._state === 'closed') throw new Error('The chat is closed');
		if (this._state === 'running') throw new Error('Cannot start a new session while a request is running');
		this._sessionId = undefined;
		this._model = undefined;
		this._costUsd = undefined;
		this._needsNewSession = false;
		this.write({v: 1, type: 'reset'});
	}

	applyLive(patch: LivePatch): void {
		if (this._state === 'closed') return;
		this.write({v: 1, type: 'applyLive', patch});
	}

	setTitle(title: string): void {
		if (this._state === 'closed' || title === '' || title === this._title) return;
		this._title = title;
		this.emit({type: 'title', title});
		this.write({v: 1, type: 'setTitle', title});
	}

	forget(key: string): void {
		this.write({v: 1, type: 'forget', key});
	}

	setQueued(lines: readonly string[]): void {
		this._queued = lines.slice(0, MAX_QUEUE_LINES);
		this.write({v: 1, type: 'queue', lines: this._queued});
	}

	setKeep(keep: boolean): void {
		this.write({v: 1, type: 'setKeep', keep});
	}

	/** Tells the runner which console commands exist; sent after attach and after each console run. */
	refreshCommands(): void {
		const list = this.opts.commandBridge?.list();
		if (!list) return;
		const body = list.slice(0, MAX_COMMANDS);
		const json = JSON.stringify(body);
		if (json === this.lastCommands) return;
		this.lastCommands = json;
		this.write({v: 1, type: 'commands', list: body});
	}

	async backgroundTasks(): Promise<boolean> {
		if (this._state !== 'running') return false;
		return this.rpc({op: 'backgroundTasks', args: {}}, v => v === true);
	}

	stopTask(id: string): Promise<void> {
		return this.rpc({op: 'stopTask', args: {id}}, () => undefined);
	}

	mcpStatus(): Promise<Array<{name: string; status: string; error?: string}> | undefined> {
		return this.rpc({op: 'mcpStatus', args: {}}, v => {
			if (!Array.isArray(v)) return undefined;
			return v.filter(isObj).flatMap(s =>
				typeof s.name === 'string' && typeof s.status === 'string'
					? [{name: s.name, status: s.status, ...(typeof s.error === 'string' && {error: s.error})}]
					: [],
			);
		});
	}

	reconnectMcp(name: string): Promise<void> {
		return this.rpc({op: 'reconnectMcp', args: {name}}, () => undefined);
	}

	rewindFiles(userMessageId: string): Promise<RewindResult> {
		return this.rpc({op: 'rewindFiles', args: {userMessageId}}, v => {
			if (!isObj(v) || typeof v.canRewind !== 'boolean') return {canRewind: false, error: 'unexpected answer from the background chat'};
			return {
				canRewind: v.canRewind,
				...(typeof v.error === 'string' && {error: v.error}),
				...(Array.isArray(v.filesChanged) && {filesChanged: v.filesChanged.filter((f): f is string => typeof f === 'string')}),
			};
		});
	}

	/** Asks the runner to close the chat, then leaves. */
	end(): void {
		this.write({v: 1, type: 'close'});
		this.close();
	}

	/** Leaves the chat; the background process keeps it. Idempotent. */
	close(): void {
		if (this._state === 'closed') return;
		this.detachedWhileRunning = this._state === 'running';
		this.log.info('chat remote', {action: 'detached', running: this.detachedWhileRunning});
		this.lostReported = true;
		this.shutdown();
	}

	private write(frame: ClientFrame): void {
		if (this.socket.destroyed || !this.socket.writable) return;
		try {
			this.socket.write(encodeFrame(frame));
		} catch (err) {
			this.log.warn('chat remote write failed', {error: errClass(err)});
		}
	}

	private rpc<T>(call: RpcCall, read: (v: unknown) => T): Promise<T> {
		if (this._state === 'closed') return Promise.reject(new Error('The chat is closed'));
		const id = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.rpcs.delete(id);
				reject(new Error('The background chat did not answer in time'));
			}, this.opts.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
			timer.unref();
			this.rpcs.set(id, {resolve: v => resolve(read(v)), reject, timer});
			this.write({v: 1, type: 'rpc', id, ...call} as ClientFrame);
		});
	}

	private applySnapshot(s: Snapshot): void {
		this._state = s.state;
		this._sessionId = s.sessionId;
		this._model = s.model;
		this._mode = s.mode;
		this._needsNewSession = s.needsNewSession;
		this._title = s.title;
		this.remotePending = [...s.pendingPermissions];
		this._tasks.clear();
		for (const t of [...s.tasks].reverse()) this._tasks.set(t.id, t);
		this._commands = [...s.commands];
		this._rateLimit = s.rateLimit;
		this._costUsd = s.costUsd;
		this._queued = [...s.queued];
		this._startedAt = s.startedAt;
	}

	private onFrame(frame: RunnerFrame): void {
		switch (frame.type) {
			case 'snapshot':
				this.applySnapshot(frame);
				return;
			case 'event':
				this.onEvent(frame.event);
				return;
			case 'rpcResult': {
				const rpc = this.rpcs.get(frame.id);
				if (!rpc) return;
				this.rpcs.delete(frame.id);
				clearTimeout(rpc.timer);
				if (frame.ok) rpc.resolve(frame.value);
				else rpc.reject(new Error(frame.error ?? 'The background chat refused'));
				return;
			}
			case 'bridgeRun':
				if (frame.approved === true) this.approvedRuns.add(frame.id);
				this.runConsole(frame.id, frame.line, frame.timeoutMs);
				return;
			case 'bridgeAbort':
				this.runs.get(frame.id)?.abort();
				return;
			case 'bridgeAsk':
				void this.confirmLocal(frame.request, undefined).then(ok => {
					if (ok) this.approvedRuns.add(frame.id);
					this.write({v: 1, type: 'bridgeConfirm', id: frame.id, ok});
				});
				return;
			case 'stateUpdate':
				this.opts.stateUpdate(frame.patch).catch((err: unknown) => this.log.warn('chat remote state update failed', {error: errClass(err)}));
				return;
			case 'log': {
				this.log.child('runner')[frame.level](frame.msg, frame.fields);
				return;
			}
			case 'bye':
				this.lose(frame.reason === '' ? 'The background chat ended.' : `The background chat ended: ${frame.reason}`);
				return;
			case 'statusReply':
				return;
		}
	}

	private onEvent(event: ChatEvent): void {
		switch (event.type) {
			case 'state':
				if (event.state === 'closed') {
					this.lose('The background chat ended.');
					return;
				}
				this._state = event.state;
				break;
			case 'mode':
				this._mode = event.mode;
				break;
			case 'title':
				if (event.title === this._title) return;
				this._title = event.title;
				break;
			case 'permission-requested':
				if (this.remotePending.some(r => r.id === event.request.id) || this.optimistic.has(event.request.id)) return;
				this.remotePending.push(event.request);
				this.emit({...event, pending: this.pendingPermissions.length});
				return;
			case 'permission-resolved': {
				const at = this.remotePending.findIndex(r => r.id === event.id);
				if (at >= 0) this.remotePending.splice(at, 1);
				else if (!this.optimistic.delete(event.id)) return;
				this.emit({...event, pending: this.pendingPermissions.length});
				return;
			}
			case 'ui':
				this.onUi(event.event);
				break;
			default:
				break;
		}
		this.emit(event);
	}

	private onUi(ev: Extract<ChatEvent, {type: 'ui'}>['event']): void {
		switch (ev.kind) {
			case 'session':
				this._sessionId = ev.sessionId;
				this._model = ev.model ?? this._model;
				if (ev.slashCommands) {
					const known = new Map(this._commands.map(c => [c.name, c]));
					for (const name of ev.slashCommands) known.set(name, {...known.get(name), name});
					this._commands = [...known.values()].slice(0, 300);
				}
				return;
			case 'task': {
				const known = this._tasks.get(ev.id);
				this._tasks.set(ev.id, {
					id: ev.id,
					status: ev.status,
					description: ev.description ?? known?.description ?? 'task',
					background: ev.background ?? known?.background ?? false,
					startedAt: known?.startedAt ?? Date.now(),
					...((ev.summary ?? known?.summary) !== undefined && {summary: ev.summary ?? known?.summary}),
					...((ev.taskType ?? known?.taskType) !== undefined && {taskType: ev.taskType ?? known?.taskType}),
				});
				if (this._tasks.size > MAX_TASKS) this._tasks.delete(this._tasks.keys().next().value!);
				return;
			}
			case 'rate-limit':
				this._rateLimit = ev.info;
				return;
			case 'result':
				if (ev.sessionId) this._sessionId = ev.sessionId;
				if (ev.costUsd !== undefined) this._costUsd = ev.costUsd;
				return;
			default:
				return;
		}
	}

	private runConsole(id: string, line: string, timeoutMs: number): void {
		const reply = (result: CommandRunResult): void => this.write({v: 1, type: 'bridgeResult', id, result});
		const bridge = this.opts.commandBridge;
		if (!bridge) {
			reply({status: 'off', output: 'Console commands are not available here.', truncated: false, ms: 0});
			return;
		}
		const ac = new AbortController();
		this.runs.set(id, ac);
		bridge
			.run({line, caller: 'claude', confirm: req => (this.approvedRuns.has(id) ? Promise.resolve(true) : this.confirmLocal(req, ac.signal)), signal: ac.signal, timeoutMs})
			.then(
				reply,
				() => reply({status: 'error', output: 'The console command failed to run.', truncated: false, ms: 0}),
			)
			.finally(() => {
				this.runs.delete(id);
				this.approvedRuns.delete(id);
				this.refreshCommands();
			});
	}

	// The same confirmation the chat shows for a command Claude wants to run, kept in this process.
	private confirmLocal(req: Pick<CommandConfirmRequest, 'line'>, signal: AbortSignal | undefined): Promise<boolean> {
		if (this._state === 'closed' || signal?.aborted) return Promise.resolve(false);
		return new Promise<boolean>(resolve => {
			const request: ToolRequest = {
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName: 'Command',
				input: {command: req.line},
				cwd: this.opts.cwd,
				highlights: [],
				defaultToNo: false,
				always: false,
				oversize: false,
			};
			const entry: Local = {req: request, resolve, timer: undefined as unknown as NodeJS.Timeout, detach: () => {}};
			const cancel = (): void => {
				if (!this.locals.includes(entry)) return;
				this.dropLocal(entry);
				this.emit({type: 'permission-resolved', id: request.id, pending: this.pendingPermissions.length});
				resolve(false);
			};
			entry.timer = setTimeout(cancel, PERMISSION_IDLE_MS);
			entry.timer.unref();
			signal?.addEventListener('abort', cancel, {once: true});
			entry.detach = () => signal?.removeEventListener('abort', cancel);
			this.locals.push(entry);
			this.emit({type: 'permission-requested', request, pending: this.pendingPermissions.length});
		});
	}

	private dropLocal(entry: Local): void {
		const at = this.locals.indexOf(entry);
		if (at >= 0) this.locals.splice(at, 1);
		clearTimeout(entry.timer);
		entry.detach();
	}

	// The other side ended or the socket broke: the mirror closes and the view is told once.
	private lose(reason: string): void {
		if (this._state === 'closed') return;
		if (!this.lostReported) {
			this.lostReported = true;
			this.log.warn('chat remote', {action: 'lost'});
			this.opts.onLost?.(reason);
		}
		this.shutdown();
	}

	private shutdown(): void {
		const wasRunning = this._state === 'running';
		this._state = 'closed';
		for (const ac of this.runs.values()) ac.abort();
		this.runs.clear();
		this.approvedRuns.clear();
		for (const entry of [...this.locals]) {
			this.dropLocal(entry);
			entry.resolve(false);
		}
		for (const rpc of this.rpcs.values()) {
			clearTimeout(rpc.timer);
			rpc.reject(new Error('The chat is closed'));
		}
		this.rpcs.clear();
		this.remotePending = [];
		this.socket.destroy();
		if (wasRunning) this.emit({type: 'turn-end', outcome: 'interrupted'});
		this.emit({type: 'state', state: 'closed'});
		this.listeners.clear();
	}

	private emit(e: ChatEvent): void {
		for (const cb of [...this.listeners]) {
			try {
				cb(e);
			} catch {
				// a faulty subscriber must not break the mirror
			}
		}
	}
}
