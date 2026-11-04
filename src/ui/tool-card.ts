import {colorDepth, formatElapsed, glyph, paintTokens, ruledRows, statusRow, stringCells, truncateCells, wrapRows, type GlyphName, type ThemeTone} from '../kit.js';
import {FILE_TOOLS, formatFileCard} from './file-card.js';
import {highlighterFor} from './highlight.js';
import {sgr} from './sgr.js';
import {displayName, inputField, plural, refusalSummary, resultSummary, toolArgs, toolOneLiner, type Scrub} from './tool-args.js';
import {DURATION_MIN_MS, FAMILY_GLYPH, toolFamily, type ToolFamily} from './tool-kind.js';
import {ROUTE_TOOL_NAME, type RunningTool, type ToolOut} from './transcript.js';

export {DURATION_MIN_MS};

export const TOOL_RESULT_ROWS = 5;
export const BASH_TAIL_ROWS = TOOL_RESULT_ROWS;
export const RESULT_PREFIX = '  ⎿  ';
export type ToolLike = Omit<ToolOut, 'kind'>;

const RESULT_INDENT = '     ';
const RESULT_INPUT_CAP = 64 * 1024;
const NAMES_MIN_CELLS = 8;

export const resultLines = (lines: string[]): string[] => lines.map((l, i) => `${i === 0 ? RESULT_PREFIX : RESULT_INDENT}${l}`);

const paintRows = (style: string, text: string): string =>
	style === ''
		? text
		: text
				.split('\n')
				.map(line => `${style}${line}${sgr().reset}`)
				.join('\n');

type MarkKind = 'ok' | 'error' | 'refused';

function markOf(kind: MarkKind): string {
	const sg = sgr();
	if (kind === 'ok') return `${sg.ok}${glyph('check')}${sg.reset}`;
	return `${kind === 'error' ? sg.error : sg.muted}${glyph('cross')}${sg.reset}`;
}

const glyphOf = (family: ToolFamily): string => `${sgr().muted}${glyph(FAMILY_GLYPH[family])}${sgr().reset}`;

const durationText = (ms: number | undefined): string | undefined => (ms !== undefined && ms >= DURATION_MIN_MS ? formatElapsed(ms) : undefined);

function genericTitle(name: string, input: unknown, scrub: Scrub): string {
	const sg = sgr();
	if (name === ROUTE_TOOL_NAME && input === undefined) return `${sg.bold}${ROUTE_TOOL_NAME}${sg.boldOff}…`;
	const args = toolArgs(name, input, scrub);
	return `${sg.bold}${scrub(displayName(name))}${sg.boldOff}${args === '' ? '' : ` ${args}`}`;
}

export function errorReason(text: string): string {
	const cleaned = text.replace(/<\/?tool_use_error>/g, '');
	const line = cleaned.split('\n').find(l => l.trim() !== '') ?? '';
	const reason = line.replace(/^\s*Error:\s*/i, '').replace(/\s+/g, ' ').trim();
	return reason === '' ? 'failed' : reason;
}

export function bashExit(text: string): {code?: number; rest: string} {
	const m = /^Exit code (\d{1,5})[ \t]*(?:\r?\n|$)/.exec(text);
	return m === null ? {rest: text} : {code: Number(m[1]), rest: text.slice(m[0].length)};
}

const reasonRow = (text: string, scrub: Scrub, width: number): string =>
	paintRows(sgr().error, truncateCells(`${RESULT_PREFIX}${errorReason(scrub(text.slice(0, RESULT_INPUT_CAP)))}`, width));

function hangingBody(text: string, scrub: Scrub, width: number): string[] {
	const body = scrub(text.slice(0, RESULT_INPUT_CAP)).replace(/\n+$/, '');
	if (body.trim() === '') return [];
	const inner = Math.max(1, width - RESULT_PREFIX.length);
	const rows = body.split('\n').flatMap(l => wrapRows(l, inner, {mode: 'char'}));
	let shown = rows;
	if (rows.length > TOOL_RESULT_ROWS) {
		const kept = TOOL_RESULT_ROWS - 1;
		shown = [...rows.slice(0, kept), truncateCells(`… +${rows.length - kept} lines (ctrl+o to expand)`, inner)];
	}
	return [paintRows(sgr().muted, resultLines(shown).join('\n'))];
}

