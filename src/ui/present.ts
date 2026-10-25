import {
	BLOCK_DISPLAY_CAP,
	clampChars,
	summarizeArgs,
	summarizeResult,
	tailRows,
} from '../chat/truncate.js';
import type {AuditEntry, ChatMode} from '../chat/permission.js';
import {CANCEL_MESSAGE, DENY_MESSAGE, DISMISS_MESSAGE} from '../chat/permission.js';
import {wrapRows} from '../kit.js';
import {renderMarkdown} from './markdown.js';
import {LIVE, parseTodos, type Out, type Phase, type RunningTool, type StatusLine, type Todo} from './transcript.js';

export type Scrub = (s: string) => string;

// The only places an escape character may originate; every untrusted string is scrubbed first.
export const SGR = {
	reset: '\u001b[0m',
	dim: '\u001b[2m',
	red: '\u001b[31m',
	green: '\u001b[32m',
	cyan: '\u001b[36m',
	bold: '\u001b[1m',
	italic: '\u001b[3m',
	underline: '\u001b[4m',
	yellow: '\u001b[33m',
	magenta: '\u001b[35m',
	blue: '\u001b[34m',
	boldOff: '\u001b[22m',
	italicOff: '\u001b[23m',
	underlineOff: '\u001b[24m',
	fgOff: '\u001b[39m',
	userBg: '\u001b[48;5;237m',
	strike: '\u001b[9m',
} as const;

const paint = (style: string, text: string): string =>
	text
		.split('\n')
		.map(line => `${style}${line}${SGR.reset}`)
		.join('\n');

const RESULT_INPUT_CAP = 64 * 1024;
const ARGS_MAX = 100;
const ARGS_PRE_CAP = 4096;

export function formatUserLine(text: string, scrub: Scrub): string {
	const lines = scrub(text).split('\n').map((line, i) => ` ${i === 0 ? '>' : ' '} ${line} `);
	return paint(SGR.userBg, lines.join('\n'));
}

const THINKING_LINES = 6;

/** A finished thinking block: dim and italic, cut to its first lines. */
export function formatThinking(text: string, scrub: Scrub): string {
	const lines = scrub(clampChars(text, BLOCK_DISPLAY_CAP)).trim().split('\n');
	const shown = lines.slice(0, THINKING_LINES);
	const more = lines.length - shown.length;
	const body = [`✻ Thinking…`, ...shown.map(l => `  ${l}`), ...(more > 0 ? [`  … +${more} line${more === 1 ? '' : 's'} (ctrl+o to expand)`] : [])];
	return paint(SGR.dim + SGR.italic, body.join('\n'));
}

/** Claude Code's block shape: a marker on the first line, every other line under the text. */
const hang = (marker: string, lines: string[]): string =>
	lines.map((l, i) => (i === 0 ? `${marker} ${l}` : l === '' ? '' : `${' '.repeat(BLOCK_INDENT)}${l}`)).join('\n');

const BLOCK_INDENT = 2;

export function formatAssistantBlock(text: string, scrub: Scrub, interrupted = false, width?: number): string {
	// Markdown styling is applied to the scrubbed text, so it only adds the constant SGR codes.
	const inner = width === undefined ? undefined : Math.max(10, width - BLOCK_INDENT);
	const body = renderMarkdown(scrub(clampChars(text, BLOCK_DISPLAY_CAP)), {width: inner}).replace(/^\n+/, '');
	// Wrapped here, not by the terminal, so continuation rows keep the indent under the dot.
	const lines = inner === undefined ? body.split('\n') : body.split('\n').flatMap(l => wrapRows(l, inner, {mode: 'word'}));
	if (interrupted) lines.push(paint(SGR.dim, '(interrupted)'));
	return hang('●', lines);
}

type ArgsSummary = (input: unknown) => string;

const field =
	(key: string): ArgsSummary =>
	input => {
		const v = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
		return typeof v === 'string' ? v : '';
	};

