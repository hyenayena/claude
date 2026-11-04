import {summarizeArgs} from '../chat/truncate.js';
import {CANCEL_MESSAGE, DENY_MESSAGE, DISMISS_MESSAGE} from '../chat/permission.js';
import {LIST_COMMANDS_TOOL, RUN_COMMAND_TOOL} from '../chat/console-tools.js';
import type {ToolPatch} from '../chat/events.js';
import {sgr} from './sgr.js';
import {mcpParts} from './tool-kind.js';
import {parseTodos, ROUTE_TOOL_NAME} from './transcript.js';

export type Scrub = (s: string) => string;

export type ToolResult = {name: string; input: unknown; isError: boolean; text: string; patch?: ToolPatch};

const ARGS_PRE_CAP = 4096;

type ArgsSummary = (input: unknown) => string;

export const inputField = (input: unknown, key: string): string => {
	const v = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
	return typeof v === 'string' ? v : '';
};

const field =
	(key: string): ArgsSummary =>
	input =>
		inputField(input, key);

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

export const ARGS_REGISTRY: Record<string, ArgsSummary> = {
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
	LS: field('path'),
	[RUN_COMMAND_TOOL]: field('command'),
	[LIST_COMMANDS_TOOL]: () => 'list commands',
};

const DISPLAY_NAMES: Record<string, string> = {[RUN_COMMAND_TOOL]: 'Yena', [LIST_COMMANDS_TOOL]: 'Yena'};

export function displayName(name: string): string {
	if (Object.hasOwn(DISPLAY_NAMES, name)) return DISPLAY_NAMES[name]!;
	const mcp = mcpParts(name);
	return mcp === undefined ? name : `${mcp.server}:${mcp.tool}`;
}

export function toolArgs(name: string, input: unknown, scrub: Scrub): string {
	const custom = Object.hasOwn(ARGS_REGISTRY, name) ? ARGS_REGISTRY[name]!(input) : '';
	const raw = custom ? custom.replace(/\s+/g, ' ').slice(0, ARGS_PRE_CAP) : summarizeArgs(name, input, ARGS_PRE_CAP);
	return scrub(raw);
}

export function toolHeader(name: string, input: unknown, scrub: Scrub): string {
	if (name === ROUTE_TOOL_NAME && input === undefined) return `${ROUTE_TOOL_NAME}…`;
	const args = toolArgs(name, input, scrub);
	return `${scrub(displayName(name))}${args ? `(${args})` : ''}`;
}

export function toolOneLiner(name: string, input: unknown, scrub: Scrub): string {
	const args = toolArgs(name, input, scrub);
	return `${scrub(displayName(name))}${args ? ` ${args}` : ''}`;
}

export function styledToolHeader(name: string, input: unknown, scrub: Scrub): string {
	const sg = sgr();
	const args = toolArgs(name, input, scrub);
	return `${sg.bold}${scrub(displayName(name))}${sg.boldOff}${args ? `(${args})` : ''}`;
}

const REFUSAL_MARKERS = ["The user doesn't want to proceed", DENY_MESSAGE.slice(0, DENY_MESSAGE.indexOf('.'))];

export const refusalSummary = (t: ToolResult): string | undefined => {
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

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const nonEmptyLines = (text: string): string[] => text.split('\n').filter(l => l.trim() !== '');

function grepSummary(t: ToolResult): string {
	if (/^No (matches|files)/i.test(t.text.trim())) return 'no matches';
	const mode = inputField(t.input, 'output_mode');
	const lines = nonEmptyLines(t.text).filter(l => !/^Found \d+/.test(l) && !/^\[Showing results/.test(l));
	return mode === 'content' ? plural(lines.length, 'line') : plural(lines.length, 'file');
}

const RESULT_REGISTRY: Record<string, (t: ToolResult) => string> = {
	Read: t => plural(countLines(t.text.replace(/\n+$/, '')), 'line'),
	Glob: t => plural(nonEmptyLines(t.text).filter(l => !/^No files found/.test(l)).length, 'file'),
	Grep: grepSummary,
	LS: t => {
		const entries = nonEmptyLines(t.text).filter(l => /^\s*- /.test(l)).length;
		const n = Math.max(0, entries - 1);
		return `${n} ${n === 1 ? 'entry' : 'entries'}`;
	},
	AskUserQuestion: () => 'answered',
	TodoWrite: t => {
		const todos = parseTodos(t.input);
		return `${todos.filter(x => x.status === 'completed').length}/${todos.length} done`;
	},
};

// Short text for the header detail; undefined means the result is shown as hanging rows.
export function resultSummary(t: ToolResult): string | undefined {
	const refusal = refusalSummary(t);
	if (refusal !== undefined) return refusal;
	if (t.isError || !Object.hasOwn(RESULT_REGISTRY, t.name)) return undefined;
	return RESULT_REGISTRY[t.name]!(t);
}
