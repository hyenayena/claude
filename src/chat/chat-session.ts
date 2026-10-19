import {randomUUID} from 'node:crypto';
import type {Options, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../../src/api.js';
import {clip, errClass, noopLog} from '../log.js';
import {AUTH_MESSAGE, mapFailure, RESUME_MESSAGE} from '../session.js';
import type {LivePatch} from '../chat-prefs.js';
import type {ChatQueryFn} from '../types.js';
import type {ChatController, ChatEvent, ChatState, TurnOutcome, UiEvent} from './events.js';
import {InputQueue} from './input-queue.js';
import {normalize} from './normalize.js';
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

export const MAX_TURNS_MESSAGE = 'Reached the maximum number of turns for one request';

export type ChatSessionOptions = {
	query: ChatQueryFn;
	buildOptions: (abortController: AbortController, resume: string | undefined, prompter: PermissionPrompter) => Options;
	redact: (s: string) => string;
	timeoutMs?: number;
	graceMs?: number;
	initialResume?: string;
	initialMode?: ChatMode;
	log?: Logger;
};

export type SlashCommandInfo = {name: string; description?: string; argumentHint?: string};

const MAX_COMMANDS = 300;
export const isCommandName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(name);

type Handle = {
	q: ReturnType<ChatQueryFn>;
	input: InputQueue<SDKUserMessage>;
	ac: AbortController;
};

type Pending = {outcome: TurnOutcome; error?: string};

type Entry = {
	req: PermissionRequest;
	resolve: (d: PermissionDecision) => void;
	handle: Handle | undefined;
	idleTimer: NodeJS.Timeout;
	detach: () => void;
	at: number;
};

const MAX_APPROVED = 100;
const AUDIT_SUMMARY_MAX = 100;

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
	const flat = raw.replace(/\s+/g, ' ').trim();
	return flat.length > AUDIT_SUMMARY_MAX ? `${flat.slice(0, AUDIT_SUMMARY_MAX)}…` : flat;
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
	private pending: Pending | undefined;
	private turnTimer: NodeJS.Timeout | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private turnStartedAt = 0;
	private turnHandle: Handle | undefined;
	private turnDeadline = 0;
	private turnRemaining: number | undefined;
	private _mode: ChatMode = 'default';
	private _commands: SlashCommandInfo[] = [];
	private _title: string | undefined;
	private readonly queue: Entry[] = [];
	private readonly approved = new Set<string>();

	constructor(opts: ChatSessionOptions) {
		this.opts = opts;
		this.timeoutMs = opts.timeoutMs ?? 300_000;
		this.graceMs = opts.graceMs ?? 8_000;
		this.log = opts.log ?? noopLog;
		this._sessionId = opts.initialResume;
		if (opts.initialMode && MODE_CYCLE.includes(opts.initialMode)) this._mode = opts.initialMode;
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
	/** Cumulative cost reported by the latest result; replaced, never summed. */
	get costUsd(): number | undefined {
		return this._costUsd;
	}

	get mode(): ChatMode {
		return this._mode;
	}
	/** Applies model, effort, thinking, fast mode or output style to the running query; a new query gets them from its options. */
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

	/** The chat's name: Claude Code's session title, or a stand-in until it exists. */
	get title(): string | undefined {
		return this._title;
	}
	setTitle(title: string): void {
		if (this._state === 'closed' || title === '' || title === this._title) return;
		this._title = title;
		this.emit({type: 'title', title});
	}
	/** Claude Code commands of this session (names without the slash), known once a query has started. */
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

		const handle = this.handle ?? this.spawn();
		this.authFailed = false;
		this.pending = undefined;
		this.setState('running');
		this.turnStartedAt = Date.now();
		this.log.info('turn started', {chars: text.length});
		this.turnHandle = handle;
		this.armTurnTimer(this.timeoutMs);
		handle.input.push({
			type: 'user',
			message: {role: 'user', content: text},
			parent_tool_use_id: null,
			uuid: randomUUID(),
			session_id: this._sessionId ?? '',
			origin: {kind: 'human'},
			// Typed text that starts with "/" is a message, not a command; commands come from the console.
			...(!opts.command && text.startsWith('/') && {client_composed: true as const}),
		});
		this.emit({type: 'sent', text});
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
		// A query that is already running learns the change here; a new one gets it in its options.
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
		return this.approved.has(key);
	}

	remember(key: string): void {
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
			if (this.queue.length === 1) this.pauseTurnTimer();
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

	private async pump(handle: Handle): Promise<void> {
		try {
			for await (const msg of handle.q) {
				if (this.handle !== handle) return;
				this.keepTurnAlive(handle);
				for (const ev of normalize(msg)) {
					if (this.handle !== handle) return;
					this.onUi(ev, handle);
				}
			}
		} catch (err) {
			if (this.handle !== handle) return;
			this.log.warn('sdk stream threw', {errClass: errClass(err)});
			this.dropHandle();
			this.failTurn(
				this.authFailed ? AUTH_MESSAGE : mapFailure(err instanceof Error ? err.message : String(err), this.opts.redact).message,
			);
			return;
		}
		if (this.handle !== handle) return;
		this.log.warn('sdk stream ended unexpectedly', {authFailed: this.authFailed});
		this.dropHandle();
		this.failTurn(this.authFailed ? AUTH_MESSAGE : 'Claude request failed: the session ended unexpectedly');
	}

	private onUi(ev: UiEvent, handle: Handle): void {
		if (ev.kind === 'session') {
			this._sessionId = ev.sessionId;
			this._model = ev.model ?? this._model;
			if (ev.slashCommands) this.mergeCommands(ev.slashCommands.map(name => ({name})));
		} else if (ev.kind === 'api-error' && ev.code === 'authentication_failed') {
			if (!this.authFailed) this.log.warn('authentication failed');
			this.authFailed = true;
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
			this.endTurn('ok');
			return;
		}
		if (ev.subtype === 'error_max_turns') {
			this.recycle(handle);
			this.endTurn('max-turns', MAX_TURNS_MESSAGE);
			return;
		}
		const detail = ev.text || (ev.errors ?? []).join('; ') || ev.subtype;
		const failure = this.authFailed ? new Error(AUTH_MESSAGE) : mapFailure(detail, this.opts.redact);
		if (failure.message === RESUME_MESSAGE) {
			this._needsNewSession = true;
			this.recycle(handle);
		}
		this.endTurn('error', failure.message);
	}

	private failTurn(message: string): void {
		if (this._state !== 'running') return;
		if (this.pending) this.endTurn(this.pending.outcome, this.pending.error);
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
		// Armed before the await so a hung interrupt() cannot stall the turn.
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
			// a failed interrupt falls through to the grace recycle
		}
	}

	private endTurn(outcome: TurnOutcome, error?: string): void {
		if (this._state !== 'running') return;
		this.clearTimers();
		this.pending = undefined;
		this.setState('idle');
		this.log.info('turn ended', {
			outcome,
			ms: Date.now() - this.turnStartedAt,
			...(error !== undefined && {reason: clip(this.opts.redact(error))}),
		});
		this.emit({type: 'turn-end', outcome, ...(error !== undefined && {error})});
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
			// already closed
		}
		h.ac.abort();
		try {
			h.q.close?.();
		} catch {
			// already closed
		}
	}

	private clearTimers(): void {
		if (this.turnTimer) clearTimeout(this.turnTimer);
		if (this.graceTimer) clearTimeout(this.graceTimer);
		this.turnTimer = undefined;
		this.graceTimer = undefined;
		this.turnRemaining = undefined;
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

	// The timeout counts silence, not total time: any SDK message (subagents included) restarts it,
	// so long pipelines keep going while a hung request still ends.
	private keepTurnAlive(handle: Handle): void {
		if (!this.turnTimer || this.turnHandle !== handle || this._state !== 'running') return;
		clearTimeout(this.turnTimer);
		this.turnTimer = undefined;
		this.armTurnTimer(this.timeoutMs);
	}

	// Human waiting time must not count against the turn timeout.
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
		if (this.queue.length === 0) this.resumeTurnTimer();
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
				// a faulty subscriber must not break the engine
			}
		}
	}
}
