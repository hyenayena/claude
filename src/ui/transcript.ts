import type {AccountReason, ChatEvent, RouteInfo, ToolPatch, TurnOutcome, UiEvent} from '../deps/chat.js';
import type {RateLimitInfo} from '../deps/chat.js';
import {PLAN_TOOLS, planChanges, type PlanItem, type PlanNote} from '../deps/chat.js';
import type {AuditEntry, ChatMode} from '../deps/chat.js';
import type {Tier} from '../deps/chat.js';
import type {TurnSummary} from '../deps/chat.js';
import {isFoldable} from './tool-kind.js';
import {showSummary} from './turn-summary.js';

export const LIVE = {
	maxRawChars: 2_000_000,
	tailChars: 16_000,
	maxTools: 4,
	maxInputRows: 10,
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
	startedAt?: number;
	activity?: {name: string; input: unknown};
}

export type StatusLine =
	| {kind: 'thinking'; tokens?: number}
	| {kind: 'tool-input'; name: string; chars: number}
	| {kind: 'compacting'}
	| {kind: 'retry'; attempt: number; maxRetries: number; delayMs: number}
	| null;

export interface TranscriptState {
	plan: PlanItem[];
	planTouched: boolean;
	planStale: boolean;
	phase: Phase;
	liveRaw: string;
	tools: Map<string, RunningTool>;
	fold: ToolOut[];
	status: StatusLine;
	model: string | undefined;
	sessionId: string | undefined;
	costUsd: number | undefined;
	notice: string | undefined;
	turnPrintedText: boolean;
	pending: number;
	mode: ChatMode;
	approvals: number;
	limit?: RateLimitInfo;
	pendingApiError?: string;
	account?: string;
	lastSummary?: TurnSummary;
}

export type ToolOut = {
	kind: 'tool';
	name: string;
	input: unknown;
	isError: boolean;
	text: string;
	patch?: ToolPatch;
	durationMs?: number;
	startedAt?: number;
};

export type Out =
	| {kind: 'assistant'; text: string; interrupted: boolean}
	| ToolOut
	| {kind: 'tool-group'; items: ToolOut[]}
	| {kind: 'error'; message: string}
	| {kind: 'api-error'; code: string}
	| {kind: 'outcome'; outcome: Exclude<TurnOutcome, 'ok'>; error?: string}
	| {kind: 'turn-summary'; summary: TurnSummary; outcome: TurnOutcome}
	| {kind: 'audit'; entry: AuditEntry}
	| {kind: 'mode'; mode: ChatMode; error?: string}
	| {kind: 'account'; account: string; previous: string; reason: AccountReason}
	| {kind: 'thinking'; text: string; durationMs?: number}
	| {kind: 'task'; status: string; description: string; summary?: string}
	| {kind: 'plan-note'; notes: PlanNote[]}
	| {kind: 'route-block'; route: RouteInfo; previous?: Tier}
	| {kind: 'route'; pinned?: Tier}
	| {kind: 'blank'};

export const ROUTE_TOOL_ID = 'yena-route';
export const ROUTE_TOOL_NAME = 'Routing';

export interface Step {
	state: TranscriptState;
	out: Out[];
}

