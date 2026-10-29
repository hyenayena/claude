import type {ChatEvent, ToolPatch, TurnOutcome, UiEvent} from '../chat/events.js';
import type {RateLimitInfo} from '../chat/limits.js';
import type {AuditEntry, ChatMode} from '../chat/permission.js';

export const LIVE = {
	maxRawChars: 2_000_000,
	tailChars: 16_000,
	maxTools: 4,
	maxInputRows: 10,
	maxTodoRows: 8,
	minTailRows: 3,
	maxTailRows: 30,
	collapsedResultLines: 3,
} as const;

export type Phase = 'idle' | 'running' | 'interrupting';

export interface RunningTool {
	id: string;
	name: string;
	input: unknown;
	elapsedSeconds: number;
	// For an Agent call: the subagent's latest tool call.
	activity?: {name: string; input: unknown};
}

export type StatusLine =
	// tokens: Claude Code's estimate of the thinking so far.
	| {kind: 'thinking'; tokens?: number}
	// Claude is writing the input of a tool call; chars of JSON so far.
	| {kind: 'tool-input'; name: string; chars: number}
	| {kind: 'compacting'}
	| {kind: 'retry'; attempt: number; maxRetries: number; delayMs: number}
	| null;

export type Todo = {content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string};

const MAX_TODOS = 50;

/** The checklist from a TodoWrite call; malformed items are dropped. */
export function parseTodos(input: unknown): Todo[] {
	const list = (input as {todos?: unknown} | null)?.todos;
	if (!Array.isArray(list)) return [];
	const out: Todo[] = [];
	for (const raw of list.slice(0, MAX_TODOS)) {
		const t = raw as {content?: unknown; status?: unknown; activeForm?: unknown} | null;
		if (!t || typeof t.content !== 'string' || t.content.trim() === '') continue;
		const status = t.status === 'in_progress' || t.status === 'completed' ? t.status : 'pending';
		out.push({content: t.content, status, ...(typeof t.activeForm === 'string' && t.activeForm && {activeForm: t.activeForm})});
	}
	return out;
}

export interface TranscriptState {
	// Claude's checklist (TodoWrite), shown while something on it is open.
	todos: Todo[];
	phase: Phase;
	liveRaw: string;
	tools: Map<string, RunningTool>;
	status: StatusLine;
	model: string | undefined;
	sessionId: string | undefined;
	costUsd: number | undefined;
	notice: string | undefined;
	turnPrintedText: boolean;
	pending: number;
	mode: ChatMode;
	approvals: number;
	// Latest rate-limit report; the status bar derives its indicator from it.
	limit?: RateLimitInfo;
	// Held until the turn ends: a limit or context outcome already says it all.
	pendingApiError?: string;
	// The account the chat runs on: the one it started with, then the one it switched to after a limit.
	account?: string;
}

// Raw (unscrubbed) items; present.ts turns them into display strings.
export type Out =
	| {kind: 'assistant'; text: string; interrupted: boolean}
	| {kind: 'tool'; name: string; input: unknown; isError: boolean; text: string; patch?: ToolPatch}
	| {kind: 'error'; message: string}
	| {kind: 'api-error'; code: string}
	| {kind: 'outcome'; outcome: Exclude<TurnOutcome, 'ok'>; error?: string}
	| {kind: 'audit'; entry: AuditEntry}
	| {kind: 'mode'; mode: ChatMode; error?: string}
	| {kind: 'account'; account: string; previous: string; reason: 'usage-limit' | 'billing'}
	| {kind: 'thinking'; text: string}
	| {kind: 'task'; status: string; description: string; summary?: string}
	| {kind: 'blank'};

export interface Step {
	state: TranscriptState;
	out: Out[];
}

export function initialTranscript(
	init: {model?: string; sessionId?: string; mode?: ChatMode; pending?: number; account?: string} = {},
): TranscriptState {
	return {
		...(init.account !== undefined && {account: init.account}),
		todos: [],
		phase: 'idle',
		liveRaw: '',
		tools: new Map(),
		status: null,
		model: init.model,
		sessionId: init.sessionId,
		costUsd: undefined,
		notice: undefined,
		turnPrintedText: false,
		pending: init.pending ?? 0,
		mode: init.mode ?? 'default',
		approvals: 0,
	};
}

export function markInterrupting(state: TranscriptState): TranscriptState {
	return state.phase === 'running' ? {...state, phase: 'interrupting'} : state;
}

export function setNotice(state: TranscriptState, notice: string | undefined): TranscriptState {
	return {...state, notice};
}

export function resetTranscript(state: TranscriptState): TranscriptState {
	return {
		...initialTranscript({model: state.model, mode: state.mode, ...(state.account !== undefined && {account: state.account})}),
		phase: state.phase,
		...(state.limit !== undefined && {limit: state.limit}),
	};
}

function flushPartial(state: TranscriptState): Step {
	if (state.liveRaw.trim() === '') return {state: {...state, liveRaw: ''}, out: []};
	return {
		state: {...state, liveRaw: '', turnPrintedText: true},
		out: [{kind: 'assistant', text: state.liveRaw, interrupted: true}],
	};
}

