import {diffLines} from '../deps/chat.js';
import type {ToolPatch} from '../deps/chat.js';
import type {Preview} from '../deps/chat.js';
import {prepareDiffCard, renderDiffCard, colorDepth, formatElapsed, glyph, type DiffCard, type DiffCardRow, type PreparedDiffCard} from '../kit.js';
import {highlighterFor, highlighterReady, languageFor} from './highlight.js';
import {sgr} from './sgr.js';
import {DURATION_MIN_MS, FAMILY_GLYPH} from './tool-kind.js';

export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
export const FILE_CARD_ROWS = 40;
export const FILE_CARD_TAIL = 8;
export const WRITE_HEAD_LINES = 10;

export type FileToolInput = {name: string; input: unknown; isError: boolean; patch?: ToolPatch};

type Scrub = (s: string) => string;

const isFileTool = (name: string): boolean => (FILE_TOOLS as readonly string[]).includes(name);

const field = (input: unknown, key: string): string => {
	if (typeof input !== 'object' || input === null) return '';
	const v = (input as Record<string, unknown>)[key];
	return typeof v === 'string' ? v : '';
};

const dropCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

const isEmpty = (patch: ToolPatch): boolean => patch.hunks.every(h => h.lines.length === 0);

const contentLines = (content: string): string[] => {
	if (content === '') return [];
	const lines = content.split('\n');
	if (content.endsWith('\n')) lines.pop();
	return lines;
};

type Counted = {rows: DiffCardRow[]; added: number; removed: number};

export function patchRows(patch: ToolPatch): Counted {
	const rows: DiffCardRow[] = [];
	let added = 0;
	let removed = 0;
	patch.hunks.forEach((h, i) => {
		const prev = patch.hunks[i - 1];
		if (prev !== undefined) {
			const prevOld = prev.lines.filter(l => l[0] === ' ' || l[0] === '-').length;
			const gap = h.oldStart - (prev.oldStart + prevOld);
			if (gap > 0) rows.push({kind: 'fold', count: gap});
		}
		let o = h.oldStart;
		let n = h.newStart;
		for (const line of h.lines) {
			const text = dropCr(line.slice(1));
			switch (line[0]) {
				case ' ':
					rows.push({kind: 'ctx', text, oldNo: o++, newNo: n++});
					break;
				case '-':
					rows.push({kind: 'del', text, oldNo: o++});
					removed++;
					break;
				case '+':
					rows.push({kind: 'add', text, newNo: n++});
					added++;
					break;
			}
		}
	});
	return {rows, added, removed};
}

function stringsRows(oldText: string, newText: string): Counted {
	const preview = diffLines(oldText, newText);
	const rows = preview.rows.map((r): DiffCardRow => {
		if (r.kind === 'gap') return r.count !== undefined ? {kind: 'fold', count: r.count} : {kind: 'fold', text: r.text};
		if (r.kind === 'meta') return {kind: 'note', text: r.text};
		return {kind: r.kind, text: r.text};
	});
	return {rows, added: preview.added, removed: preview.removed};
}

function editsRows(input: unknown): Counted {
	const edits = typeof input === 'object' && input !== null ? (input as {edits?: unknown}).edits : undefined;
	const out: Counted = {rows: [], added: 0, removed: 0};
	if (!Array.isArray(edits)) return stringsRows(field(input, 'old_string'), field(input, 'new_string'));
	for (const e of edits.slice(0, 50)) {
		const part = stringsRows(field(e, 'old_string'), field(e, 'new_string'));
		if (part.rows.length === 0) continue;
		if (out.rows.length > 0) out.rows.push({kind: 'fold'});
		out.rows.push(...part.rows);
		out.added += part.added;
		out.removed += part.removed;
	}
	return out;
}

function headRows(lines: string[], full: boolean): DiffCardRow[] {
	const shown = full ? lines : lines.slice(0, WRITE_HEAD_LINES);
	const rows = shown.map((l, i): DiffCardRow => ({kind: 'add', text: dropCr(l), newNo: i + 1}));
	if (shown.length < lines.length) rows.push({kind: 'note', text: `… +${lines.length - shown.length} lines (ctrl+o to expand)`});
	return rows;
}

export function fileCardOf(t: FileToolInput, options: {full?: boolean} = {}): DiffCard | undefined {
	const full = options.full === true;
	const path = field(t.input, t.name === 'NotebookEdit' ? 'notebook_path' : 'file_path');
	if (!isFileTool(t.name) || path === '') return undefined;
	const card = (extra: Omit<DiffCard, 'path' | 'tool'>): DiffCard => ({path, tool: t.name, ...extra});
	switch (t.name) {
		case 'Edit':
		case 'MultiEdit': {
			const c = t.patch !== undefined && !isEmpty(t.patch) ? patchRows(t.patch) : t.name === 'Edit' ? stringsRows(field(t.input, 'old_string'), field(t.input, 'new_string')) : editsRows(t.input);
			return card(c);
		}
		case 'Write': {
			if (t.patch === undefined || t.patch.created === true) {
				const lines = contentLines(field(t.input, 'content'));
				return card({created: true, added: lines.length, removed: 0, rows: headRows(lines, full)});
			}
			if (isEmpty(t.patch)) return card({added: 0, removed: 0, rows: []});
			return card(patchRows(t.patch));
		}
		default: {
			if (typeof t.input === 'object' && t.input !== null && (t.input as {edit_mode?: unknown}).edit_mode === 'delete') {
				return card({added: 0, removed: 0, rows: [{kind: 'note', text: 'cell deleted'}]});
			}
			const lines = contentLines(field(t.input, 'new_source'));
			return card({plain: true, added: lines.length, removed: 0, rows: headRows(lines, full)});
		}
	}
}

