import {randomUUID} from 'node:crypto';
import type {Options, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../../src/api.js';
import {clip, errClass, noopLog} from '../log.js';
import {AUTH_MESSAGE, mapFailure, RESUME_MESSAGE} from '../session.js';
import type {LivePatch} from '../chat-prefs.js';
import type {ChatQueryFn, RewindResult} from '../types.js';
import type {ChatController, ChatEvent, ChatState, TurnOutcome, UiEvent} from './events.js';
import {InputQueue} from './input-queue.js';
import {classifyFailure, type Clock, failureMessage, type FailureKind, type RateLimitInfo, systemClock} from './limits.js';
import {normalize} from './normalize.js';
import {type ChatUsage, subtract, UsageMeter} from './usage.js';
import {
	type AuditEntry,
	type CancelCause,
	type ChatMode,
	MAX_QUEUE,
	MODE_CYCLE,
	PERMISSION_IDLE_MS,
	type PermissionDecision,
	type PermissionPrompter,
	type PermissionRequest,
	sdkPermissionMode,
} from './permission.js';

const FIRST_OUTPUT: ReadonlySet<UiEvent['kind']> = new Set(['text-delta', 'text', 'thinking', 'thinking-tokens', 'tool-input', 'tool-use']);

export const MAX_TURNS_MESSAGE = 'Reached the maximum number of turns for one request';

export type ChatSessionOptions = {
	query: ChatQueryFn;
	buildOptions: (abortController: AbortController, resume: string | undefined, prompter: PermissionPrompter) => Options;
	redact: (s: string) => string;
	timeoutMs?: number;
	graceMs?: number;
	initialResume?: string;
	initialMode?: ChatMode;
	savedApprovals?: readonly string[];
	onRemember?: (key: string) => void;
	log?: Logger;
	clock?: Clock;
	turnLock?: {acquire(): void; release(): void};
	idleCloseMs?: number;
	onUsageLimit?: (p: {reason: 'usage-limit' | 'billing'; rateLimit?: RateLimitInfo}) => {from: string; to: string} | undefined;
};

export const CONTINUE_TEXT = 'Continue from where you stopped; the previous attempt was cut off by a usage limit.';
const MAX_SWITCHES = 8;

export type SlashCommandInfo = {name: string; description?: string; argumentHint?: string};
export type TaskInfo = {
	id: string;
	status: 'running' | 'completed' | 'failed' | 'stopped';
	description: string;
	background: boolean;
	startedAt: number;
	summary?: string;
	taskType?: string;
};
const MAX_TASKS = 100;

const MAX_COMMANDS = 300;
export const isCommandName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(name);

type Handle = {
	q: ReturnType<ChatQueryFn>;
	input: InputQueue<SDKUserMessage>;
	ac: AbortController;
};

type Pending = {outcome: TurnOutcome; error?: string};
type TurnError = {code: string; detail?: string};

type Entry = {
	req: PermissionRequest;
	resolve: (d: PermissionDecision) => void;
	handle: Handle | undefined;
	idleTimer: NodeJS.Timeout;
	detach: () => void;
	at: number;
};

const MAX_APPROVED = 100;

const toolNameOf = (req: PermissionRequest): string => (req.kind === 'tool' ? req.toolName : 'AskUserQuestion');

const summaryOf = (req: PermissionRequest): string => {
	const raw =
		req.kind === 'question'
			? `${req.questions.length} question(s)`
			: req.path !== undefined
				? req.resolvedPath === undefined
					? req.path
					: `${req.path} -> ${req.resolvedPath}`
				: typeof req.input.command === 'string'
					? req.input.command
					: '';
	return raw.replace(/\s+/g, ' ').trim();
};

const outcomeOf = (req: PermissionRequest, d: PermissionDecision): AuditEntry['outcome'] => {
	switch (d.kind) {
		case 'allow':
			return 'allowed';
		case 'answers':
			return 'answered';
		case 'deny':
			return req.kind === 'question' ? 'dismissed' : 'denied';
		case 'cancel':
			return 'cancelled';
	}
};

export class ChatSession implements ChatController, PermissionPrompter {
	private readonly opts: ChatSessionOptions;
	private readonly timeoutMs: number;
	private readonly graceMs: number;
	private readonly log: Logger;
	private readonly listeners = new Set<(e: ChatEvent) => void>();
	private handle: Handle | undefined;
	private _state: ChatState = 'idle';
	private _sessionId: string | undefined;
	private _model: string | undefined;
	private _needsNewSession = false;
	private _costUsd: number | undefined;
	private authFailed = false;
	private turnError: TurnError | undefined;
	private _rateLimit: RateLimitInfo | undefined;
	private readonly clock: Clock;
	private pending: Pending | undefined;
	private turnTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private turnStartedAt = 0;
	private turnHandle: Handle | undefined;
	private turnDeadline = 0;
	private turnRemaining: number | undefined;
	private holds = 0;
	private readonly meter = new UsageMeter();
	private turnUsageFrom: ChatUsage | undefined;
	private firstOutput: {at: number; warm: boolean} | undefined;
	private lockHeld = false;
	private idleTimer: NodeJS.Timeout | undefined;
	private holdEpoch = 0;
	private permissionHold: (() => void) | undefined;
	private switches = 0;
	private _mode: ChatMode = 'default';
	private _commands: SlashCommandInfo[] = [];
	private _title: string | undefined;
	private readonly _tasks = new Map<string, TaskInfo>();
	private readonly queue: Entry[] = [];
	private readonly approved = new Set<string>();
	private readonly saved = new Set<string>();

	constructor(opts: ChatSessionOptions) {
		this.opts = opts;
		this.timeoutMs = opts.timeoutMs ?? 300_000;
		this.graceMs = opts.graceMs ?? 8_000;
		this.log = opts.log ?? noopLog;
		this.clock = opts.clock ?? systemClock;
		this._sessionId = opts.initialResume;
		if (opts.initialMode && MODE_CYCLE.includes(opts.initialMode)) this._mode = opts.initialMode;
		for (const key of opts.savedApprovals ?? []) this.saved.add(key);
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
	get costUsd(): number | undefined {
		return this._costUsd;
	}

	get rateLimit(): RateLimitInfo | undefined {
		return this._rateLimit;
	}

	get mode(): ChatMode {
		return this._mode;
	}
	applyLive(patch: LivePatch): void {
		const q = this.handle?.q;
		if (!q || this._state === 'closed') return;
		const fail = (what: string) => (error: unknown) => this.log.warn('live setting rejected', {what, err: error});
		if (patch.model !== undefined) q.setModel?.(patch.model ?? undefined).catch(fail('model'));
		if (patch.thinking !== undefined) q.setMaxThinkingTokens?.(patch.thinking === 'disabled' ? 0 : null).catch(fail('thinking'));
		const flags: Record<string, unknown> = {};
		if (patch.effort !== undefined) flags['effortLevel'] = patch.effort;
		if (patch.fastMode !== undefined) flags['fastMode'] = patch.fastMode ? true : null;
		if (patch.outputStyle !== undefined) flags['outputStyle'] = patch.outputStyle;
		if (Object.keys(flags).length > 0) q.applyFlagSettings?.(flags).catch(fail('flags'));
		this.log.info('live settings applied', {keys: Object.keys(patch)});
	}

	async applySandbox(sandbox: Record<string, unknown>): Promise<void> {
		const q = this.handle?.q;
		if (!q || this._state === 'closed') return;
		if (!q.applyFlagSettings) throw new Error('This run of Claude Code cannot change its sandbox');
		await q.applyFlagSettings({sandbox});
	}

	get usage(): ChatUsage {
		return {main: {...this.meter.total.main}, agents: {...this.meter.total.agents}};
	}

	get tasks(): readonly TaskInfo[] {
		return [...this._tasks.values()].reverse();
	}

	async stopTask(id: string): Promise<void> {
		const q = this.handle?.q;
		if (!q?.stopTask) throw new Error('Tasks cannot be stopped in this run of the chat');
		await q.stopTask(id);
	}

	async backgroundTasks(): Promise<boolean> {
		const q = this.handle?.q;
		if (!q?.backgroundTasks || this._state !== 'running') return false;
		return q.backgroundTasks();
	}

	async mcpStatus(): Promise<Array<{name: string; status: string; error?: string}> | undefined> {
		const q = this.handle?.q;
		return q?.mcpServerStatus ? q.mcpServerStatus() : undefined;
	}

	async reconnectMcp(name: string): Promise<void> {
		const q = this.handle?.q;
		if (!q?.reconnectMcpServer) throw new Error('Start the chat (send a message) before reconnecting MCP servers');
		await q.reconnectMcpServer(name);
	}

	async rewindFiles(userMessageId: string): Promise<RewindResult> {
		const q = this.handle?.q;
		if (!q?.rewindFiles) return {canRewind: false, error: 'no file checkpoints in this run of the chat'};
		return q.rewindFiles(userMessageId);
	}

	get title(): string | undefined {
		return this._title;
	}
	setTitle(title: string): void {
		if (this._state === 'closed' || title === '' || title === this._title) return;
		this._title = title;
		this.emit({type: 'title', title});
	}
	get commands(): readonly SlashCommandInfo[] {
		return this._commands;
	}
	get pendingPermissions(): readonly PermissionRequest[] {
		return this.queue.map(e => e.req);
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

		if (!this.lockHeld && this.opts.turnLock) {
			this.opts.turnLock.acquire();
			this.lockHeld = true;
		}
		this.clearIdleTimer();
		const warm = this.handle !== undefined;
		let handle: Handle;
		try {
			handle = this.handle ?? this.spawn();
		} catch (err) {
			this.settleIdle();
			throw err;
		}
		this.firstOutput = {at: Date.now(), warm};
		this.authFailed = false;
		this.turnError = undefined;
		this.pending = undefined;
		this.setState('running');
		this.turnStartedAt = Date.now();
		this.turnUsageFrom = this.usage;
		this.log.info('turn started', {chars: text.length});
		this.switches = 0;
		this.turnHandle = handle;
		this.armTurnTimer(this.timeoutMs);
		this.pushUser(handle, text, opts.command === true);
		this.emit({type: 'sent', text});
	}

	steer(text: string): void {
		const handle = this.handle;
		if (this._state !== 'running' || !handle || this.turnHandle !== handle) throw new Error('No request is running');
		if (this.pending) throw new Error('The request is being stopped');
		this.log.info('message steered', {chars: text.length});
		this.pushUser(handle, text, false, 'next');
		this.emit({type: 'sent', text});
	}

	private pushUser(handle: Handle, text: string, command: boolean, priority?: 'next'): void {
		handle.input.push({
			...(priority && {priority}),
			type: 'user',
			message: {role: 'user', content: text},
			parent_tool_use_id: null,
			uuid: randomUUID(),
			session_id: this._sessionId ?? '',
			origin: {kind: 'human'},
			...(!command && text.startsWith('/') && {client_composed: true as const}),
		});
	}

	private limitTurn(kind: FailureKind): void {
		const reason = kind === 'usage-limit' || kind === 'billing' ? kind : undefined;
		if (reason && this.opts.onUsageLimit && this.switches < MAX_SWITCHES && this._state === 'running' && !this.pending) {
			let next: {from: string; to: string} | undefined;
			try {
				next = this.opts.onUsageLimit({reason, ...(this._rateLimit !== undefined && {rateLimit: this._rateLimit})});
			} catch (err) {
				this.log.warn('account switch failed', {errClass: errClass(err)});
			}
			if (next) {
				this.switches++;
				this.dropHandle();
				this.clearTimers();
				this._rateLimit = undefined;
				this.turnError = undefined;
				this.authFailed = false;
				this.log.info('account switched', {reason, switches: this.switches});
				this.emit({type: 'account', account: next.to, previous: next.from, reason});
				let handle: Handle;
				try {
					handle = this.spawn();
				} catch (err) {
					this.endTurn('error', this.opts.redact(err instanceof Error ? err.message : String(err)));
					return;
				}
				this.turnHandle = handle;
				this.armTurnTimer(this.timeoutMs);
				this.pushUser(handle, CONTINUE_TEXT, false);
				return;
			}
		}
		this.endTurn(kind === 'context' ? 'context' : 'limit', this.failureText(kind), kind);
	}

	async interrupt(): Promise<void> {
		const handle = this.handle;
		if (this._state !== 'running' || !handle || this.pending) return;
		await this.abortTurn({outcome: 'interrupted'}, handle);
	}

	setMode(mode: ChatMode): void {
		if (this._state === 'closed') throw new Error('The chat is closed');
		if (!MODE_CYCLE.includes(mode)) throw new Error('Unknown permission mode');
		const previous = this._mode;
		this._mode = mode;
		this.log.info('permission mode set', {mode});
		this.emit({type: 'mode', mode});
		const handle = this.handle;
		if (!handle?.q.setPermissionMode || sdkPermissionMode(previous) === sdkPermissionMode(mode)) return;
		handle.q.setPermissionMode(sdkPermissionMode(mode)).catch((error: unknown) => {
			if (this._state === 'closed' || this._mode !== mode) return;
			this.log.warn('permission mode rejected', {mode, err: error});
			this._mode = 'default';
			this.emit({
				type: 'mode',
				mode: 'default',
				error: this.opts.redact(error instanceof Error ? error.message : String(error)),
			});
		});
	}

	answerPermission(id: string, decision: PermissionDecision): boolean {
		const entry = this.queue.find(e => e.req.id === id);
		if (!entry) return false;
		if (decision.kind === 'answers' && entry.req.kind !== 'question') return false;
		if (decision.kind === 'allow' && entry.req.kind !== 'tool') return false;
		this.settle(entry, decision);
		return true;
	}

	hasApproved(key: string): boolean {
		return this.approved.has(key) || this.saved.has(key);
	}

	forget(key: string): void {
		this.approved.delete(key);
		this.saved.delete(key);
	}

	remember(key: string): void {
		if (!this.saved.has(key)) {
			this.saved.add(key);
			this.opts.onRemember?.(key);
		}
		this.approved.delete(key);
		if (this.approved.size >= MAX_APPROVED) {
			const oldest = this.approved.values().next().value;
			if (oldest !== undefined) this.approved.delete(oldest);
		}
		this.approved.add(key);
	}

	audit(entry: AuditEntry): void {
		this.log.info('permission audit', {outcome: entry.outcome, tool: entry.toolName});
		this.emit({type: 'audit', entry: {...entry, summary: this.opts.redact(entry.summary)}});
	}

	request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> {
		const cancelNow = (cause: CancelCause): Promise<PermissionDecision> => {
			this.log.info('permission cancelled', {tool: toolNameOf(req), cause, queued: false});
			this.audit({outcome: 'cancelled', toolName: toolNameOf(req), summary: summaryOf(req)});
			return Promise.resolve({kind: 'cancel', cause});
		};
		if (this._state === 'closed') return cancelNow('closed');
		if (this.pending) return cancelNow('interrupted');
		if (signal.aborted) return cancelNow('aborted');
		if (this.queue.length >= MAX_QUEUE) return cancelNow('replaced');

		return new Promise<PermissionDecision>(resolve => {
			const idleTimer = setTimeout(() => {
				const e = this.queue.find(x => x.req.id === req.id);
				if (e) this.settle(e, {kind: 'cancel', cause: 'timeout'});
			}, PERMISSION_IDLE_MS);
			idleTimer.unref();
			const onAbort = () => {
				const e = this.queue.find(x => x.req.id === req.id);
				if (e) this.settle(e, {kind: 'cancel', cause: 'aborted'});
			};
			signal.addEventListener('abort', onAbort, {once: true});
			const entry: Entry = {
				req,
				resolve,
				handle: this.handle,
				idleTimer,
				detach: () => signal.removeEventListener('abort', onAbort),
				at: Date.now(),
			};
			this.queue.push(entry);
			this.log.info('permission requested', {tool: toolNameOf(req), kind: req.kind, queued: this.queue.length});
			if (this.queue.length === 1) this.permissionHold = this.holdTurnTimer();
			this.emit({type: 'permission-requested', request: req, pending: this.queue.length});
		});
	}

	reset(): void {
		if (this._state === 'closed') throw new Error('The chat is closed');
		if (this._state === 'running') throw new Error('Cannot start a new session while a request is running');
		this.dropHandle();
		this.approved.clear();
		if (this._mode !== 'default') {
			this._mode = 'default';
			this.emit({type: 'mode', mode: 'default'});
		}
		this._sessionId = undefined;
		this._model = undefined;
		this._costUsd = undefined;
		this._needsNewSession = false;
	}

	close(): void {
		if (this._state === 'closed') return;
		const wasRunning = this._state === 'running';
		this.clearIdleTimer();
		if (this.lockHeld) {
			this.lockHeld = false;
			this.opts.turnLock?.release();
		}
		this.cancelAll('closed');
		this.approved.clear();
		this.clearTimers();
		this.dropHandle();
		this.pending = undefined;
		this._state = 'closed';
		if (wasRunning) this.emit({type: 'turn-end', outcome: 'interrupted'});
		this.emit({type: 'state', state: 'closed'});
		this.listeners.clear();
	}

	private mergeCommands(list: SlashCommandInfo[]): void {
		const byName = new Map(this._commands.map(c => [c.name, c]));
		for (const c of list) {
			if (!isCommandName(c.name)) continue;
			byName.set(c.name, {...byName.get(c.name), ...c});
		}
		this._commands = [...byName.values()].slice(0, MAX_COMMANDS);
	}

	private fetchCommands(handle: Handle): void {
		const q = handle.q as {supportedCommands?: () => Promise<unknown>};
		if (typeof q.supportedCommands !== 'function') return;
		q.supportedCommands().then(
			list => {
				if (this.handle !== handle || !Array.isArray(list)) return;
				this.mergeCommands(
					list
						.filter((c): c is {name: string; description?: unknown; argumentHint?: unknown} => typeof c?.name === 'string')
						.map(c => ({
							name: c.name,
							...(typeof c.description === 'string' && {description: c.description}),
							...(typeof c.argumentHint === 'string' && c.argumentHint !== '' && {argumentHint: c.argumentHint}),
						})),
				);
			},
			(error: unknown) => this.log.debug('supported commands unavailable', {err: error}),
		);
	}

	private spawn(): Handle {
		const ac = new AbortController();
		const input = new InputQueue<SDKUserMessage>();
		this.log.info('sdk session spawned', {resuming: this._sessionId !== undefined});
		const options = this.opts.buildOptions(ac, this._sessionId, this);
		const q = this.opts.query({prompt: input, options});
		const handle: Handle = {q, input, ac};
		this.handle = handle;
		void this.pump(handle);
		this.fetchCommands(handle);
		return handle;
	}

	private beginCliTurn(handle: Handle): void {
		if (this._state !== 'idle' || this.handle !== handle) return;
		this.clearIdleTimer();
		if (!this.lockHeld && this.opts.turnLock) {
			try {
				this.opts.turnLock.acquire();
				this.lockHeld = true;
			} catch {
				this.log.warn('turn lock busy for a Claude Code turn');
			}
		}
		this.authFailed = false;
		this.turnError = undefined;
		this.pending = undefined;
		this.switches = 0;
		this.setState('running');
		this.turnStartedAt = Date.now();
		this.turnUsageFrom = this.usage;
		this.log.info('turn started', {origin: 'claude-code'});
		this.turnHandle = handle;
		this.armTurnTimer(this.timeoutMs);
	}

	private async pump(handle: Handle): Promise<void> {
		try {
			for await (const msg of handle.q) {
				if (this.handle !== handle) return;
				this.meter.add(msg);
				this.keepTurnAlive(handle);
				for (const ev of normalize(msg, this.clock)) {
					if (this.handle !== handle) return;
					this.onUi(ev, handle);
				}
			}
		} catch (err) {
			if (this.handle !== handle) return;
			this.log.warn('sdk stream threw', {errClass: errClass(err)});
			this.dropHandle();
			const raw = err instanceof Error ? err.message : String(err);
			this.failTurn(
				this.authFailed ? AUTH_MESSAGE : mapFailure(raw, this.opts.redact).message,
				this.authFailed ? undefined : this.classifyTurn(raw),
			);
			return;
		}
		if (this.handle !== handle) return;
		this.log.warn('sdk stream ended unexpectedly', {authFailed: this.authFailed});
		this.dropHandle();
		this.failTurn(
			this.authFailed ? AUTH_MESSAGE : 'Claude request failed: the session ended unexpectedly',
			this.authFailed ? undefined : this.classifyTurn(undefined),
		);
	}

	private onUi(event: UiEvent, handle: Handle): void {
		let ev = event;
		if (ev.kind === 'cli-state' && ev.state === 'running') this.beginCliTurn(handle);
		if (this.firstOutput && FIRST_OUTPUT.has(ev.kind)) {
			this.log.info('first output', {ms: Date.now() - this.firstOutput.at, warm: this.firstOutput.warm});
			this.firstOutput = undefined;
		}
		if (ev.kind === 'session') {
			this._sessionId = ev.sessionId;
			this._model = ev.model ?? this._model;
			if (ev.slashCommands) this.mergeCommands(ev.slashCommands.map(name => ({name})));
		} else if (ev.kind === 'api-error' && ev.code === 'authentication_failed') {
			if (!this.authFailed) this.log.warn('authentication failed');
			this.authFailed = true;
		}
		if (ev.kind === 'api-error') this.turnError = {code: ev.code, ...(ev.detail !== undefined && {detail: ev.detail})};
		if (ev.kind === 'rate-limit') this.noteRateLimit(ev.info);
		if (ev.kind === 'task') {
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
			const t = this._tasks.get(ev.id)!;
			if (ev.status !== 'running') queueMicrotask(() => this.settleIdle());
			ev = {...ev, background: t.background, description: t.description};
		}
		if (ev.kind === 'result' && ev.sessionId) this._sessionId = ev.sessionId;
		if (ev.kind === 'result' && ev.costUsd !== undefined) this._costUsd = ev.costUsd;
		this.emit({type: 'ui', event: ev});
		if (ev.kind === 'result') this.onResult(ev, handle);
	}

	private onResult(ev: Extract<UiEvent, {kind: 'result'}>, handle: Handle): void {
		if (this._state !== 'running') return;
		if (this.pending) {
			const {outcome, error} = this.pending;
			this.endTurn(outcome, error);
			return;
		}
		if (ev.ok && !this.authFailed) {
			if (ev.queuedTurns !== undefined && ev.queuedTurns > 0) {
				this.log.info('turn continues', {queued: ev.queuedTurns});
				return;
			}
			this.endTurn('ok');
			return;
		}
		if (ev.subtype === 'error_max_turns') {
			this.recycle(handle);
			this.endTurn('max-turns', MAX_TURNS_MESSAGE);
			return;
		}
		const detail = ev.text || (ev.errors ?? []).join('; ') || ev.subtype;
		if (!this.authFailed) {
			const kind = this.classifyTurn(detail, ev.terminalReason);
			if (kind) {
				this.limitTurn(kind);
				return;
			}
		}
		const failure = this.authFailed ? new Error(AUTH_MESSAGE) : mapFailure(detail, this.opts.redact);
		if (failure.message === RESUME_MESSAGE) {
			this._needsNewSession = true;
			this.recycle(handle);
		}
		this.endTurn('error', failure.message);
	}

	private classifyTurn(detail: string | undefined, terminalReason?: string): FailureKind | undefined {
		const cliDetail = this.turnError?.detail ?? detail;
		return classifyFailure({
			...(this.turnError !== undefined && {code: this.turnError.code}),
			...(terminalReason !== undefined && {terminalReason}),
			...(cliDetail !== undefined && {detail: cliDetail}),
			...(this._rateLimit !== undefined && {rateLimit: this._rateLimit}),
		});
	}

	private failureText(kind: FailureKind): string {
		const cliText = this.turnError?.detail;
		return failureMessage(kind, {
			...(this._rateLimit !== undefined && {rateLimit: this._rateLimit}),
			...(cliText !== undefined && {cliText}),
			surface: 'chat',
			clock: this.clock,
		});
	}

	private noteRateLimit(info: RateLimitInfo): void {
		const prev = this._rateLimit;
		this._rateLimit = info;
		const fields = {
			status: info.status,
			...(info.type !== undefined && {type: info.type}),
			...(info.utilization !== undefined && {pct: Math.round(info.utilization * 100)}),
			...(info.resetsAt !== undefined && {resetsInMin: Math.max(0, Math.round((info.resetsAt * 1000 - this.clock.now()) / 60_000))}),
		};
		if (prev?.status !== info.status || prev?.type !== info.type) this.log.info('rate limit', fields);
		else if (prev.utilization !== info.utilization) this.log.debug('rate limit', fields);
	}

	private failTurn(message: string, kind?: FailureKind): void {
		if (this._state !== 'running') return;
		if (this.pending) this.endTurn(this.pending.outcome, this.pending.error);
		else if (kind) this.limitTurn(kind);
		else this.endTurn('error', this.opts.redact(message));
	}

	private async abortTurn(p: Pending, handle: Handle): Promise<void> {
		if (this._state !== 'running' || this.pending || this.handle !== handle) return;
		this.pending = p;
		this.log.info('turn aborting', {outcome: p.outcome});
		this.cancelAll('interrupted');
		if (this.turnTimer) clearTimeout(this.turnTimer);
		this.turnTimer = undefined;
		this.turnRemaining = undefined;
		this.graceTimer = setTimeout(() => {
			this.graceTimer = undefined;
			if (this._state !== 'running' || this.handle !== handle) return;
			this.log.warn('interrupt grace expired; recycling', {graceMs: this.graceMs});
			this.recycle(handle);
			this.endTurn(p.outcome, p.error);
		}, this.graceMs);
		this.graceTimer.unref();
		try {
			if (handle.q.interrupt) await handle.q.interrupt();
			else {
				this.recycle(handle);
				this.endTurn(p.outcome, p.error);
			}
		} catch {
		}
	}

	private endTurn(outcome: TurnOutcome, error?: string, failure?: FailureKind): void {
		if (this._state !== 'running') return;
		this.firstOutput = undefined;
		this.clearTimers();
		this.pending = undefined;
		this.setState('idle');
		const from = this.turnUsageFrom;
		this.turnUsageFrom = undefined;
		const main = from ? subtract(this.meter.total.main, from.main) : undefined;
		const agents = from ? subtract(this.meter.total.agents, from.agents) : undefined;
		this.log.info('turn ended', {
			outcome,
			ms: Date.now() - this.turnStartedAt,
			...(main && main.calls > 0 && {calls: main.calls, cacheWrite: main.cacheWrite, cacheRead: main.cacheRead, output: main.output}),
			...(agents &&
				agents.calls > 0 && {agentCalls: agents.calls, agentCacheWrite: agents.cacheWrite, agentCacheRead: agents.cacheRead, agentOutput: agents.output}),
			...(failure !== undefined && {failure}),
			...(error !== undefined && failure === undefined && {reason: clip(this.opts.redact(error))}),
		});
		this.emit({type: 'turn-end', outcome, ...(error !== undefined && {error})});
		this.settleIdle();
	}

	private hasRunningTasks(): boolean {
		for (const t of this._tasks.values()) if (t.status === 'running') return true;
		return false;
	}

	private settleIdle(): void {
		if (this._state !== 'idle' || this.hasRunningTasks()) return;
		if (this.lockHeld) {
			this.lockHeld = false;
			this.opts.turnLock?.release();
		}
		if (this.opts.idleCloseMs === undefined || !this.handle || this.idleTimer) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			if (this._state !== 'idle' || this.hasRunningTasks() || !this.handle) return;
			this.log.info('sdk session closed while idle');
			this.dropHandle();
		}, this.opts.idleCloseMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private recycle(handle: Handle): void {
		if (this.handle !== handle) return;
		this.log.warn('session recycled');
		this.dropHandle();
	}

	private dropHandle(): void {
		const h = this.handle;
		this.handle = undefined;
		if (!h) return;
		this.cancelAll('replaced', h);
		try {
			h.input.close();
		} catch {
		}
		h.ac.abort();
		try {
			h.q.close?.();
		} catch {
		}
	}

	private clearTimers(): void {
		if (this.turnTimer) clearTimeout(this.turnTimer);
		if (this.graceTimer) clearTimeout(this.graceTimer);
		this.turnTimer = undefined;
		this.graceTimer = undefined;
		this.turnRemaining = undefined;
		this.holds = 0;
		this.holdEpoch++;
		this.permissionHold = undefined;
	}

	holdTurnTimer(): () => void {
		const epoch = this.holdEpoch;
		let released = false;
		if (++this.holds === 1) this.pauseTurnTimer();
		return () => {
			if (released || epoch !== this.holdEpoch) return;
			released = true;
			if (--this.holds === 0) this.resumeTurnTimer();
		};
	}

	private armTurnTimer(ms: number): void {
		const handle = this.turnHandle;
		if (!handle) return;
		this.turnDeadline = Date.now() + ms;
		this.turnTimer = setTimeout(
			() =>
				this.abortTurn(
					{outcome: 'timeout', error: `Request timed out: no activity for ${Math.round(this.timeoutMs / 1000)} seconds`},
					handle,
				),
			ms,
		);
		this.turnTimer.unref();
	}

	private keepTurnAlive(handle: Handle): void {
		if (!this.turnTimer || this.turnHandle !== handle || this._state !== 'running') return;
		clearTimeout(this.turnTimer);
		this.turnTimer = undefined;
		this.armTurnTimer(this.timeoutMs);
	}

	private pauseTurnTimer(): void {
		if (!this.turnTimer) return;
		clearTimeout(this.turnTimer);
		this.turnTimer = undefined;
		this.turnRemaining = Math.max(1, this.turnDeadline - Date.now());
	}

	private resumeTurnTimer(): void {
		const remaining = this.turnRemaining;
		this.turnRemaining = undefined;
		if (remaining === undefined || this._state !== 'running' || this.pending || this.turnTimer) return;
		this.armTurnTimer(remaining);
	}

	private settle(entry: Entry, decision: PermissionDecision): void {
		const i = this.queue.indexOf(entry);
		if (i < 0) return;
		this.queue.splice(i, 1);
		clearTimeout(entry.idleTimer);
		entry.detach();
		const tool = toolNameOf(entry.req);
		this.log.info('permission resolved', {
			tool,
			kind: entry.req.kind,
			decision: decision.kind,
			...(decision.kind === 'allow' && {always: decision.always === true}),
			...(decision.kind === 'cancel' && {cause: decision.cause}),
			ms: Date.now() - entry.at,
		});
		this.emit({type: 'permission-resolved', id: entry.req.id, pending: this.queue.length});
		this.audit({outcome: outcomeOf(entry.req, decision), toolName: tool, summary: summaryOf(entry.req)});
		if (this.queue.length === 0) {
			const release = this.permissionHold;
			this.permissionHold = undefined;
			release?.();
		}
		entry.resolve(decision);
	}

	private cancelAll(cause: CancelCause, handle?: Handle): void {
		for (const entry of [...this.queue]) {
			if (handle && entry.handle !== handle) continue;
			this.settle(entry, {kind: 'cancel', cause});
		}
	}

	private setState(state: ChatState): void {
		this._state = state;
		this.emit({type: 'state', state});
	}

	private emit(e: ChatEvent): void {
		for (const cb of [...this.listeners]) {
			try {
				cb(e);
			} catch {
			}
		}
	}
}
