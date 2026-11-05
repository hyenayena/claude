import type {RateLimitInfo} from './limits.js';
import type {PlanItem} from './plan.js';
import type {Tier} from './tiers.js';
import type {TurnSummary} from './turn-stats.js';
import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from './permission.js';

export type ToolPatch = {hunks: {oldStart: number; newStart: number; lines: string[]}[]; created?: true};

export type AgentItem =
	| {type: 'text'; text: string}
	| {type: 'thinking'; text: string}
	| {type: 'tool-use'; toolUseId: string; name: string; input: unknown}
	| {type: 'tool-result'; toolUseId: string; isError: boolean; text: string; patch?: ToolPatch};

export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type UiEvent =
	| {kind: 'session'; sessionId: string; model?: string; apiKeySource?: string; slashCommands?: string[]}
	| {kind: 'text-delta'; text: string}
	| {kind: 'text'; messageId: string; text: string; aborted?: boolean}
	| {kind: 'thinking'}
	| {
			kind: 'task';
			id: string;
			status: TaskStatus;
			description?: string;
			background?: boolean;
			summary?: string;
			toolUseId?: string;
			taskType?: string;
			subagentType?: string;
			prompt?: string;
			parentTaskId?: string;
			depth?: number;
	  }
	| {kind: 'thinking-text'; text: string; durationMs?: number}
	| {kind: 'tool-use'; toolUseId: string; name: string; input: unknown; at?: number}
	| {kind: 'tool-input'; name: string}
	| {kind: 'tool-input-delta'; chars: number}
	| {kind: 'tool-result'; toolUseId: string; isError: boolean; text: string; patch?: ToolPatch; durationMs?: number}
	| {kind: 'tool-progress'; toolUseId: string; name: string; elapsedSeconds: number}
	| {kind: 'agent-activity'; toolUseId: string; name: string; input: unknown}
	| {kind: 'agent-message'; agentId: string; taskId?: string; model?: string; items: AgentItem[]}
	| {kind: 'context'; used: number; limit?: number}
	| {kind: 'plan'; items: PlanItem[]}
	| {kind: 'status'; status: 'compacting' | 'requesting' | null}
	| {kind: 'cli-state'; state: 'running' | 'idle' | 'requires_action'}
	| {kind: 'thinking-tokens'; tokens: number}
	| {kind: 'retry'; attempt: number; maxRetries: number; delayMs: number; errorCode?: string}
	| {kind: 'api-error'; code: string; detail?: string}
	| {kind: 'rate-limit'; info: RateLimitInfo}
	| {
			kind: 'result';
			ok: boolean;
			subtype: string;
			text?: string;
			errors?: string[];
			sessionId?: string;
			costUsd?: number;
			numTurns?: number;
			terminalReason?: string;
			queuedTurns?: number;
	  };

export type ContextInfo = {used: number; limit?: number};

export type TurnOutcome = 'ok' | 'error' | 'interrupted' | 'timeout' | 'max-turns' | 'limit' | 'context';
export type ChatState = 'idle' | 'running' | 'closed';

export const ACCOUNT_REASONS = ['changed', 'pinned'] as const;
export type AccountReason = (typeof ACCOUNT_REASONS)[number];

export type ChatEvent =
	| {type: 'ui'; event: UiEvent}
	| {type: 'state'; state: ChatState}
	| {type: 'turn-end'; outcome: TurnOutcome; error?: string; summary?: TurnSummary}
	| {type: 'permission-requested'; request: PermissionRequest; pending: number}
	| {type: 'permission-resolved'; id: string; pending: number}
	| {type: 'audit'; entry: AuditEntry}
	| {type: 'mode'; mode: ChatMode; error?: string}
	| {type: 'sent'; text: string}
	| {type: 'steer-failed'; text: string}
	| {type: 'title'; title: string}
	| {type: 'account'; account: string; previous: string; reason: AccountReason}
	| {type: 'route-start'}
	| {type: 'route'; route: RouteInfo; previous?: Tier; source: RouteSource};

export const ROUTE_OUTCOMES = ['rated', 'kept', 'pinned', 'off'] as const;
export const ROUTE_SOURCES = ['message', 'command'] as const;
export type RouteSource = (typeof ROUTE_SOURCES)[number];

export type RouteInfo = {
	main?: Tier;
	rated?: Tier;
	pinned?: Tier;
	newTask?: boolean;
	held?: boolean;
	failed?: true;
	outcome: (typeof ROUTE_OUTCOMES)[number];
};

export interface ChatController {
	readonly state: ChatState;
	readonly sessionId: string | undefined;
	readonly model: string | undefined;
	readonly needsNewSession: boolean;
	readonly mode: ChatMode;
	readonly title: string | undefined;
	readonly route?: RouteInfo;
	readonly context?: ContextInfo;
	readonly plan?: readonly PlanItem[];
	readonly tasks?: readonly {id?: string; status: string; background: boolean; taskType?: string; toolUseId?: string; subagentType?: string; description?: string}[];
	backgroundTasks?(): Promise<boolean>;
	readonly pendingPermissions: readonly PermissionRequest[];
	readonly detachesOnClose?: boolean;
	readonly queued?: readonly string[];
	setQueued?(lines: readonly string[]): void;
	setMode(mode: ChatMode): void;
	answerPermission(id: string, decision: PermissionDecision): boolean;
	send(text: string, opts?: {command?: boolean}): void;
	steer?(text: string): void;
	interrupt(): Promise<void>;
	reset(): void;
	close(): void;
	subscribe(cb: (e: ChatEvent) => void): () => void;
}
