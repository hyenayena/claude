import {LIST_COMMANDS_TOOL, RUN_COMMAND_TOOL} from '../deps/chat.js';
import type {GlyphName} from '../kit.js';

export type ToolFamily = 'read' | 'search' | 'edit' | 'shell' | 'web' | 'agent' | 'task' | 'other';

export const FAMILY_GLYPH: Readonly<Record<ToolFamily, GlyphName>> = Object.freeze({
	read: 'toolRead',
	search: 'toolSearch',
	edit: 'toolEdit',
	shell: 'toolShell',
	web: 'toolWeb',
	agent: 'toolAgent',
	task: 'toolTask',
	other: 'toolOther',
});

export const DURATION_MIN_MS = 1000;

export const FOLDABLE_TOOLS = ['Read', 'Grep', 'Glob', 'LS'] as const;

export const isFoldable = (name: string): boolean => (FOLDABLE_TOOLS as readonly string[]).includes(name);

const FAMILIES: Readonly<Record<string, ToolFamily>> = {
	Read: 'read',
	NotebookRead: 'read',
	LS: 'read',
	[LIST_COMMANDS_TOOL]: 'read',
	Grep: 'search',
	Glob: 'search',
	ToolSearch: 'search',
	Edit: 'edit',
	Write: 'edit',
	MultiEdit: 'edit',
	NotebookEdit: 'edit',
	Bash: 'shell',
	BashOutput: 'shell',
	KillShell: 'shell',
	KillBash: 'shell',
	Monitor: 'shell',
	[RUN_COMMAND_TOOL]: 'shell',
	WebFetch: 'web',
	WebSearch: 'web',
	Agent: 'agent',
	Task: 'agent',
	SendMessage: 'agent',
	TodoWrite: 'task',
	TaskCreate: 'task',
	TaskUpdate: 'task',
	TaskList: 'task',
	TaskGet: 'task',
	TaskOutput: 'task',
	TaskStop: 'task',
	EnterPlanMode: 'task',
	ExitPlanMode: 'task',
};

const MCP = /^mcp__(.+?)__(.+)$/;

export function mcpParts(name: string): {server: string; tool: string} | undefined {
	const m = MCP.exec(name);
	return m === null ? undefined : {server: m[1]!, tool: m[2]!};
}

const WORD_FAMILIES: readonly [RegExp, ToolFamily][] = [
	[/search|find|query|grep/, 'search'],
	[/fetch|http|url|browse|web/, 'web'],
	[/read|get|list|show|view/, 'read'],
	[/write|edit|create|update|delete|set|put/, 'edit'],
];

export function toolFamily(name: string): ToolFamily {
	if (Object.hasOwn(FAMILIES, name)) return FAMILIES[name]!;
	const mcp = mcpParts(name);
	if (mcp === undefined) return 'other';
	const tool = mcp.tool.toLowerCase();
	return WORD_FAMILIES.find(([re]) => re.test(tool))?.[1] ?? 'other';
}