const questionArgs: ArgsSummary = input => {
	const qs = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['questions'] : undefined;
	if (!Array.isArray(qs) || qs.length === 0) return '';
	const first = (qs[0] as Record<string, unknown> | null)?.['question'];
	const text = typeof first === 'string' ? first : '';
	return qs.length > 1 ? `${text} (+${qs.length - 1} more)` : text;
};

function agentArgs(input: unknown): string {
	if (typeof input !== 'object' || input === null) return '';
	const r = input as Record<string, unknown>;
	const type = typeof r['subagent_type'] === 'string' ? r['subagent_type'] : undefined;
	const what = typeof r['description'] === 'string' ? r['description'] : undefined;
	return type && what ? `${type}: ${what}` : (type ?? what ?? '');
}

// Per-tool extension point for the one-line argument summary.
const ARGS_REGISTRY: Record<string, ArgsSummary> = {
	AskUserQuestion: questionArgs,
	Bash: field('command'),
	Write: field('file_path'),
	Edit: field('file_path'),
	NotebookEdit: field('notebook_path'),
	WebFetch: field('url'),
	WebSearch: field('query'),
	TodoWrite: input => {
		const n = parseTodos(input).length;
		return `${n} item${n === 1 ? '' : 's'}`;
	},
	Agent: agentArgs,
	Task: agentArgs,
	SendMessage: field('to'),
};

export function toolArgs(name: string, input: unknown, scrub: Scrub): string {
	const custom = ARGS_REGISTRY[name]?.(input);
	const raw = custom ? custom.replace(/\s+/g, ' ').slice(0, ARGS_PRE_CAP) : summarizeArgs(name, input, ARGS_PRE_CAP);
	// Redact before clamping so a secret straddling the cut cannot leave a visible prefix
	const clean = scrub(raw);
	return clean.length > ARGS_MAX ? `${clean.slice(0, ARGS_MAX - 1)}…` : clean;
}

export function toolHeader(name: string, input: unknown, scrub: Scrub): string {
	const args = toolArgs(name, input, scrub);
	return `${scrub(name)}${args ? `(${args})` : ''}`;
}

/** The tool name bold, the arguments plain, as Claude Code shows them. */
export function styledToolHeader(name: string, input: unknown, scrub: Scrub): string {
	const args = toolArgs(name, input, scrub);
	return `${SGR.bold}${scrub(name)}${SGR.boldOff}${args ? `(${args})` : ''}`;
}

type ToolResult = {name: string; input: unknown; isError: boolean; text: string};
type ResultSummary = (t: ToolResult, scrub: Scrub) => string | undefined;

const REFUSAL_MARKERS = ["The user doesn't want to proceed", DENY_MESSAGE.slice(0, DENY_MESSAGE.indexOf('.'))];

const refusalSummary = (t: ToolResult): string | undefined => {
	if (!t.isError) return undefined;
	if (REFUSAL_MARKERS.some(m => t.text.includes(m))) return 'denied';
	if (t.text.includes(CANCEL_MESSAGE)) return 'cancelled';
	if (t.text.includes(DISMISS_MESSAGE)) return 'dismissed';
	return undefined;
};

