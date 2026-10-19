import {open, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {titleFromPrompt, transcriptFile} from './title.js';

const MAX_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SessionSummary = {sessionId: string; title: string; modified: number; prompts: number};
export type HistoryMessage = {role: 'user' | 'assistant'; text: string};

type Entry = {
	type?: unknown;
	isMeta?: unknown;
	isSidechain?: unknown;
	aiTitle?: unknown;
	customTitle?: unknown;
	message?: {id?: unknown; content?: unknown};
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

// A prompt the user typed: string content, not a tool result, not injected context.
const promptOf = (e: Entry): string | undefined =>
	e.type === 'user' && e.isMeta !== true && e.isSidechain !== true && typeof e.message?.content === 'string'
		? e.message.content
		: undefined;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Sessions of this project, newest first, with Claude Code's title or the first prompt. */
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

/** The last `limit` prompts and answers of a session, for showing a resumed chat. */
export async function readHistory(file: string, limit = 40): Promise<HistoryMessage[]> {
	const text = await readTail(file);
	if (text === undefined) return [];
	const out: HistoryMessage[] = [];
	let lastAssistantId: unknown;
	for (const e of entries(text)) {
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
		// Claude Code writes one line per content block; blocks of one message are joined.
		const last = out.at(-1);
		if (last?.role === 'assistant' && e.message.id !== undefined && e.message.id === lastAssistantId) last.text += text;
		else if (last?.role === 'assistant') last.text += `\n\n${text}`;
		else out.push({role: 'assistant', text});
		lastAssistantId = e.message.id;
	}
	return out.slice(-limit);
}
