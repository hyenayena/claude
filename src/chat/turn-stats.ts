import {diffLines} from './diff.js';
import type {ToolPatch} from './events.js';

export type TurnFileChange = {path: string; added: number; removed: number; created?: true};

export type TurnSummary = {
	durationMs: number;
	tools: number;
	files: TurnFileChange[];
	filesTotal: number;
	added: number;
	removed: number;
	outputTokens: number;
};

export const MAX_TURN_TOOL_IDS = 2000;
export const MAX_TURN_FILES = 200;
export const MAX_TURN_PATH = 1024;
// Control characters grow sixfold when the frame is JSON-escaped; without them 200 paths always fit one runner frame.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');
// The runner protocol rejects larger numbers.
const MAX_TURN_MS = 604_800_000;
const MAX_TURN_COUNT = 1_000_000_000;
const MAX_EDITS = 50;
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const field = (input: unknown, key: string): string => {
	if (typeof input !== 'object' || input === null) return '';
	const v = (input as Record<string, unknown>)[key];
	return typeof v === 'string' ? v : '';
};

const contentLines = (content: string): number => {
	if (content === '') return 0;
	const lines = content.split('\n').length;
	return content.endsWith('\n') ? lines - 1 : lines;
};

const patchEmpty = (patch: ToolPatch): boolean => patch.hunks.every(h => h.lines.length === 0);

const patchCounts = (patch: ToolPatch): {added: number; removed: number} => {
	let added = 0;
	let removed = 0;
	for (const h of patch.hunks) {
		for (const line of h.lines) {
			if (line[0] === '+') added++;
			else if (line[0] === '-') removed++;
		}
	}
	return {added, removed};
};

const stringsCounts = (oldText: string, newText: string): {added: number; removed: number} => {
	const p = diffLines(oldText, newText);
	return {added: p.added, removed: p.removed};
};

// The same numbers as the file card of the tool shows (ui/file-card.ts).
export function fileChange(name: string, input: unknown, patch?: ToolPatch): TurnFileChange | undefined {
	if (!FILE_TOOLS.has(name)) return undefined;
	let path = field(input, name === 'NotebookEdit' ? 'notebook_path' : 'file_path');
	if (path === '') return undefined;
	path = path.replace(CONTROL, '?').slice(0, MAX_TURN_PATH);
	switch (name) {
		case 'Edit':
		case 'MultiEdit': {
			if (patch !== undefined && !patchEmpty(patch)) return {path, ...patchCounts(patch)};
			const edits = typeof input === 'object' && input !== null ? (input as {edits?: unknown}).edits : undefined;
			if (name === 'Edit' || !Array.isArray(edits)) return {path, ...stringsCounts(field(input, 'old_string'), field(input, 'new_string'))};
			let added = 0;
			let removed = 0;
			for (const e of edits.slice(0, MAX_EDITS)) {
				const c = stringsCounts(field(e, 'old_string'), field(e, 'new_string'));
				added += c.added;
				removed += c.removed;
			}
			return {path, added, removed};
		}
		case 'Write': {
			if (patch === undefined || patch.created === true) return {path, added: contentLines(field(input, 'content')), removed: 0, created: true};
			return {path, ...(patchEmpty(patch) ? {added: 0, removed: 0} : patchCounts(patch))};
		}
		default: {
			const deleted = typeof input === 'object' && input !== null && (input as {edit_mode?: unknown}).edit_mode === 'delete';
			return {path, added: deleted ? 0 : contentLines(field(input, 'new_source')), removed: 0};
		}
	}
}

export class TurnStats {
	private readonly seen = new Set<string>();
	private readonly open = new Map<string, {name: string; input: unknown}>();
	private readonly byPath = new Map<string, TurnFileChange>();
	private readonly shown: TurnFileChange[] = [];
	private tools = 0;
	private added = 0;
	private removed = 0;

	use(id: string, name: string, input: unknown): void {
		if (this.seen.has(id) || this.seen.size >= MAX_TURN_TOOL_IDS) return;
		this.seen.add(id);
		this.tools++;
		if (FILE_TOOLS.has(name)) this.open.set(id, {name, input});
	}

	result(id: string, isError: boolean, patch?: ToolPatch): void {
		const call = this.open.get(id);
		if (call === undefined) return;
		this.open.delete(id);
		if (isError) return;
		const change = fileChange(call.name, call.input, patch);
		if (change === undefined) return;
		this.added += change.added;
		this.removed += change.removed;
		const known = this.byPath.get(change.path);
		if (known !== undefined) {
			known.added += change.added;
			known.removed += change.removed;
			return;
		}
		const entry: TurnFileChange = {...change};
		this.byPath.set(change.path, entry);
		if (this.shown.length < MAX_TURN_FILES) this.shown.push(entry);
	}

	finish(durationMs: number, outputTokens: number): TurnSummary {
		return {
			durationMs: Math.min(MAX_TURN_MS, Math.max(0, Math.round(durationMs))),
			tools: this.tools,
			files: this.shown.map(f => ({...f})),
			filesTotal: this.byPath.size,
			added: Math.min(MAX_TURN_COUNT, this.added),
			removed: Math.min(MAX_TURN_COUNT, this.removed),
			outputTokens: Math.min(MAX_TURN_COUNT, Math.max(0, Math.round(outputTokens))),
		};
	}
}