function reduceUi(state: TranscriptState, e: UiEvent): Step {
	switch (e.kind) {
		case 'session':
			return {
				state: {...state, sessionId: e.sessionId, model: e.model ?? state.model},
				out: [],
			};
		case 'text-delta': {
			let liveRaw = state.liveRaw + e.text;
			if (liveRaw.length > LIVE.maxRawChars) liveRaw = liveRaw.slice(-LIVE.maxRawChars);
			return {state: {...state, liveRaw, status: null}, out: []};
		}
		case 'text':
			return {
				state: {...state, liveRaw: '', status: null, turnPrintedText: true},
				out: [{kind: 'assistant', text: e.text, interrupted: e.aborted === true}],
			};
		case 'thinking':
			return {state: {...state, status: state.status?.kind === 'thinking' ? state.status : {kind: 'thinking'}}, out: []};
		case 'thinking-tokens':
			return {state: {...state, status: {kind: 'thinking', tokens: e.tokens}}, out: []};
		case 'tool-input':
			return {state: {...state, status: {kind: 'tool-input', name: e.name, chars: 0}}, out: []};
		case 'tool-input-delta':
			if (state.status?.kind !== 'tool-input') return {state, out: []};
			return {state: {...state, status: {...state.status, chars: state.status.chars + e.chars}}, out: []};
		case 'cli-state':
			return {state, out: []};
		case 'task':
			// A background task reports once, when it settles; foreground ones show as their tool call.
			// A new state object either way: the status bar counts tasks and must render again.
			if (e.status === 'running' || !e.background) return {state: {...state}, out: []};
			return {state: {...state}, out: [{kind: 'task', status: e.status, description: e.description ?? 'task', ...(e.summary !== undefined && {summary: e.summary})}]};
		case 'thinking-text':
			return {state, out: [{kind: 'thinking', text: e.text}]};
		case 'tool-use': {
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {id: e.toolUseId, name: e.name, input: e.input, elapsedSeconds: 0});
			const todos = e.name === 'TodoWrite' ? parseTodos(e.input) : state.todos;
			return {state: {...state, tools, todos, status: null}, out: []};
		}
		case 'agent-activity': {
			const tool = state.tools.get(e.toolUseId);
			if (!tool) return {state, out: []};
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {...tool, activity: {name: e.name, input: e.input}});
			return {state: {...state, tools}, out: []};
		}
		case 'tool-progress': {
			const tool = state.tools.get(e.toolUseId);
			if (!tool) return {state, out: []};
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {...tool, elapsedSeconds: e.elapsedSeconds});
			return {state: {...state, tools}, out: []};
		}
		case 'tool-result': {
			const tool = state.tools.get(e.toolUseId);
			const tools = new Map(state.tools);
			tools.delete(e.toolUseId);
			return {
				state: {...state, tools},
				out: [
					{
						kind: 'tool',
						name: tool?.name ?? 'tool',
						input: tool?.input,
						isError: e.isError,
						text: e.text,
						...(e.patch !== undefined && {patch: e.patch}),
					},
				],
			};
		}
		case 'status':
			return {
				state: {...state, status: e.status === 'compacting' ? {kind: 'compacting'} : null},
				out: [],
			};
		case 'retry':
			return {
				state: {
					...state,
					status: {kind: 'retry', attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs},
				},
				out: [],
			};
		case 'api-error':
			return {state: {...state, pendingApiError: e.code}, out: []};
		case 'rate-limit':
			return {state: {...state, limit: e.info}, out: []};
		case 'result': {
			const costUsd = typeof e.costUsd === 'number' ? e.costUsd : state.costUsd;
			return flushPartial({...state, costUsd, status: null});
		}
	}
}

export function reduceTranscript(state: TranscriptState, event: ChatEvent): Step {
	switch (event.type) {
		case 'ui':
			return reduceUi(state, event.event);
		case 'state':
			if (event.state === 'running') {
				return {state: state.phase === 'idle' ? {...state, phase: 'running'} : state, out: []};
			}
			if (event.state === 'idle') {
				const flushed = flushPartial(state);
				return {
					state: {...flushed.state, phase: 'idle', tools: new Map(), status: null},
					out: flushed.out,
				};
			}
			return {state, out: []};
		case 'turn-end': {
			const flushed = flushPartial(state);
			const out: Out[] = [...flushed.out];
			const quiet = event.outcome === 'limit' || event.outcome === 'context';
			if (state.pendingApiError !== undefined && !quiet) out.push({kind: 'api-error', code: state.pendingApiError});
			if (event.outcome !== 'ok') {
				out.push({kind: 'outcome', outcome: event.outcome, error: event.error});
			}
			if (flushed.state.turnPrintedText || event.outcome !== 'ok') out.push({kind: 'blank'});
			return {
				state: {
					...flushed.state,
					tools: new Map(),
					status: null,
					turnPrintedText: false,
					approvals: 0,
					pendingApiError: undefined,
				},
				out,
			};
		}
		case 'permission-requested':
			return {
				state: {
					...state,
					pending: event.pending,
					approvals: event.request.kind === 'tool' ? state.approvals + 1 : state.approvals,
				},
				out: [],
			};
		case 'permission-resolved':
			return {state: {...state, pending: event.pending}, out: []};
		case 'audit':
			return {state, out: [{kind: 'audit', entry: event.entry}]};
		case 'sent':
		case 'steer-failed':
		case 'title':
			return {state, out: []};
		case 'account':
			return {
				// The limit error that caused the switch is answered by this notice; the turn goes on.
				state: {...state, account: event.account, limit: undefined, pendingApiError: undefined},
				out: [{kind: 'account', account: event.account, previous: event.previous, reason: event.reason}],
			};
		case 'mode':
			if (event.mode === state.mode && !event.error) return {state, out: []};
			return {
				state: {...state, mode: event.mode},
				out: [{kind: 'mode', mode: event.mode, ...(event.error !== undefined && {error: event.error})}],
			};
	}
}
