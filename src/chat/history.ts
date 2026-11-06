import {open, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import type {DetailFile, DetailLine, DetailText, HistoryMessage, PromptEntry, SessionSummary, ToolPatch} from '../deps/chat.js';
import {toolPatch} from './normalize.js';
import {titleFromPrompt, transcriptFile} from './title.js';

const MAX_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type {HistoryMessage, PromptEntry, SessionSummary};

type Entry = {
	uuid?: unknown;
	parentUuid?: unknown;
	type?: unknown;
	isMeta?: unknown;
	isSidechain?: unknown;
	aiTitle?: unknown;
	customTitle?: unknown;
	message?: {id?: unknown; content?: unknown};
	toolUseResult?: unknown;
	tool_use_result?: unknown;
};

async function readTail(file: string): Promise<string | undefined> {
	try {
		const handle = await open(file, 'r');
		try {
			const {size} = await handle.stat();
			const length = Math.min(size, MAX_BYTES);
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, size - length);
			return buf.toString('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

function* entries(text: string): Generator<Entry> {
	for (const line of text.split('\n')) {
		if (line === '') continue;
		try {
			const e = JSON.parse(line) as unknown;
			if (e && typeof e === 'object') yield e as Entry;
		} catch {
			continue;
		}
	}
}

const promptOf = (e: Entry): string | undefined =>
	e.type === 'user' && e.isMeta !== true && e.isSidechain !== true && typeof e.message?.content === 'string'
		? e.message.content
		: undefined;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export async function listSessions(configDir: string, projectDir: string, limit = 30): Promise<SessionSummary[]> {
	const dir = path.dirname(transcriptFile(configDir, projectDir, 'x'));
	let names: string[];
	try {
		names = (await readdir(dir)).filter(n => n.endsWith('.jsonl') && UUID.test(n.slice(0, -6)));
	} catch {
		return [];
	}
	const dated = await Promise.all(
		names.map(async n => {
			try {
				return {n, modified: (await stat(path.join(dir, n))).mtimeMs};
			} catch {
				return {n, modified: 0};
			}
		}),
	);
	dated.sort((a, b) => b.modified - a.modified);
	const out: SessionSummary[] = [];
	for (const {n, modified} of dated) {
		if (out.length >= limit) break;
		const text = await readTail(path.join(dir, n));
		if (text === undefined) continue;
		let custom: string | undefined;
		let generated: string | undefined;
		let first: string | undefined;
		let prompts = 0;
		for (const e of entries(text)) {
			if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) custom = e.customTitle.trim();
			if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) generated = e.aiTitle.trim();
			const p = promptOf(e);
			if (p !== undefined && p.trim() !== '') {
				prompts++;
				first ??= p;
			}
		}
		if (prompts === 0) continue;
		out.push({sessionId: n.slice(0, -6), title: clip(custom ?? generated ?? titleFromPrompt(first ?? ''), TITLE_MAX), modified, prompts});
	}
	return out;
}

export async function listPrompts(file: string): Promise<PromptEntry[]> {
	const text = await readTail(file);
	if (text === undefined) return [];
	const out: PromptEntry[] = [];
	for (const e of entries(text)) {
		const prompt = promptOf(e);
		if (prompt === undefined || prompt.trim() === '' || typeof e.uuid !== 'string') continue;
		out.push({uuid: e.uuid, parentUuid: typeof e.parentUuid === 'string' ? e.parentUuid : null, text: prompt});
	}
	return out;
}

export async function readHistory(file: string, limit = 40, until?: string): Promise<HistoryMessage[]> {
	const text = await readTail(file);
	if (text === undefined) return [];
	const out: HistoryMessage[] = [];
	let lastAssistantId: unknown;
	for (const e of entries(text)) {
		if (until !== undefined && e.uuid === until) break;
		const prompt = promptOf(e);
		if (prompt !== undefined) {
			if (prompt.trim() !== '') out.push({role: 'user', text: prompt});
			lastAssistantId = undefined;
			continue;
		}
		if (e.type !== 'assistant' || e.isSidechain === true || !Array.isArray(e.message?.content)) continue;
		const text = (e.message.content as Array<{type?: unknown; text?: unknown}>)
			.filter(b => b?.type === 'text' && typeof b.text === 'string')
			.map(b => b.text as string)
			.join('');
		if (text.trim() === '') continue;
		const last = out.at(-1);
		if (last?.role === 'assistant' && e.message.id !== undefined && e.message.id === lastAssistantId) last.text += text;
		else if (last?.role === 'assistant') last.text += `\n\n${text}`;
		else out.push({role: 'assistant', text});
		lastAssistantId = e.message.id;
	}
	return out.slice(-limit);
}

const DETAIL_RESULT_LINES = 400;
const DETAIL_MAX_LINES = 20_000;

const blockText = (content: unknown): string => {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map(b => (b && typeof b === 'object' && (b as {type?: unknown}).type === 'text' ? String((b as {text?: unknown}).text ?? '') : b && typeof b === 'object' && (b as {type?: unknown}).type === 'image' ? '[image]' : ''))
		.filter(Boolean)
		.join('\n');
};

const capLines = (text: string, max: number): string[] => {
	const lines = text.split('\n');
	return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`] : lines;
};

export type {DetailFile, DetailLine, DetailText};

const DETAIL_FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const linesIn = (v: unknown): number => (typeof v === 'string' && v !== '' ? v.split('\n').length : 0);

function fileRows(input: unknown): number {
	if (typeof input !== 'object' || input === null) return 2;
	const o = input as Record<string, unknown>;
	const edits = Array.isArray(o['edits']) ? o['edits'].slice(0, 50).reduce((n: number, e) => n + linesIn((e as {old_string?: unknown})?.old_string) + linesIn((e as {new_string?: unknown})?.new_string), 0) : 0;
	return 2 + linesIn(o['content']) + linesIn(o['old_string']) + linesIn(o['new_string']) + linesIn(o['new_source']) + edits;
}

export async function readTranscriptDetail(file: string): Promise<DetailLine[]> {
	const text = await readTail(file);
	if (text === undefined) return [];
	const out: DetailLine[] = [];
	let rows = 0;
	const files = new Map<string, DetailFile>();
	const push = (...lines: string[]) => {
		for (const l of lines) {
			if (rows >= DETAIL_MAX_LINES) return;
			out.push(l);
			rows++;
		}
	};
	for (const e of entries(text)) {
		if (e.isSidechain === true) continue;
		const content = e.message?.content;
		if (e.type === 'user') {
			if (e.isMeta === true) continue;
			if (typeof content === 'string') {
				push('', ...content.split('\n').map((l, i) => (i === 0 ? `> ${l}` : `  ${l}`)));
				continue;
			}
			if (!Array.isArray(content)) continue;
			for (const b of content as Array<Record<string, unknown>>) {
				if (b?.['type'] !== 'tool_result') continue;
				const item = files.get(String(b['tool_use_id']));
				if (item !== undefined) {
					item.isError = b['is_error'] === true;
					const patch = toolPatch(e.toolUseResult ?? e.tool_use_result);
					if (patch !== undefined && (content as unknown[]).length === 1) item.patch = patch;
					continue;
				}
				const lines = capLines(blockText(b['content']), DETAIL_RESULT_LINES);
				push(...lines.map((l, i) => `${i === 0 ? '  ⎿ ' : '    '}${l}`), ...(b['is_error'] === true ? ['    (error)'] : []));
			}
			continue;
		}
		if (e.type !== 'assistant' || !Array.isArray(content)) continue;
		for (const b of content as Array<Record<string, unknown>>) {
			if (b?.['type'] === 'text' && typeof b['text'] === 'string') {
				push('');
				const shown = (b['text'] as string).split('\n').slice(0, Math.max(0, DETAIL_MAX_LINES - rows));
				if (shown.length > 0) {
					out.push({kind: 'text', text: shown.join('\n')});
					rows += shown.length;
				}
			}
			else if (b?.['type'] === 'thinking' && typeof b['thinking'] === 'string' && (b['thinking'] as string).trim()) {
				push('', '✻ Thinking', ...(b['thinking'] as string).split('\n').map(l => `  ${l}`));
			} else if (b?.['type'] === 'tool_use' && DETAIL_FILE_TOOLS.has(String(b['name']))) {
				const item: DetailFile = {kind: 'file', name: String(b['name']), input: b['input'] ?? {}, isError: false};
				const need = fileRows(item.input);
				if (rows + need > DETAIL_MAX_LINES) continue;
				push('');
				out.push(item);
				rows += need;
				if (typeof b['id'] === 'string') files.set(b['id'], item);
			} else if (b?.['type'] === 'tool_use') {
				const input = JSON.stringify(b['input'] ?? {}, null, 2) ?? '';
				push('', `● ${String(b['name'] ?? 'tool')}`, ...capLines(input, DETAIL_RESULT_LINES).map(l => `  ${l}`));
			}
		}
	}
	return out;
}
