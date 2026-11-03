import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import type {AgentDefinition} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../../src/api.js';
import {isCommandName} from './chat-session.js';
import {parseTierModel, type TierMap, type TierSpec} from './tiers.js';

export const MAX_AGENT_FILES = 100;
export const MAX_DEFINITIONS = 50;
export const MAX_AGENT_BYTES = 64 * 1024;

export type SkipReason = 'size' | 'yaml' | 'key' | 'value' | 'missing';

export type AgentFile = {
	name: string;
	description: string;
	prompt: string;
	hasModel: boolean;
	tier?: TierSpec;
	tools?: string[];
	disallowedTools?: string[];
	skills?: string[];
	maxTurns?: number;
	memory?: 'user' | 'project' | 'local';
	background?: boolean;
};

const BOM = String.fromCharCode(0xfeff);
const KEY_LINE = /^([A-Za-z][A-Za-z_-]*):\s*(.*)$/;
const LIST_ITEM = /^[A-Za-z0-9_*:.()-]+$/;

const normKey = (key: string): string => key.toLowerCase().replace(/[-_]/g, '');

const unquote = (v: string): string => {
	const t = v.trim();
	return t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) ? t.slice(1, -1) : t;
};

export function splitFrontmatter(text: string): {head: string[]; body: string} | undefined {
	const lines = (text.startsWith(BOM) ? text.slice(1) : text).split(/\r?\n/);
	if (lines[0]?.trim() !== '---') return undefined;
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	if (end < 0) return undefined;
	return {head: lines.slice(1, end), body: lines.slice(end + 1).join('\n')};
}

const parseList = (raw: string): string[] | undefined => {
	let v = raw.trim();
	if (v.startsWith('[')) {
		if (!v.endsWith(']')) return undefined;
		v = v.slice(1, -1);
	}
	const items = v
		.split(',')
		.map(unquote)
		.filter(s => s !== '');
	return items.every(s => LIST_ITEM.test(s)) ? items : undefined;
};

export async function agentFiles(dir: string): Promise<string[]> {
	try {
		const names = (await readdir(dir)).filter(n => n.endsWith('.md')).sort();
		return names.slice(0, MAX_AGENT_FILES).map(n => path.join(dir, n));
	} catch {
		return [];
	}
}

async function readSmall(file: string): Promise<string | undefined> {
	try {
		const st = await lstat(file);
		if (!st.isFile() || st.size > MAX_AGENT_BYTES) return undefined;
		return await readFile(file, 'utf8');
	} catch {
		return undefined;
	}
}

const stemOf = (file: string): string => path.basename(file, '.md');

export async function readAgentFile(file: string): Promise<{file: AgentFile} | {skip: SkipReason}> {
	const text = await readSmall(file);
	if (text === undefined) return {skip: 'size'};
	const fm = splitFrontmatter(text);
	if (!fm) return {skip: 'missing'};
	const out: Partial<AgentFile> & {hasModel: boolean} = {hasModel: false};
	let name: string | undefined;
	for (const line of fm.head) {
		if (line.trim() === '') continue;
		if (/^[\s-]/.test(line)) return {skip: 'yaml'};
		const m = KEY_LINE.exec(line);
		if (!m) return {skip: 'yaml'};
		const raw = (m[2] as string).trim();
		if (raw.startsWith('|') || raw.startsWith('>')) return {skip: 'yaml'};
		const value = unquote(raw);
		switch (normKey(m[1] as string)) {
			case 'name':
				if (!isCommandName(value)) return {skip: 'value'};
				name = value;
				break;
			case 'description':
				if (value !== '') out.description = value;
				break;
			case 'tools':
			case 'disallowedtools':
			case 'skills': {
				const list = parseList(raw);
				if (!list) return {skip: 'value'};
				const key = normKey(m[1] as string);
				if (key === 'tools') out.tools = list;
				else if (key === 'skills') out.skills = list;
				else out.disallowedTools = list;
				break;
			}
			case 'model': {
				if (value === '') break;
				const spec = parseTierModel(value);
				if (spec === undefined || spec === 'invalid') out.hasModel = true;
				else out.tier = spec;
				break;
			}
			case 'effort':
			case 'color':
				break;
			case 'maxturns': {
				const n = /^\d{1,4}$/.test(value) ? Number(value) : NaN;
				if (!Number.isInteger(n) || n < 1 || n > 1000) return {skip: 'value'};
				out.maxTurns = n;
				break;
			}
			case 'memory':
				if (value !== 'user' && value !== 'project' && value !== 'local') return {skip: 'value'};
				out.memory = value;
				break;
			case 'background':
				if (value !== 'true' && value !== 'false') return {skip: 'value'};
				out.background = value === 'true';
				break;
			default:
				return {skip: 'key'};
		}
	}
	if (out.description === undefined) return {skip: 'missing'};
	const fallback = stemOf(file);
	const finalName = name ?? fallback;
	if (!isCommandName(finalName)) return {skip: 'value'};
	return {file: {...out, name: finalName, description: out.description, prompt: fm.body.trim()} as AgentFile};
}

export async function peekAgentFile(file: string): Promise<{name: string; model?: string} | undefined> {
	const text = await readSmall(file);
	if (text === undefined) return undefined;
	const fm = splitFrontmatter(text);
	let name = stemOf(file);
	let model: string | undefined;
	for (const line of fm?.head ?? []) {
		const m = KEY_LINE.exec(line);
		if (!m) continue;
		const value = unquote(m[2] as string);
		const key = normKey(m[1] as string);
		if (key === 'name' && value !== '') name = value;
		else if (key === 'model' && value !== '') model = value;
	}
	return {name, ...(model !== undefined && {model})};
}

export async function buildAgentDefinitions(p: {dirs: readonly string[]; map: TierMap; log: Logger}): Promise<Record<string, AgentDefinition>> {
	const defs: Record<string, AgentDefinition> = {};
	const seen = new Set<string>();
	let count = 0;
	let skipped = 0;
	for (const dir of p.dirs) {
		for (const file of await agentFiles(dir)) {
			const r = await readAgentFile(file);
			if ('skip' in r) {
				skipped++;
				p.log.debug('agent definition skipped', {reason: r.skip});
				seen.add(stemOf(file));
				const peeked = await peekAgentFile(file);
				if (peeked) seen.add(peeked.name);
				continue;
			}
			const a = r.file;
			if (seen.has(a.name)) continue;
			seen.add(a.name);
			if (!a.tier || count >= MAX_DEFINITIONS) continue;
			const setting = p.map[a.tier.default];
			defs[a.name] = {
				description: a.description,
				prompt: a.prompt,
				model: setting.model,
				...(setting.effort !== undefined && {effort: setting.effort}),
				...(a.tools && {tools: a.tools}),
				...(a.disallowedTools && {disallowedTools: a.disallowedTools}),
				...(a.skills && {skills: a.skills}),
				...(a.maxTurns !== undefined && {maxTurns: a.maxTurns}),
				...(a.memory && {memory: a.memory}),
				...(a.background !== undefined && {background: a.background}),
			};
			count++;
		}
	}
	p.log.debug('agent definitions', {count, skipped});
	return defs;
}
