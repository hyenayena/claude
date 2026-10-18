export type ChatMode = 'default' | 'acceptEdits';
export const MODE_CYCLE: readonly ChatMode[] = ['default', 'acceptEdits'];

export type Highlight = {level: 'info' | 'warn'; text: string};

export type PreviewRow = {
	kind: 'meta' | 'ctx' | 'add' | 'del' | 'gap';
	text: string;
	no?: number;
};

export type Preview = {
	rows: PreviewRow[];
	added: number;
	removed: number;
	truncated: boolean;
	approximate: boolean;
};

export type QuestionSpec = {
	question: string;
	header: string;
	multiSelect: boolean;
	options: {label: string; description: string}[];
};

export type ToolRequest = {
	kind: 'tool';
	id: string;
	seq: number;
	toolName: 'Bash' | 'Edit' | 'Write';
	input: Record<string, unknown>;
	cwd: string;
	path?: string;
	resolvedPath?: string;
	description?: string;
	cliNote?: {text: string; type?: string};
	preview?: Preview;
	highlights: Highlight[];
	defaultToNo: boolean;
	always: false | {label: string};
	oversize: boolean;
};

export type QuestionRequest = {
	kind: 'question';
	id: string;
	seq: number;
	questions: QuestionSpec[];
};

export type PermissionRequest = ToolRequest | QuestionRequest;

export type CancelCause = 'aborted' | 'interrupted' | 'closed' | 'timeout' | 'replaced';

export type PermissionDecision =
	| {kind: 'allow'; always?: boolean}
	| {kind: 'deny'; reason?: string; stop?: boolean}
	| {kind: 'answers'; answers: Record<string, string>}
	| {kind: 'cancel'; cause: CancelCause};

export type AuditEntry = {
	outcome:
		| 'allowed'
		| 'auto-accepted'
		| 'always-allowed'
		| 'denied'
		| 'denied-by-policy'
		| 'cancelled'
		| 'answered'
		| 'dismissed';
	toolName: string;
	summary: string;
};

export interface PermissionPrompter {
	readonly mode: ChatMode;
	request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
	hasApproved(key: string): boolean;
	remember(key: string): void;
	audit(entry: AuditEntry): void;
}

export const PERMISSION_IDLE_MS = 15 * 60 * 1000;
export const MAX_QUEUE = 16;
export const REASON_MAX = 500;
export const BASH_REVIEW_MAX = 20_000;
export const PAYLOAD_REVIEW_MAX = 200_000;

export const QUESTION_LIMITS = {
	questions: 4,
	options: 4,
	question: 300,
	header: 30,
	label: 100,
	description: 300,
	freeText: 500,
} as const;

export const DENY_MESSAGE =
	'The user denied this tool call. Do not retry it or work around the denial; explain what you need and ask the user.';
export const DENY_REASON_PREFIX = "User's reason: ";
export const CANCEL_MESSAGE =
	'The request was cancelled before the user answered (the turn was interrupted or the chat closed).';
export const DISMISS_MESSAGE = 'The user dismissed the question without answering.';
export const POLICY_DENY = {
	outside: 'Access to that path is not allowed (outside the project).',
	guard: 'Access to that path is not allowed (protected Claude configuration file).',
	secret: 'Access to that path is not allowed (secret or credential file).',
	background: 'Background execution is not available in the chat.',
	invalidInput: 'The tool input is invalid.',
	unknownTool: 'That tool is not available in the chat.',
} as const;
export const toolUnavailableMessage = (name: string): string =>
	`Tool "${name}" is not available in the chat`;