function genericCard(t: ToolLike, scrub: Scrub, width: number): string {
	const refusal = refusalSummary(t);
	const kind: MarkKind = refusal !== undefined ? 'refused' : t.isError ? 'error' : 'ok';
	const summary = resultSummary(t);
	const right = durationText(t.durationMs);
	const header = statusRow({
		mark: markOf(kind),
		glyph: glyphOf(toolFamily(t.name)),
		title: genericTitle(t.name, t.input, scrub),
		...(summary !== undefined && {detail: `· ${summary}`}),
		...(right !== undefined && {right}),
		width,
	});
	if (summary !== undefined) return header;
	if (t.isError) return `${header}\n${reasonRow(t.text, scrub, width)}`;
	return [header, ...hangingBody(t.text, scrub, width)].join('\n');
}

function bashTitle(command: string): string {
	const tokens = highlighterFor('bash')?.([command])?.[0];
	return tokens === undefined ? command : paintTokens(tokens, colorDepth());
}

function bashCard(t: ToolLike, scrub: Scrub, width: number): string {
	const refusal = refusalSummary(t);
	const kind: MarkKind = refusal !== undefined ? 'refused' : t.isError ? 'error' : 'ok';
	const lines = scrub(inputField(t.input, 'command'))
		.split('\n')
		.map(l => l.replace(/\s+$/, ''))
		.filter(l => l.trim() !== '');
	const first = (lines[0] ?? '').replace(/\t/g, ' ');
	const extra = lines.length - 1;
	const exit = refusal === undefined && t.isError ? bashExit(t.text) : {rest: t.text};
	const failed = exit.code !== undefined && exit.code !== 0;
	const background = typeof t.input === 'object' && t.input !== null && (t.input as {run_in_background?: unknown}).run_in_background === true;
	const duration = durationText(t.durationMs);
	const right = [failed ? `exit ${exit.code}` : undefined, background ? 'in background' : undefined, duration].filter((p): p is string => p !== undefined).join(' · ');
	const tone: ThemeTone = failed ? 'error' : 'muted';
	const header = statusRow({
		mark: markOf(kind),
		glyph: glyphOf('shell'),
		title: bashTitle(first),
		...(refusal !== undefined ? {detail: `· ${refusal}`} : extra > 0 ? {detail: `+${extra} lines`} : {}),
		...(right !== '' && {right, rightTone: tone}),
		width,
	});
	if (refusal !== undefined) return header;
	const output = scrub(exit.rest.slice(0, RESULT_INPUT_CAP)).replace(/\n+$/, '');
	const rows = [header];
	const noCode = t.isError && exit.code === undefined;
	if (noCode) rows.push(reasonRow(t.text, scrub, width));
	const multi = output.split('\n').filter(l => l.trim() !== '').length > 1;
	if (output.trim() !== '' && (!noCode || multi)) {
		rows.push(...ruledRows(output.split('\n'), {width, maxRows: BASH_TAIL_ROWS, keep: 'tail'}));
	}
	return rows.join('\n');
}

export function formatToolCard(t: ToolLike, scrub: Scrub, width = 100): string {
	const w = Math.max(1, Math.floor(width));
	if (refusalSummary(t) === undefined && !t.isError && (FILE_TOOLS as readonly string[]).includes(t.name)) {
		const card = formatFileCard(t, scrub, w, t.durationMs !== undefined ? {durationMs: t.durationMs} : {});
		if (card !== '') return card;
	}
	return t.name === 'Bash' ? bashCard(t, scrub, w) : genericCard(t, scrub, w);
}

const base = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path;

export type FoldSummary = {title: string; names: string[]; glyph: GlyphName};

