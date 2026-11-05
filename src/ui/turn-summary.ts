import type {TurnOutcome} from '../chat/events.js';
import type {TurnSummary} from '../chat/turn-stats.js';
import {colorDepth, formatElapsed, glyph, paintTone, sanitizeText, segmentBar, stringCells, truncateCells, type BarSegment, type ColorDepth} from '../kit.js';

export const SUMMARY_MIN_MS = 30_000;
const FILE_ROW_MAX_PATH = 4096;

export function formatTokens(n: number): string {
	const v = Math.max(0, Math.round(n));
	if (v < 1000) return String(v);
	if (v < 10_000) return `${(v / 1000).toFixed(1)}k`;
	if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
	return `${(v / 1_000_000).toFixed(1)}M`;
}

export function showSummary(summary: TurnSummary, outcome: TurnOutcome): boolean {
	return outcome !== 'ok' || summary.tools > 0 || summary.durationMs >= SUMMARY_MIN_MS;
}

export type SummaryRowOptions = {ascii?: boolean; depth?: ColorDepth};

export function turnSummaryRow(summary: TurnSummary, outcome: TurnOutcome, width: number, options: SummaryRowOptions = {}): string {
	const ascii = options.ascii === true;
	const depth = options.depth ?? colorDepth();
	const paint = (text: string, tone: Parameters<typeof paintTone>[1]): string => paintTone(text, tone, depth);
	const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
	const ok = outcome === 'ok';
	const mark = paint(glyph(ok ? 'check' : 'cross', {ascii}), ok ? 'ok' : outcome === 'interrupted' ? 'warn' : 'error');
	const label = outcome === 'interrupted' ? ` ${paint('interrupted', 'warn')}` : '';
	const segments: BarSegment[] = [{forms: [`${mark}${label} ${formatElapsed(summary.durationMs)}`], keep: true}];
	if (summary.filesTotal > 0) {
		const base = `${plural(summary.filesTotal, 'file')} changed`;
		const counts = `${paint(`+${summary.added}`, 'added')} ${paint(`${glyph('minus', {ascii})}${summary.removed}`, 'removed')}`;
		segments.push({forms: [`${base} ${counts}`]});
	}
	if (summary.tools > 0) segments.push({forms: [plural(summary.tools, 'tool')]});
	if (summary.outputTokens > 0) {
		const tokens = `↓ ${formatTokens(summary.outputTokens)}`;
		segments.push({forms: [`${tokens} tokens`, tokens]});
	}
	if (summary.filesTotal > 0) segments.push({forms: [paint('ctrl+o files', 'muted')]});
	return segmentBar(segments, Math.max(1, width), {depth, ascii});
}

// Rows of the "Changed in the last turn" section of the transcript viewer.
export function turnFilesRows(summary: TurnSummary, width: number, scrub: (s: string) => string, projectDir?: string, options: SummaryRowOptions = {}): string[] {
	if (summary.files.length === 0) return [];
	const ascii = options.ascii === true;
	const depth = options.depth ?? colorDepth();
	const max = Math.max(1, width);
	const rows = [paintTone('Changed in the last turn', 'heading', depth)];
	for (const f of summary.files) {
		const counts = `+${f.added} ${glyph('minus', {ascii})}${f.removed}`;
		const lead = `${glyph('toolEdit', {ascii})} `;
		const room = Math.max(1, max - stringCells(lead) - 2 - stringCells(counts));
		const shown = middleCut(sanitizeText(scrub(relativeTo(f.path, projectDir)), FILE_ROW_MAX_PATH), room, ascii);
		const pad = ' '.repeat(Math.max(0, room - stringCells(shown)) + 2);
		const row = `${paintTone(lead, 'muted', depth)}${shown}${pad}${paintTone(`+${f.added}`, 'added', depth)} ${paintTone(`${glyph('minus', {ascii})}${f.removed}`, 'removed', depth)}`;
		rows.push(row);
	}
	const more = summary.filesTotal - summary.files.length;
	if (more > 0) rows.push(paintTone(truncateCells(`${glyph('ellipsis', {ascii})} +${more} more`, max), 'muted', depth));
	return rows;
}

function relativeTo(path: string, dir: string | undefined): string {
	if (dir === undefined || dir === '') return path;
	const base = dir.endsWith('/') ? dir : `${dir}/`;
	return path.startsWith(base) ? path.slice(base.length) : path;
}

function middleCut(text: string, width: number, ascii: boolean): string {
	if (stringCells(text) <= width) return text;
	const dots = glyph('ellipsis', {ascii});
	if (width <= 1) return truncateCells(text, width);
	const chars = Array.from(text);
	const keepEnd = Math.ceil((width - 1) / 2);
	const keepStart = width - 1 - keepEnd;
	let end = chars.length;
	let tail = '';
	while (end > 0 && stringCells(chars[end - 1]! + tail) <= keepEnd) tail = chars[--end]! + tail;
	let head = '';
	for (const c of chars) {
		if (stringCells(head + c) > keepStart) break;
		head += c;
	}
	return `${head}${dots}${tail}`;
}
