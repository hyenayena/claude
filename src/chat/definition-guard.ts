import {readFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Frontmatter that lets something run without the user's approval: `allowed-tools` (skills, commands),
 * `hooks` (skills, agents), `permissionMode` and `mcpServers` (agents). Keys are compared without case,
 * dashes, underscores and quotes, so near spellings count too.
 */
const PRIVILEGED = new Set(['allowedtools', 'hooks', 'permissionmode', 'mcpservers']);

/** The md hub folders Claude Code loads definitions from (through the config dir's symlinks). */
export const HUB_DEFINITION_DIRS = ['agents', 'skills', 'commands', 'output-styles'];

const BOM = String.fromCharCode(0xfeff);

const normKey = (key: string) => key.toLowerCase().replace(/["'_-]/g, '');

/** The privileged frontmatter entries of a Markdown file, each with its continuation lines, sorted. */
export function privilegedEntries(text: string): string[] {
	const lines = (text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return [];
	const entries: string[][] = [];
	let current: string[] | undefined;
	for (const line of lines.slice(1)) {
		if (line.trim() === '---') break;
		const top = /^([^\s#-][^:]*):/.exec(line);
		if (top) {
			current = PRIVILEGED.has(normKey((top[1] as string).trim())) ? [] : undefined;
			if (current) entries.push(current);
		}
		current?.push(line.trimEnd());
	}
	return entries.map(e => e.join('\n')).sort();
}

const inside = (child: string, dir: string) => {
	const rel = path.relative(dir, child);
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** A file Claude Code may load as a skill, agent, command or output style. */
export function isDefinitionPath(file: string, hubs: readonly string[]): boolean {
	if (file.split(path.sep).includes('.claude')) return true;
	return hubs.some(hub => inside(file, hub) && HUB_DEFINITION_DIRS.includes(path.relative(hub, file).split(path.sep)[0] as string));
}

function contentAfter(before: string, tool: string, args: Record<string, unknown>): string | undefined {
	if (tool === 'Write') return typeof args.content === 'string' ? args.content : undefined;
	const {old_string: from, new_string: to} = args;
	if (typeof from !== 'string' || typeof to !== 'string') return undefined;
	if (from === '') return before === '' ? to : undefined;
	if (!before.includes(from)) return undefined;
	return args.replace_all === true ? before.split(from).join(to) : before.replace(from, () => to);
}

/**
 * True when an Edit or Write of `file` adds or changes a privileged frontmatter entry. Removing one is
 * fine: it only takes rights away. An edit that cannot apply (old text missing) fails in Claude Code anyway.
 */
export async function addsPrivilegedFrontmatter(file: string, tool: string, args: Record<string, unknown>): Promise<boolean> {
	let before = '';
	try {
		before = await readFile(file, 'utf8');
	} catch {
		// a new file
	}
	const after = contentAfter(before, tool, args);
	if (after === undefined) return false;
	const had = new Set(privilegedEntries(before));
	return privilegedEntries(after).some(entry => !had.has(entry));
}
