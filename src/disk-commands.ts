import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {isCommandName, type SlashCommandInfo} from './chat/chat-session.js';

const MAX = 200;
const HEAD_BYTES = 4096;

function frontmatter(file: string): Record<string, string> {
	let text: string;
	try {
		text = readFileSync(file, 'utf8').slice(0, HEAD_BYTES);
	} catch {
		return {};
	}
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const out: Record<string, string> = {};
	for (const line of m?.[1]?.split(/\r?\n/) ?? []) {
		const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
		if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, '').trim();
	}
	return out;
}

const list = (dir: string): string[] => {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
};

/** Custom commands and skills in the Claude config dir, for hints before a chat session reports its own list. */
export function diskCommands(configDir: string): SlashCommandInfo[] {
	const out: SlashCommandInfo[] = [];
	const add = (name: string, meta: Record<string, string>) => {
		if (!isCommandName(name) || out.some(c => c.name === name)) return;
		out.push({
			name,
			...(meta['description'] && {description: meta['description']}),
			...(meta['argument-hint'] && {argumentHint: meta['argument-hint']}),
		});
	};
	const commands = path.join(configDir, 'commands');
	for (const f of list(commands)) {
		if (f.endsWith('.md')) add(f.slice(0, -3), frontmatter(path.join(commands, f)));
	}
	const skills = path.join(configDir, 'skills');
	for (const d of list(skills)) {
		const file = path.join(skills, d, 'SKILL.md');
		try {
			if (!statSync(file).isFile()) continue;
		} catch {
			continue;
		}
		const meta = frontmatter(file);
		add(meta['name'] || d, meta);
	}
	return out.slice(0, MAX);
}
