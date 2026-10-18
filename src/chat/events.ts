import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from './permission.js';

export type UiEvent =
	| {kind: 'session'; sessionId: string; model?: string; apiKeySource?: string}
	| {kind: 'text-delta'; text: string}
	| {kind: 'text'; messageId: string; text: string; aborted?: boolean}
	| {kind: 'thinking'}
	| {kind: 'tool-use'; toolUseId: string; name: string; input: unknown}
	| {kind: 'tool-result'; toolUseId: string; isError: boolean; text: string}
	| {kind: 'tool-progress'; toolUseId: string; name: string; elapsedSeconds: number}
	| {kind: 'status'; status: 'compacting' | 'requesting' | null}
	| {kind: 'retry'; attempt: number; maxRetries: number; delayMs: number; errorCode?: string}
	| {kind: 'api-error'; code: string}
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

export type TurnOutcome = 'ok' | 'error' | 'interrupted' | 'timeout' | 'max-turns';
export type ChatState = 'idle' | 'running' | 'closed';

export type ChatEvent =
	| {type: 'ui'; event: UiEvent}
	| {type: 'state'; state: ChatState}
	| {type: 'turn-end'; outcome: TurnOutcome; error?: string}
	| {type: 'permission-requested'; request: PermissionRequest; pending: number}
	| {type: 'permission-resolved'; id: string; pending: number}
	| {type: 'audit'; entry: AuditEntry}
	| {type: 'mode'; mode: ChatMode};

export interface ChatController {
	readonly state: ChatState;
	readonly sessionId: string | undefined;
	readonly model: string | undefined;
	readonly needsNewSession: boolean;
	readonly mode: ChatMode;
	readonly pendingPermissions: readonly PermissionRequest[];
	setMode(mode: ChatMode): void;
	answerPermission(id: string, decision: PermissionDecision): boolean;
	send(text: string): void;
	interrupt(): Promise<void>;
	reset(): void;
	close(): void;
	subscribe(cb: (e: ChatEvent) => void): () => void;
}
