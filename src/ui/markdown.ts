import {
	SGR_ATTR,
	SGR_RESET,
	colorDepth,
	glyph,
	hangingRows,
	paintTone,
	renderCodeFrame,
	sliceStyledCells,
	styledCells,
	toneSgr,
	wrapRows,
	type CodeToken,
	type ColorDepth,
} from '../kit.js';
import {fenceLanguage, highlighterFor} from './highlight.js';
import {inlineTokens, parseMarkdown, type InlineToken, type MdBlock} from './markdown-parse.js';
import {renderTable} from './markdown-table.js';

export {openFenceLine} from './markdown-parse.js';

export const CODE_BLOCK_ROWS = 120;

const DEFAULT_WIDTH = 100;
const CACHE_LIMIT = 512;
const HIGHLIGHT_LIMIT = 32;
const MAX_URL_SHOWN = 300;
const BULLETS = ['•', '◦', '▪'] as const;

export type CodeBlock = {row: number; code: string};

export type MarkdownOptions = {width?: number; copyLabel?: boolean; full?: boolean; ascii?: boolean};

export type MarkdownRows = {rows: string[]; codeBlocks: CodeBlock[]};

type Ctx = {width: number; copyLabel: boolean; full: boolean; ascii: boolean; depth: ColorDepth};

const CONTROL = new RegExp(
	`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}]`,
	'g',
);

function plainOf(tokens: readonly InlineToken[]): string {
	return tokens
		.map(t => {
			switch (t.kind) {
				case 'text':
				case 'escape':
				case 'code':
					return t.text;
				case 'link':
				case 'bold':
				case 'italic':
				case 'strike':
					return plainOf(t.children);
			}
		})
		.join('');
}

function inlineString(tokens: readonly InlineToken[], base: string, c: Ctx): string {
	let out = '';
	for (const t of tokens) {
		switch (t.kind) {
			case 'text':
			case 'escape':
				out += t.text;
				break;
			case 'code': {
				const open = toneSgr('code.inline', c.depth);
				out += open === '' ? `\`${t.text}\`` : `${open}${t.text}${SGR_RESET}${base}`;
				break;
			}
			case 'bold':
				out += `${SGR_ATTR.bold}${inlineString(t.children, base + SGR_ATTR.bold, c)}${SGR_ATTR.boldOff}${base}`;
				break;
			case 'italic':
				out += `${SGR_ATTR.italic}${inlineString(t.children, base + SGR_ATTR.italic, c)}${SGR_ATTR.italicOff}${base}`;
				break;
			case 'strike':
				out += `${SGR_ATTR.strike}${inlineString(t.children, base + SGR_ATTR.strike, c)}${SGR_ATTR.strikeOff}${base}`;
				break;
			case 'link': {
				const open = toneSgr('link', c.depth);
				out += `${open}${inlineString(t.children, base + open, c)}${SGR_RESET}${base}`;
				if (plainOf(t.children) !== t.url) {
					const url = t.url.length > MAX_URL_SHOWN ? `${t.url.slice(0, MAX_URL_SHOWN)}${glyph('ellipsis', {ascii: c.ascii})}` : t.url;
					out += `${toneSgr('muted', c.depth)} (${url})${SGR_RESET}${base}`;
				}
				break;
			}
		}
	}
	return out;
}

const inline = (text: string, base: string, c: Ctx): string => inlineString(inlineTokens(text), base, c);

// Wraps one styled paragraph; `base` is re-opened after the closing reset.
function styledRows(text: string, base: string, width: number, c: Ctx): string[] {
	const body = base === '' ? inline(text, '', c) : `${base}${inline(text, base, c)}${SGR_RESET}`;
	return wrapRows(body, width);
}

type Rendered = {rows: string[]; code?: {row: number; code: string}};

const highlights = new Map<string, readonly (readonly CodeToken[])[]>();

function highlightLines(lang: string, lines: readonly string[], depth: ColorDepth): (readonly CodeToken[])[] {
	const plain = (): (readonly CodeToken[])[] => lines.map(text => (text === '' ? [] : [{text}]));
	if (depth !== 'truecolor' && depth !== '256') return plain();
	const language = fenceLanguage(lang);
	if (language === undefined) return plain();
	const key = `${language}\0${lines.join('\n')}`;
	const hit = highlights.get(key);
	if (hit !== undefined) return [...hit];
	const tokens = highlighterFor(language)?.(lines);
	if (tokens === undefined) return plain();
	if (highlights.size >= HIGHLIGHT_LIMIT) highlights.clear();
	highlights.set(key, tokens);
	return [...tokens];
}

function renderCode(b: Extract<MdBlock, {kind: 'code'}>, c: Ctx): Rendered {
	const done = b.closed ? b.lines : b.lines.slice(0, -1);
	const tokens = highlightLines(b.lang, done, c.depth);
	if (!b.closed) {
		const partial = b.lines.at(-1);
		if (partial !== undefined && partial !== '') tokens.push([{text: partial}]);
	}
	const pad = ' '.repeat(b.indent);
	const frame = renderCodeFrame({
		lines: tokens,
		width: Math.max(1, c.width - b.indent),
		...(b.lang !== '' && {label: b.lang}),
		...(c.copyLabel && b.lines.length > 0 && {right: 'copy'}),
		open: !b.closed,
		...(!c.full && b.closed && {maxRows: CODE_BLOCK_ROWS}),
		ascii: c.ascii,
		depth: c.depth,
	});
	const rows = b.indent === 0 ? frame : frame.map(r => pad + r);
	return {rows, ...(b.lines.some(l => l !== '') && {code: {row: 0, code: b.lines.join('\n')}})};
}

