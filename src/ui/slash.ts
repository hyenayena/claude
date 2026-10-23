import type {ViewCommandInfo} from './view-commands.js';

export type Slash = {kind: 'command'; line: string} | {kind: 'literal'; text: string};

/**
 * "/<command> [args]" on one line runs a yena console command; "//text" sends "/text" to Claude.
 * Anything else (and a "/word" that is not a console command) goes to Claude unchanged.
 */
export function parseSlash(text: string): Slash | undefined {
	if (text.startsWith('//')) return {kind: 'literal', text: text.slice(1)};
	if (!text.startsWith('/') || text.includes('\n')) return undefined;
	const line = text.slice(1).trim();
	return line === '' ? undefined : {kind: 'command', line};
}

/** Commands for the hint list while "/name" is typed: prefix matches first, then other matches. */
export function matchCommands(commands: ViewCommandInfo[], query: string, max: number): ViewCommandInfo[] {
	const q = query.toLowerCase();
	const prefix = commands.filter(c => c.name.toLowerCase().startsWith(q));
	const inner = commands.filter(c => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
	return [...prefix, ...inner].slice(0, Math.max(0, max));
}

/** The query of a "/name" being typed (no space yet, cursor at the end), or undefined. */
export function slashQuery(text: string, cursor: number): string | undefined {
	if (!text.startsWith('/') || text.startsWith('//') || cursor !== text.length || /\s/.test(text)) return undefined;
	return text.slice(1);
}
