import type {RateLimitInfo} from './limits.js';
import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from './permission.js';

export type UiEvent =
	| {kind: 'session'; sessionId: string; model?: string; apiKeySource?: string; slashCommands?: string[]}
	| {kind: 'text-delta'; text: string}
	| {kind: 'text'; messageId: string; text: string; aborted?: boolean}
	| {kind: 'thinking'}
	// A background or subagent task started, progressed or settled.
	| {kind: 'task'; id: string; status: 'running' | 'completed' | 'failed' | 'stopped'; description?: string; background?: boolean; summary?: string}
	// The text of a finished thinking block (empty when the API omits it).
	| {kind: 'thinking-text'; text: string}
	| {kind: 'tool-use'; toolUseId: string; name: string; input: unknown}
	| {kind: 'tool-result'; toolUseId: string; isError: boolean; text: string}
	| {kind: 'tool-progress'; toolUseId: string; name: string; elapsedSeconds: number}
	// What a subagent started by tool `toolUseId` is doing now (its latest tool call).
	| {kind: 'agent-activity'; toolUseId: string; name: string; input: unknown}
	| {kind: 'status'; status: 'compacting' | 'requesting' | null}
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
	| {type: 'title'; title: string};

export interface ChatController {
	readonly state: ChatState;
	readonly sessionId: string | undefined;
	readonly model: string | undefined;
	readonly needsNewSession: boolean;
	readonly mode: ChatMode;
	readonly title: string | undefined;
	// Background tasks and subagents of this chat (newest first), when the controller tracks them.
	readonly tasks?: readonly {status: string; background: boolean}[];
	backgroundTasks?(): Promise<boolean>;
	readonly pendingPermissions: readonly PermissionRequest[];
	setMode(mode: ChatMode): void;
	answerPermission(id: string, decision: PermissionDecision): boolean;
	// `command: true` lets Claude Code run a leading /command; otherwise the text is delivered as written.
	send(text: string, opts?: {command?: boolean}): void;
	interrupt(): Promise<void>;
	reset(): void;
	close(): void;
	subscribe(cb: (e: ChatEvent) => void): () => void;
}
