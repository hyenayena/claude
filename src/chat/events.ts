import type {RateLimitInfo} from './limits.js';
import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from './permission.js';

export type ToolPatch = {hunks: {oldStart: number; newStart: number; lines: string[]}[]; created?: true};

export type UiEvent =
	| {kind: 'session'; sessionId: string; model?: string; apiKeySource?: string; slashCommands?: string[]}
	| {kind: 'text-delta'; text: string}
	| {kind: 'text'; messageId: string; text: string; aborted?: boolean}
	| {kind: 'thinking'}
	| {kind: 'task'; id: string; status: 'running' | 'completed' | 'failed' | 'stopped'; description?: string; background?: boolean; summary?: string; toolUseId?: string; taskType?: string}
	| {kind: 'thinking-text'; text: string}
	| {kind: 'tool-use'; toolUseId: string; name: string; input: unknown}
	| {kind: 'tool-input'; name: string}
	| {kind: 'tool-input-delta'; chars: number}
	| {kind: 'tool-result'; toolUseId: string; isError: boolean; text: string; patch?: ToolPatch}
	| {kind: 'tool-progress'; toolUseId: string; name: string; elapsedSeconds: number}
	| {kind: 'agent-activity'; toolUseId: string; name: string; input: unknown}
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

export type TurnOutcome = 'ok' | 'error' | 'interrupted' | 'timeout' | 'max-turns' | 'limit' | 'context';
export type ChatState = 'idle' | 'running' | 'closed';

export type ChatEvent =
	| {type: 'ui'; event: UiEvent}
	| {type: 'state'; state: ChatState}
	| {type: 'turn-end'; outcome: TurnOutcome; error?: string}
	| {type: 'permission-requested'; request: PermissionRequest; pending: number}
	| {type: 'permission-resolved'; id: string; pending: number}
	| {type: 'audit'; entry: AuditEntry}
	| {type: 'mode'; mode: ChatMode; error?: string}
	| {type: 'sent'; text: string}
	| {type: 'steer-failed'; text: string}
	| {type: 'title'; title: string}
	| {type: 'account'; account: string; previous: string; reason: 'usage-limit' | 'billing'};

export interface ChatController {
	readonly state: ChatState;
	readonly sessionId: string | undefined;
	readonly model: string | undefined;
	readonly needsNewSession: boolean;
	readonly mode: ChatMode;
	readonly title: string | undefined;
	readonly tasks?: readonly {status: string; background: boolean; taskType?: string}[];
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