export function initialTranscript(
	init: {model?: string; sessionId?: string; mode?: ChatMode; pending?: number; account?: string; plan?: readonly PlanItem[]} = {},
): TranscriptState {
	return {
		...(init.account !== undefined && {account: init.account}),
		plan: init.plan ? init.plan.map(i => ({...i})) : [],
		planTouched: false,
		planStale: false,
		phase: 'idle',
		liveRaw: '',
		tools: new Map(),
		fold: [],
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
		case 'context':
			return {state, out: []};
		case 'plan': {
			const notes = planChanges(state.plan, e.items);
			return {
				state: {...state, plan: e.items, planTouched: true, planStale: false},
				out: notes.length > 0 ? [{kind: 'plan-note', notes}] : [],
			};
		}
		case 'task':
			if (e.status === 'running' || !e.background) return {state: {...state}, out: []};
			return {state: {...state}, out: [{kind: 'task', status: e.status, description: e.description ?? 'task', ...(e.summary !== undefined && {summary: e.summary})}]};
		case 'thinking-text':
			return {state, out: [{kind: 'thinking', text: e.text, ...(e.durationMs !== undefined && {durationMs: e.durationMs})}]};
		case 'tool-use': {
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {id: e.toolUseId, name: e.name, input: e.input, elapsedSeconds: 0, ...(e.at !== undefined && {startedAt: e.at})});
			return {state: {...state, tools, status: null}, out: []};
		}
		case 'agent-activity': {
			const tool = state.tools.get(e.toolUseId);
			if (!tool) return {state, out: []};
			const tools = new Map(state.tools);
			tools.set(e.toolUseId, {...tool, activity: {name: e.name, input: e.input}});
			return {state: {...state, tools}, out: []};
		}
		case 'agent-message': {
			const tool = state.tools.get(e.agentId);
			const last = e.items.filter(i => i.type === 'tool-use').at(-1);
			if (!tool || !last || last.type !== 'tool-use') return {state, out: []};
			const tools = new Map(state.tools);
			tools.set(e.agentId, {...tool, activity: {name: last.name, input: last.input}});
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
			if (tool !== undefined && PLAN_TOOLS.has(tool.name) && !e.isError) return {state: {...state, tools}, out: []};
			const durationMs = e.durationMs ?? (tool !== undefined && tool.elapsedSeconds > 0 ? tool.elapsedSeconds * 1000 : undefined);
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
						...(durationMs !== undefined && {durationMs}),
						...(tool?.startedAt !== undefined && {startedAt: tool.startedAt}),
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

const FOLD_MAX = 100;

const foldable = (o: Out): o is ToolOut => o.kind === 'tool' && !o.isError && isFoldable(o.name);

const foldGroup = (items: ToolOut[]): Out => (items.length === 1 ? items[0]! : {kind: 'tool-group', items});

// A run of finished Read/Grep/Glob/LS calls prints as one row, so it waits in state.fold until another Out arrives.
export function reduceTranscript(state: TranscriptState, event: ChatEvent): Step {
	const step = reduceEvent(state, event);
	let fold = step.state.fold;
	const out: Out[] = [];
	const flush = () => {
		if (fold.length === 0) return;
		out.push(foldGroup(fold));
		fold = [];
	};
	for (const o of step.out) {
		if (foldable(o)) {
			fold = [...fold, o];
			if (fold.length >= FOLD_MAX) flush();
			continue;
		}
		flush();
		out.push(o);
	}
	const ends = event.type === 'turn-end' || event.type === 'permission-requested' || (event.type === 'state' && event.state === 'idle');
	if (ends) flush();
	if (fold === step.state.fold && out.length === step.out.length && out.every((o, i) => o === step.out[i])) return step;
	return {state: {...step.state, fold}, out};
}

function reduceEvent(state: TranscriptState, event: ChatEvent): Step {
	switch (event.type) {
		case 'ui':
			return reduceUi(state, event.event);
		case 'state':
			if (event.state === 'running') {
				if (state.phase !== 'idle') return {state, out: []};
				const finished = state.plan.length > 0 && state.plan.every(i => i.status === 'completed');
				return {state: {...state, phase: 'running', ...(finished && {plan: []})}, out: []};
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
			const summary = event.summary !== undefined && showSummary(event.summary, event.outcome) ? event.summary : undefined;
			if (event.outcome !== 'ok' && !(event.outcome === 'interrupted' && summary !== undefined)) {
				out.push({kind: 'outcome', outcome: event.outcome, error: event.error});
			}
			if (summary !== undefined) out.push({kind: 'turn-summary', summary, outcome: event.outcome});
			if (flushed.state.turnPrintedText || event.outcome !== 'ok') out.push({kind: 'blank'});
			return {
				state: {
					...flushed.state,
					tools: new Map(),
					status: null,
					turnPrintedText: false,
					approvals: 0,
					pendingApiError: undefined,
					planTouched: false,
					planStale: !state.planTouched && state.plan.some(i => i.status !== 'completed'),
					...(event.summary !== undefined && {lastSummary: event.summary}),
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
		case 'route-start': {
			const tools = new Map(state.tools);
			tools.set(ROUTE_TOOL_ID, {id: ROUTE_TOOL_ID, name: ROUTE_TOOL_NAME, input: undefined, elapsedSeconds: 0});
			return {state: {...state, tools}, out: []};
		}
		case 'route': {
			if (event.source === 'command') return {state, out: [{kind: 'route', ...(event.route.pinned !== undefined && {pinned: event.route.pinned})}]};
			let next = state;
			if (state.tools.has(ROUTE_TOOL_ID)) {
				const tools = new Map(state.tools);
				tools.delete(ROUTE_TOOL_ID);
				next = {...state, tools};
			}
			if (event.route.outcome === 'off') return {state: next, out: []};
			return {state: next, out: [{kind: 'route-block', route: event.route, ...(event.previous !== undefined && {previous: event.previous})}]};
		}
		case 'account':
			return {
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