function languageOf(card: DiffCard, input: unknown): string | undefined {
	if (card.tool === 'NotebookEdit') return field(input, 'cell_type') === 'markdown' ? 'markdown' : 'python';
	const first = card.rows.find((r): r is Extract<DiffCardRow, {text: string}> => r.kind !== 'fold' && r.kind !== 'note');
	return languageFor(card.path, first?.text);
}

type Entry = {
	scrub: Scrub;
	prepared: PreparedDiffCard;
	highlighted: boolean;
	lead: string;
	layout?: {width: number; depth: string; durationMs: number | undefined; text: string};
};

const cache = new WeakMap<object, {chat?: Entry; full?: Entry}>();

function entryFor(t: FileToolInput, scrub: Scrub, full: boolean): Entry | undefined {
	const slot = full ? 'full' : 'chat';
	let bySlot = cache.get(t);
	const hit = bySlot?.[slot];
	if (hit !== undefined && hit.scrub === scrub && (hit.highlighted || !highlighterReady())) return hit;
	const card = fileCardOf(t, {full});
	if (card === undefined) return undefined;
	const highlight = highlighterFor(languageOf(card, t.input));
	const prepared = prepareDiffCard(
		{...card, path: scrub(card.path)},
		{scrub: line => scrub(line).split('\n').join(' '), ...(highlight !== undefined && {highlight})},
	);
	const entry: Entry = {scrub, prepared, highlighted: highlighterReady(), lead: ''};
	if (bySlot === undefined) cache.set(t, (bySlot = {}));
	bySlot[slot] = entry;
	return entry;
}

export function formatFileCard(t: FileToolInput, scrub: Scrub, width = 100, options: {full?: boolean; durationMs?: number} = {}): string {
	const full = options.full === true;
	const durationMs = options.durationMs;
	const entry = entryFor(t, scrub, full);
	if (entry === undefined) return '';
	const depth = colorDepth();
	if (entry.layout !== undefined && entry.layout.width === width && entry.layout.depth === depth && entry.layout.durationMs === durationMs) return entry.layout.text;
	const sg = sgr();
	const name = scrub(t.name);
	const lead = `${sg.ok}${glyph('check')}${sg.reset} ${sg.muted}${glyph(FAMILY_GLYPH.edit)}${sg.reset} ${sg.bold}${name}${sg.boldOff}`;
	const rows = renderDiffCard(entry.prepared, {
		width: Math.max(1, width),
		depth,
		lead,
		...(durationMs !== undefined && durationMs >= DURATION_MIN_MS && {right: formatElapsed(durationMs)}),
		...(full ? {} : {maxRows: FILE_CARD_ROWS, tailRows: FILE_CARD_TAIL}),
	});
	const text = rows.join('\n');
	entry.layout = {width, depth, durationMs, text};
	return text;
}

const previewCache = new WeakMap<Preview, {reveal: Scrub; highlighted: boolean; prepared: PreparedDiffCard}>();

export function previewCardRows(preview: Preview, path: string, reveal: Scrub, width: number): string[] {
	let hit = previewCache.get(preview);
	if (hit === undefined || hit.reveal !== reveal || (!hit.highlighted && highlighterReady())) {
		const rows: DiffCardRow[] = preview.rows.map((r): DiffCardRow => {
			switch (r.kind) {
				case 'gap':
					return r.count !== undefined ? {kind: 'fold', count: r.count} : {kind: 'note', text: r.text};
				case 'meta':
					return {kind: 'note', text: r.text};
				case 'ctx':
					return {kind: 'ctx', text: r.text, ...numbers(r.oldNo ?? r.no, r.newNo ?? r.no)};
				case 'del':
					return {kind: 'del', text: r.text, ...numbers(r.oldNo ?? r.no, undefined)};
				case 'add':
					return {kind: 'add', text: r.text, ...numbers(undefined, r.newNo ?? r.no)};
			}
		});
		const created = preview.rows.some(r => r.kind === 'add') && preview.rows.every(r => r.kind === 'add' || r.kind === 'gap' || r.kind === 'meta');
		const card: DiffCard = {path: reveal(path), added: preview.added, removed: preview.removed, ...(created && {created: true}), rows};
		const first = rows.find((r): r is Extract<DiffCardRow, {text: string}> => r.kind !== 'fold' && r.kind !== 'note');
		const highlight = highlighterFor(languageFor(path, first?.text));
		const prepared = prepareDiffCard(card, {scrub: line => reveal(line).split('\n').join(' '), ...(highlight !== undefined && {highlight})});
		hit = {reveal, highlighted: highlighterReady(), prepared};
		previewCache.set(preview, hit);
	}
	return renderDiffCard(hit.prepared, {width: Math.max(1, width), header: false, indent: 0, rule: false});
}

const numbers = (oldNo: number | undefined, newNo: number | undefined): {oldNo?: number; newNo?: number} => ({
	...(oldNo !== undefined && {oldNo}),
	...(newNo !== undefined && {newNo}),
});