function renderItem(b: Extract<MdBlock, {kind: 'item'}>, c: Ctx): string[] {
	const indent = Math.min(2 * b.depth, Math.floor(c.width / 3));
	const mark =
		b.marker === 'number'
			? `${String(b.number).padStart(b.digits)}.`
			: b.marker === 'task'
				? b.checked
					? '☑'
					: '☐'
				: BULLETS[b.depth % BULLETS.length]!;
	const prefix = `${' '.repeat(indent)}${paintTone(mark, 'accent', c.depth)} `;
	const pad = ' '.repeat(styledCells(prefix));
	const rows: string[] = [];
	b.lines.forEach((line, i) => {
		rows.push(...hangingRows(i === 0 ? prefix : pad, inline(line, '', c), c.width));
	});
	return rows;
}

function renderBlock(b: MdBlock, c: Ctx): Rendered {
	switch (b.kind) {
		case 'blank':
			return {rows: ['']};
		case 'paragraph':
			return {rows: b.lines.flatMap(l => styledRows(l, '', c.width, c))};
		case 'heading': {
			const base = b.level <= 2 ? toneSgr('heading', c.depth) : SGR_ATTR.bold;
			return {rows: styledRows(b.text, base, c.width, c)};
		}
		case 'item':
			return {rows: renderItem(b, c)};
		case 'quote': {
			const depth = Math.max(1, Math.min(b.depth, Math.floor((c.width - 1) / 4)));
			const prefix = `${paintTone(glyph('vRule', {ascii: c.ascii}), 'frame', c.depth)} `.repeat(depth);
			const base = toneSgr('muted', c.depth) + SGR_ATTR.italic;
			const room = Math.max(1, c.width - 2 * depth);
			if (b.text.trim() === '') return {rows: [prefix.trimEnd()]};
			return {rows: styledRows(b.text, base, room, c).map(r => prefix + r)};
		}
		case 'rule':
			return {rows: [paintTone(glyph('hRule', {ascii: c.ascii}).repeat(c.width), 'frame', c.depth)]};
		case 'code':
			return renderCode(b, c);
		case 'table':
			return {rows: renderTable(b.table, {width: c.width, inline: (t, base = '') => inline(t, base, c), depth: c.depth, ascii: c.ascii})};
	}
}

const blockCache = new Map<string, Rendered>();
const stats = {hits: 0, misses: 0};

// Test-only: how many blocks were rendered (misses) and reused (hits).
export const markdownCacheStats = (): {hits: number; misses: number} => ({...stats});
export function resetMarkdownCacheForTests(): void {
	blockCache.clear();
	highlights.clear();
	stats.hits = 0;
	stats.misses = 0;
}

function fit(row: string, width: number): string {
	return styledCells(row) > width ? sliceStyledCells(row, 0, width) : row;
}

// Blocks are cached by their source and layout, so a streaming tail re-renders only the block that changed.
function blockRows(b: MdBlock, c: Ctx): Rendered {
	const key = `${c.width}|${c.depth}|${c.copyLabel ? 1 : 0}|${c.full ? 1 : 0}|${c.ascii ? 1 : 0}|${b.kind}|${b.key}|${b.source}`;
	const hit = blockCache.get(key);
	if (hit !== undefined) {
		stats.hits++;
		return hit;
	}
	stats.misses++;
	const rendered = renderBlock(b, c);
	const done: Rendered = {rows: rendered.rows.map(r => fit(r, c.width)), ...(rendered.code !== undefined && {code: rendered.code})};
	if (blockCache.size >= CACHE_LIMIT) blockCache.clear();
	blockCache.set(key, done);
	return done;
}

export function renderMarkdownRows(text: string, options: MarkdownOptions = {}): MarkdownRows {
	const width = options.width !== undefined && Number.isFinite(options.width) ? Math.max(1, Math.floor(options.width)) : DEFAULT_WIDTH;
	const c: Ctx = {width, copyLabel: options.copyLabel === true, full: options.full === true, ascii: options.ascii === true, depth: colorDepth()};
	const clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(CONTROL, '');
	const blocks = parseMarkdown(clean);
	let first = 0;
	while (first < blocks.length && blocks[first]!.kind === 'blank') first++;
	let last = blocks.length;
	while (last > first && blocks[last - 1]!.kind === 'blank') last--;
	const rows: string[] = [];
	const codeBlocks: CodeBlock[] = [];
	for (const b of blocks.slice(first, last)) {
		const r = blockRows(b, c);
		if (r.code !== undefined) codeBlocks.push({row: rows.length + r.code.row, code: r.code.code});
		for (const row of r.rows) rows.push(row);
	}
	return {rows, codeBlocks};
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	return renderMarkdownRows(text, options).rows.join('\n');
}