const countLines = (s: string): number => {
	if (s === '') return 0;
	const n = s.split('\n').length;
	return s.endsWith('\n') ? n - 1 : n;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const pathOf = (t: ToolResult, scrub: Scrub): string | undefined => {
	const p = field('file_path')(t.input);
	return p === '' ? undefined : clampChars(scrub(p), ARGS_MAX);
};

// Claude Code's one-line summaries; Bash and the other tools fall through to the clamped output.
const RESULT_REGISTRY: Record<string, ResultSummary> = {
	Edit: (t, scrub) => {
		const path = pathOf(t, scrub);
		if (t.isError || path === undefined) return undefined;
		const added = countLines(field('new_string')(t.input));
		const removed = countLines(field('old_string')(t.input));
		return `Updated ${path} with ${plural(added, 'addition')} and ${plural(removed, 'removal')}`;
	},
	Write: (t, scrub) => {
		const path = pathOf(t, scrub);
		return t.isError || path === undefined ? undefined : `Wrote ${plural(countLines(field('content')(t.input)), 'line')} to ${path}`;
	},
	Read: t => (t.isError ? undefined : `Read ${plural(countLines(t.text.replace(/\n+$/, '')), 'line')}`),
	Glob: t => {
		if (t.isError) return undefined;
		const files = t.text.split('\n').filter(l => l.trim() !== '' && !/^No files found/.test(l));
		return `Found ${plural(files.length, 'file')}`;
	},
	AskUserQuestion: t => (t.isError ? undefined : 'answered'),
	TodoWrite: t => {
		if (t.isError) return undefined;
		const todos = parseTodos(t.input);
		return `checklist: ${todos.filter(x => x.status === 'completed').length}/${todos.length} done`;
	},
};

/** Messages waiting for the current answer, one line each; the last line counts any extra ones. */
export function queuedLines(queue: string[], scrub: Scrub, max: number): string[] {
	if (max <= 0 || queue.length === 0) return [];
	const one = (q: string) => `↳ queued: ${scrub(q.replace(/\s+/g, ' '))}`;
	if (queue.length <= max) return queue.map(one);
	return [...queue.slice(0, max - 1).map(one), `↳ +${queue.length - max + 1} more queued`];
}

const TODO_MARK: Record<Todo['status'], string> = {completed: '☒', in_progress: '☐', pending: '☐'};

/** The open checklist as display lines, at most `max` (an item in progress is never left out). */
export function todoLines(todos: Todo[], scrub: Scrub, max: number): string[] {
	if (max <= 0 || !todos.some(t => t.status !== 'completed')) return [];
	const line = (t: Todo) => {
		const text = `${TODO_MARK[t.status]} ${scrub(t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content)}`;
		if (t.status === 'completed') return paint(SGR.dim + SGR.strike, text);
		return t.status === 'in_progress' ? paint(SGR.bold, text) : text;
	};
	if (todos.length <= max) return resultLines(todos.map(line));
	const current = Math.max(0, todos.findIndex(t => t.status !== 'completed'));
	const start = Math.min(current, todos.length - (max - 1));
	const shown = todos.slice(start, start + max - 1).map(line);
	return resultLines([...shown, paint(SGR.dim, `… +${todos.length - shown.length} more`)]);
}

export function summarizeToolResult(t: ToolResult, scrub: Scrub): string {
	const custom = refusalSummary(t) ?? RESULT_REGISTRY[t.name]?.(t, scrub);
	return custom ?? summarizeResult(scrub(t.text.slice(0, RESULT_INPUT_CAP)));
}

export const RESULT_PREFIX = '  ⎿  ';
const RESULT_INDENT = '     ';

/** Lines under a block: the first after "⎿", the rest aligned with it. */
export const resultLines = (lines: string[]): string[] => lines.map((l, i) => `${i === 0 ? RESULT_PREFIX : RESULT_INDENT}${l}`);

export function formatToolBlock(t: ToolResult, scrub: Scrub): string {
	const dot = `${t.isError ? SGR.red : SGR.green}●${SGR.reset}`;
	const header = `${dot} ${styledToolHeader(t.name, t.input, scrub)}${SGR.reset}`;
	const body = summarizeToolResult(t, scrub);
	if (body.trim() === '') return t.isError ? `${header}\n${paint(SGR.red, `${RESULT_PREFIX}Error`)}` : header;
	return `${header}\n${paint(t.isError ? SGR.red : SGR.dim, resultLines(body.split('\n')).join('\n'))}`;
}

export function formatError(message: string, scrub: Scrub): string {
	return paint(SGR.red, `Error: ${scrub(message)}`);
}

export function formatWarning(message: string, scrub: Scrub): string {
	return paint(SGR.yellow, scrub(message));
}

export function formatNotice(message: string, scrub: Scrub): string {
	return paint(SGR.dim, scrub(message));
}

const AUDIT_MAX = 100;

const auditText = (raw: string, show: Scrub): string => {
	const first = show(raw).split('\n')[0] ?? '';
	return first.length > AUDIT_MAX ? `${first.slice(0, AUDIT_MAX - 1)}…` : first;
};

const pluralQuestions = (summary: string): string => {
	const m = /^(\d+) question\(s\)$/.exec(summary);
	if (!m) return summary;
	return m[1] === '1' ? '1 question' : `${m[1]} questions`;
};

/** One dim line per decision; carries a tool, a path or a command, never file contents or answers. */
export function formatAudit(entry: AuditEntry, scrub: Scrub, reveal: Scrub = scrub): string {
	const tool = scrub(entry.toolName);
	const summary = auditText(entry.summary, reveal);
	const line = ((): string => {
		switch (entry.outcome) {
			case 'allowed':
				return `Allowed ${tool}: ${summary}`;
			case 'auto-accepted':
				return `Auto-accepted ${tool}: ${summary}`;
			case 'always-allowed':
				return `Always-allowed ${tool}(${summary}) for this chat`;
			case 'denied':
				return `Denied ${tool}: ${summary}`;
			case 'denied-by-policy':
				return `Blocked ${tool}: ${summary}`;
			case 'cancelled':
				return `Cancelled ${tool}: the turn was interrupted`;
			case 'answered':
				return `Answered ${pluralQuestions(summary)}`;
			case 'dismissed':
				return `Dismissed ${pluralQuestions(summary)}`;
		}
	})();
	return paint(SGR.dim, line);
}

export const MODE_LABEL: Record<ChatMode, string> = {default: 'default', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto'};

const MODE_LINE: Record<ChatMode, string> = {
	default: 'Mode: default (edits ask for approval)',
	acceptEdits: 'Mode: auto-accept edits (this chat only)',
	plan: 'Mode: plan (Claude researches and proposes a plan; nothing is changed until you approve it)',
	auto: 'Mode: auto (a classifier approves or denies tool calls, asks when unsure; this chat only)',
};

export function formatModeLine(mode: ChatMode, error?: string, scrub: Scrub = s => s): string {
	const line = error === undefined ? MODE_LINE[mode] : `Auto mode is unavailable: ${scrub(error)}. ${MODE_LINE[mode]}`;
	return paint(SGR.dim, line);
}

export function formatOut(out: Out, scrub: Scrub, reveal: Scrub = scrub, width?: number): string {
	switch (out.kind) {
		case 'audit':
			return formatAudit(out.entry, scrub, reveal);
		case 'mode':
			return formatModeLine(out.mode, out.error, scrub);
		case 'account':
			return formatNotice(
				`Account "${out.previous}" ${out.reason === 'billing' ? 'cannot be billed' : 'reached its usage limit'}; continuing with "${out.account}".`,
				scrub,
			);
		case 'thinking':
			return formatThinking(out.text, scrub);
		case 'task':
			return paint(SGR.dim, `⚙ Background task ${out.status}: ${scrub(out.description)}${out.summary ? ` — ${scrub(out.summary)}` : ''}`);
		case 'assistant':
			return formatAssistantBlock(out.text, scrub, out.interrupted, width);
		case 'tool':
			return formatToolBlock(out, scrub);
		case 'error':
			return formatError(out.message, scrub);
		case 'api-error':
			return formatError(`API error (${out.code})`, scrub);
		case 'blank':
			return ' ';
		case 'outcome':
			switch (out.outcome) {
				case 'interrupted':
					return formatNotice('Interrupted.', scrub);
				case 'timeout':
					return formatError(out.error ?? 'The request timed out', scrub);
				case 'max-turns':
					return formatError(out.error ?? 'Reached the maximum number of turns', scrub);
				case 'error':
					return formatError(out.error ?? 'The request failed', scrub);
				case 'limit':
					return formatWarning(out.error ?? 'Usage limit reached', scrub);
				case 'context':
					return formatWarning(out.error ?? 'The conversation is too long for the context window', scrub);
			}
	}
}

export function liveTail(liveRaw: string, scrub: Scrub, maxRows: number, columns: number): string[] {
	if (liveRaw === '') return [];
	let window = liveRaw;
	if (window.length > LIVE.tailChars) {
		window = window.slice(-LIVE.tailChars);
		const nl = window.indexOf('\n');
		if (nl >= 0) window = window.slice(nl + 1);
	}
	return tailRows(scrub(window), maxRows, columns);
}

export function statusLineText(status: StatusLine): string {
	if (!status) return '';
	switch (status.kind) {
		case 'thinking':
			return 'Thinking…';
		case 'tool-input': {
			const name = status.name.replace(/[^\w:.-]/g, '').slice(0, 40);
			return name ? `Writing ${name}…` : 'Writing…';
		}
		case 'compacting':
			return 'Compacting…';
		case 'retry':
			return `Retrying (${status.attempt}/${status.maxRetries}) in ${Math.ceil(status.delayMs / 1000)}s…`;
	}
}

export const formatDuration = (seconds: number): string => {
	const s = Math.max(0, Math.floor(seconds));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

const formatTokens = (n: number): string => (n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`);

// Silence longer than this is shown, so a long think can be told from a hang.
export const QUIET_NOTICE_S = 60;

/** The line under the live output while a turn runs: what is happening, for how long, how to stop it. */
export function workingText(phase: Phase, status: StatusLine, seconds: number, quietSeconds = 0): string {
	if (phase === 'interrupting') return 'Interrupting…';
	const what = statusLineText(status) || 'Working…';
	const parts = [formatDuration(seconds)];
	// Tool input is JSON: about four characters a token.
	const tokens = status?.kind === 'thinking' ? status.tokens : status?.kind === 'tool-input' && status.chars > 0 ? status.chars / 4 : undefined;
	if (tokens !== undefined && tokens > 0) parts.push(`↓ ${formatTokens(tokens)} tokens`);
	if (quietSeconds >= QUIET_NOTICE_S) parts.push(`no response for ${formatDuration(quietSeconds)}`);
	parts.push('esc to interrupt');
	return `${what} (${parts.join(' · ')})`;
}

const MODE_HINT: Record<ChatMode, string> = {
	default: '',
	acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)',
	plan: '⏸ plan mode on (shift+tab to cycle)',
	auto: '⏵⏵ auto mode on (shift+tab to cycle)',
};

/** The hint under the input box; empty in the default mode. */
export const modeHint = (mode: ChatMode): string => MODE_HINT[mode];

export function toolRunningText(tool: RunningTool, scrub: Scrub): string {
	const secs = Math.floor(tool.elapsedSeconds);
	const activity = tool.activity ? ` → ${toolHeader(tool.activity.name, tool.activity.input, scrub)}` : '';
	return `${toolHeader(tool.name, tool.input, scrub)}${secs > 0 ? ` ${secs}s` : ''}${activity}`;
}

/** Running work for the status bar: subagents (foreground and background) and other background tasks. */
export function tasksBarText(tasks: readonly {status: string; background: boolean; taskType?: string}[]): string {
	const running = tasks.filter(t => t.status === 'running');
	const agents = running.filter(t => t.taskType === 'local_agent').length;
	const background = running.filter(t => t.background).length;
	const parts: string[] = [];
	if (agents > 0) parts.push(`${agents} ${agents === 1 ? 'agent' : 'agents'}`);
	if (background > 0) parts.push(`${background} in background`);
	return parts.join(' · ');
}

export function statusBarText(
	s: {
		credentialLabel: string;
		model: string | undefined;
		sessionId: string | undefined;
		phase: Phase;
		mode?: ChatMode;
		pending?: number;
		limit?: string;
	},
	scrub: Scrub,
): string {
	const parts = [scrub(s.credentialLabel)];
	if (s.model) parts.push(scrub(s.model));
	if (s.sessionId) parts.push(scrub(s.sessionId).slice(0, 8));
	parts.push(s.pending !== undefined && s.pending > 0 ? 'awaiting approval' : s.phase);
	if (s.mode !== undefined) parts.push(`mode: ${MODE_LABEL[s.mode]}`);
	if (s.limit) parts.push(scrub(s.limit));
	return parts.join(' · ');
}
