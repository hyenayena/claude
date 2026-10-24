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

export type SlashHints = {
	/** The words already typed before the one being completed, e.g. ["claude"]. */
	path: string[];
	/** The word being typed (may be empty right after a space). */
	query: string;
	matches: ViewCommandInfo[];
};

const MAX_DEPTH = 4;

const named = (list: ViewCommandInfo[], word: string): ViewCommandInfo | undefined =>
	list.find(c => c.name === word) ?? list.find(c => Array.isArray(c.aliases) && c.aliases.includes(word));

/**
 * Hints for a "/command sub…" line being typed at its end: the words typed so far must name a
 * command and its subcommands; the last word is matched against what comes next. Undefined once
 * the line reaches arguments, or for anything that is not such a line.
 */
export function slashHints(commands: ViewCommandInfo[], text: string, cursor: number, max: number): SlashHints | undefined {
	if (!text.startsWith('/') || text.startsWith('//') || cursor !== text.length) return undefined;
	const body = text.slice(1);
	// Single spaces only: a tab, a newline or a leading space is not a command line.
	if (/[^\S ]/.test(body) || body.startsWith(' ')) return undefined;
	const words = body.split(/ +/);
	const query = words.pop() ?? '';
	if (words.length > MAX_DEPTH) return undefined;
	let level = commands;
	for (const word of words) {
		const next = named(level, word);
		if (!next?.subcommands || next.subcommands.length === 0) return undefined;
		level = next.subcommands;
	}
	const matches = matchCommands(level, query, max);
	return matches.length > 0 ? {path: words, query, matches} : undefined;
}
