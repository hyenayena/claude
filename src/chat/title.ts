import {open} from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;
const TITLE_MAX = 120;
const FALLBACK_MAX = 60;

/** Claude Code stores a project's transcripts under its cwd with every non-alphanumeric turned into "-". */
export const transcriptFile = (configDir: string, projectDir: string, sessionId: string): string =>
	path.join(configDir, 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * The session title Claude Code wrote into the transcript: a /rename title wins over the
 * generated one (`ai-title`); the last entry of each kind counts. Undefined when there is none yet.
 */
export async function readSessionTitle(file: string): Promise<string | undefined> {
	let text: string;
	try {
		const handle = await open(file, 'r');
		try {
			const {size} = await handle.stat();
			const length = Math.min(size, MAX_BYTES);
			const buf = Buffer.alloc(length);
			await handle.read(buf, 0, length, size - length);
			text = buf.toString('utf8');
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
	let custom: string | undefined;
	let generated: string | undefined;
	for (const line of text.split('\n')) {
		if (!line.includes('-title"')) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const e = entry as {type?: unknown; customTitle?: unknown; aiTitle?: unknown};
		if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) custom = e.customTitle.trim();
		if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) generated = e.aiTitle.trim();
	}
	const title = custom ?? generated;
	return title === undefined ? undefined : clip(title, TITLE_MAX);
}

/** A stand-in title from the first message, until Claude Code generates one. */
export function titleFromPrompt(text: string): string {
	const line = text.trim().split('\n')[0]?.trim() ?? '';
	return clip(line, FALLBACK_MAX);
}