export function foldSummary(items: readonly ToolLike[], scrub: Scrub = s => s): FoldSummary {
	const reads = new Set<string>();
	const greps = new Set<string>();
	const globs = new Set<string>();
	const dirs = new Set<string>();
	const order: ('read' | 'grep' | 'glob' | 'ls')[] = [];
	const names: string[] = [];
	const seen = new Set<string>();
	const note = (kind: (typeof order)[number], set: Set<string>, value: string, label: string): void => {
		if (!order.includes(kind)) order.push(kind);
		set.add(value);
		if (!seen.has(`${kind}:${value}`)) {
			seen.add(`${kind}:${value}`);
			names.push(label);
		}
	};
	for (const t of items) {
		switch (t.name) {
			case 'Read': {
				const path = scrub(inputField(t.input, 'file_path'));
				note('read', reads, path, base(path));
				break;
			}
			case 'Grep': {
				const pattern = scrub(inputField(t.input, 'pattern'));
				note('grep', greps, pattern, `"${pattern}"`);
				break;
			}
			case 'Glob': {
				const pattern = scrub(inputField(t.input, 'pattern'));
				note('glob', globs, pattern, pattern);
				break;
			}
			case 'LS': {
				const path = scrub(inputField(t.input, 'path'));
				note('ls', dirs, path, base(path));
				break;
			}
		}
	}
	const part = (kind: (typeof order)[number]): string => {
		switch (kind) {
			case 'read':
				return `Read ${plural(reads.size, 'file')}`;
			case 'grep':
				return `searched ${plural(greps.size, 'pattern')}`;
			case 'glob':
				return `matched ${plural(globs.size, 'glob')}`;
			case 'ls':
				return `listed ${plural(dirs.size, 'dir')}`;
		}
	};
	const title = order.map(part).join(', ');
	const cap = title === '' ? title : title[0]!.toUpperCase() + title.slice(1);
	return {title: cap, names, glyph: reads.size > 0 || dirs.size > 0 ? FAMILY_GLYPH.read : FAMILY_GLYPH.search};
}

function spanMs(items: readonly ToolLike[]): number | undefined {
	let start = Infinity;
	let end = -Infinity;
	for (const t of items) {
		if (t.startedAt === undefined || t.durationMs === undefined) return undefined;
		start = Math.min(start, t.startedAt);
		end = Math.max(end, t.startedAt + t.durationMs);
	}
	return end >= start ? end - start : undefined;
}

export function formatToolGroup(items: readonly ToolLike[], scrub: Scrub, width = 100): string {
	if (items.length === 1) return formatToolCard(items[0]!, scrub, width);
	const w = Math.max(1, Math.floor(width));
	const sg = sgr();
	const sum = foldSummary(items, scrub);
	const right = durationText(spanMs(items));
	const headCells = 4 + stringCells(sum.title);
	const budget = w - headCells - 2 - (right === undefined ? 0 : 2 + stringCells(right));
	const names = budget >= NAMES_MIN_CELLS ? truncateCells(sum.names.join(', '), budget) : '';
	return statusRow({
		mark: markOf('ok'),
		glyph: `${sg.muted}${glyph(sum.glyph)}${sg.reset}`,
		title: `${sg.bold}${sum.title}${sg.boldOff}`,
		...(names !== '' && {detail: names}),
		...(right !== undefined && {right}),
		width: w,
	});
}

export function runningToolRow(tool: RunningTool, scrub: Scrub, width: number, frame: string, now: number): string {
	const sg = sgr();
	const family = toolFamily(tool.name);
	const title = tool.name === 'Bash' ? toolArgs(tool.name, tool.input, scrub) : genericTitle(tool.name, tool.input, scrub);
	const elapsed = tool.startedAt !== undefined ? Math.max(0, now - tool.startedAt) : tool.elapsedSeconds * 1000;
	const right = durationText(elapsed);
	return statusRow({
		mark: `${sg.accent}${frame}${sg.reset}`,
		glyph: glyphOf(family),
		title,
		...(tool.activity !== undefined && {detail: `${glyph('arrow')} ${toolOneLiner(tool.activity.name, tool.activity.input, scrub)}`}),
		...(right !== undefined && {right}),
		width: Math.max(1, Math.floor(width)),
	});
}
