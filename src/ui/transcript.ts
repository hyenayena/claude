import type {ChatEvent, TurnOutcome, UiEvent} from '../chat/events.js';
import type {AuditEntry, ChatMode} from '../chat/permission.js';

export const LIVE = {
	maxRawChars: 2_000_000,
	tailChars: 16_000,
	maxTools: 4,
	maxInputRows: 5,
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
	| {kind: 'thinking'}
	| {kind: 'compacting'}
	| {kind: 'retry'; attempt: number; maxRetries: number; delayMs: number}
	| null;

export interface TranscriptState {
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
}

// Raw (unscrubbed) items; present.ts turns them into display strings.
export type Out =
	| {kind: 'assistant'; text: string; interrupted: boolean}
	| {kind: 'tool'; name: string; input: unknown; isError: boolean; text: string}
	| {kind: 'error'; message: string}
	| {kind: 'api-error'; code: string}
	| {kind: 'outcome'; outcome: Exclude<TurnOutcome, 'ok'>; error?: string}
	| {kind: 'audit'; entry: AuditEntry}
	| {kind: 'mode'; mode: ChatMode; error?: string}
	| {kind: 'blank'};

export interface Step {
	state: TranscriptState;
	out: Out[];
}

export function initialTranscript(
	init: {model?: string; sessionId?: string; mode?: ChatMode; pending?: number} = {},
): TranscriptState {
	return {
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
	return {...initialTranscript({model: state.model, mode: state.mode}), phase: state.phase};
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
			return {state: {...state, status: {kind: 'thinking'}}, out: []};
		case 'tool-use': {
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {id: e.toolUseId, name: e.name, input: e.input, elapsedSeconds: 0});
			return {state: {...state, tools, status: null}, out: []};
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
			return {state, out: [{kind: 'api-error', code: e.code}]};
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
			if (event.outcome !== 'ok') {
				out.push({kind: 'outcome', outcome: event.outcome, error: event.error});
			}
			if (flushed.state.turnPrintedText || event.outcome !== 'ok') out.push({kind: 'blank'});
			return {
				state: {...flushed.state, tools: new Map(), status: null, turnPrintedText: false, approvals: 0},
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
		case 'title':
			return {state, out: []};
		case 'mode':
			if (event.mode === state.mode && !event.error) return {state, out: []};
			return {
				state: {...state, mode: event.mode},
				out: [{kind: 'mode', mode: event.mode, ...(event.error !== undefined && {error: event.error})}],
			};
	}
}
