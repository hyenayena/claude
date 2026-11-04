import {matchTable, type Table} from './markdown-table.js';

export type ItemMarker = 'bullet' | 'number' | 'task';

type Base = {source: string; key: string};

export type MdBlock =
	| (Base & {kind: 'paragraph'; lines: string[]})
	| (Base & {kind: 'heading'; level: number; text: string})
	| (Base & {kind: 'item'; depth: number; marker: ItemMarker; number: number; digits: number; checked: boolean; lines: string[]})
	| (Base & {kind: 'quote'; depth: number; text: string})
	| (Base & {kind: 'code'; lang: string; marker: string; indent: number; lines: string[]; closed: boolean})
	| (Base & {kind: 'table'; table: Table})
	| (Base & {kind: 'rule'})
	| (Base & {kind: 'blank'});

export const MAX_LIST_DEPTH = 6;
export const MAX_QUOTE_DEPTH = 4;
const MAX_FENCE_LINE = 200;
const MAX_TABLE_LINE = 4000;
const MAX_INDENT = 8;

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isWhite = (c: string | undefined): boolean => c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '\r';

function indentOf(line: string): number {
	let n = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === ' ') n++;
		else if (c === '\t') n += 4;
		else break;
	}
	return n;
}

type Fence = {marker: string; lang: string; indent: number};

function fenceOpen(line: string): Fence | undefined {
	if (line.length > MAX_FENCE_LINE) return undefined;
	const indent = indentOf(line);
	const rest = line.trimStart();
	const ch = rest[0];
	if (ch !== '`' && ch !== '~') return undefined;
	let n = 0;
	while (rest[n] === ch) n++;
	if (n < 3) return undefined;
	const info = rest.slice(n).trim();
	if (ch === '`' && info.includes('`')) return undefined;
	const lang = info.split(/\s/, 1)[0] ?? '';
	return {marker: ch.repeat(n), lang: lang.slice(0, 40), indent};
}

function fenceCloses(line: string, open: Fence): boolean {
	if (line.length > MAX_FENCE_LINE) return false;
	const rest = line.trim();
	const ch = open.marker[0]!;
	let n = 0;
	while (rest[n] === ch) n++;
	return n >= open.marker.length && n === rest.length;
}

// A line of three or more of one of - * _, spaces allowed between.
function isRule(line: string): boolean {
	let mark: string | undefined;
	let count = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (isSpace(c)) continue;
		if (c !== '-' && c !== '*' && c !== '_') return false;
		if (mark !== undefined && c !== mark) return false;
		mark = c;
		count++;
	}
	return count >= 3;
}

function headingOf(line: string): {level: number; text: string} | undefined {
	let n = 0;
	while (line[n] === '#') n++;
	if (n < 1 || n > 6 || !isSpace(line[n])) return undefined;
	return {level: n, text: line.slice(n).trim()};
}

function quoteOf(line: string): {depth: number; text: string} | undefined {
	let i = 0;
	let depth = 0;
	for (;;) {
		let spaces = 0;
		while (isSpace(line[i]) && spaces < 4) {
			i++;
			spaces++;
		}
		if (line[i] !== '>') break;
		depth++;
		i++;
		if (line[i] === ' ') i++;
	}
	return depth === 0 ? undefined : {depth, text: line.slice(i)};
}

type ItemStart = {indent: number; marker: ItemMarker; number: number; checked: boolean; text: string};

function itemOf(line: string): ItemStart | undefined {
	const indent = indentOf(line);
	const rest = line.trimStart();
	let marker: ItemMarker = 'bullet';
	let number = 0;
	let after: string;
	const c = rest[0];
	if ((c === '-' || c === '*' || c === '+') && isSpace(rest[1])) {
		after = rest.slice(1).trimStart();
	} else if (c !== undefined && c >= '0' && c <= '9') {
		let n = 0;
		while (n < 9 && rest[n]! >= '0' && rest[n]! <= '9') n++;
		if ((rest[n] !== '.' && rest[n] !== ')') || !isSpace(rest[n + 1])) return undefined;
		marker = 'number';
		number = Number(rest.slice(0, n));
		after = rest.slice(n + 1).trimStart();
	} else {
		return undefined;
	}
	let checked = false;
	if (marker === 'bullet' && after.length >= 3 && after[0] === '[' && after[2] === ']' && (after[1] === ' ' || after[1] === 'x' || after[1] === 'X') && isWhite(after[3])) {
		marker = 'task';
		checked = after[1] !== ' ';
		after = after.slice(3).trimStart();
	}
	return {indent, marker, number, checked, text: after};
}

function startsBlock(lines: readonly string[], i: number): boolean {
	const line = lines[i]!;
	if (fenceOpen(line) !== undefined || headingOf(line) !== undefined || quoteOf(line) !== undefined) return true;
	if (isRule(line) || itemOf(line) !== undefined) return true;
	return tableAt(lines, i) !== undefined;
}

function tableAt(lines: readonly string[], i: number): Table | undefined {
	const line = lines[i]!;
	if (!line.includes('|') || line.length > MAX_TABLE_LINE) return undefined;
	const next = lines[i + 1];
	if (next === undefined || next.length > MAX_TABLE_LINE) return undefined;
	return matchTable(lines as string[], i);
}

export function parseMarkdown(text: string): MdBlock[] {
	const lines = text.split('\n');
	const blocks: MdBlock[] = [];
	let stack: number[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const fence = fenceOpen(line);
		if (fence !== undefined) {
			const body: string[] = [];
			let j = i + 1;
			let closed = false;
			for (; j < lines.length; j++) {
				if (fenceCloses(lines[j]!, fence)) {
					closed = true;
					break;
				}
				body.push(lines[j]!);
			}
			const indent = Math.min(fence.indent, MAX_INDENT);
			const content = body.map(l => stripIndent(l, fence.indent));
			const end = closed ? j + 1 : j;
			const source = lines.slice(i, end).join('\n');
			blocks.push({kind: 'code', source, key: `${fence.lang}|${indent}|${closed ? 1 : 0}`, lang: fence.lang, marker: fence.marker, indent, lines: content, closed});
			i = end;
			continue;
		}
		if (line.trim() === '') {
			blocks.push({kind: 'blank', source: '', key: ''});
			i++;
			continue;
		}
		const table = tableAt(lines, i);
		if (table !== undefined) {
			blocks.push({kind: 'table', source: lines.slice(i, table.end).join('\n'), key: '', table});
			stack = [];
			i = table.end;
			continue;
		}
		const heading = headingOf(line);
		if (heading !== undefined) {
			blocks.push({kind: 'heading', source: line, key: String(heading.level), level: heading.level, text: heading.text});
			stack = [];
			i++;
			continue;
		}
		if (isRule(line)) {
			blocks.push({kind: 'rule', source: line, key: ''});
			stack = [];
			i++;
			continue;
		}
		const quote = quoteOf(line);
		if (quote !== undefined) {
			const depth = Math.min(quote.depth, MAX_QUOTE_DEPTH);
			blocks.push({kind: 'quote', source: line, key: String(depth), depth, text: quote.text});
			stack = [];
			i++;
			continue;
		}
		const item = itemOf(line);
		if (item !== undefined) {
			while (stack.length > 0 && stack[stack.length - 1]! >= item.indent) stack.pop();
			stack.push(item.indent);
			const depth = Math.min(stack.length - 1, MAX_LIST_DEPTH - 1);
			const body = [item.text];
			let j = i + 1;
			for (; j < lines.length; j++) {
				const next = lines[j]!;
				if (next.trim() === '' || indentOf(next) <= item.indent || startsBlock(lines, j)) break;
				body.push(next.trim());
			}
			const digits = item.marker === 'number' ? String(item.number).length : 0;
			blocks.push({
				kind: 'item',
				source: lines.slice(i, j).join('\n'),
				key: `${depth}|${item.marker}|${item.number}|${item.checked ? 1 : 0}`,
				depth,
				marker: item.marker,
				number: item.number,
				digits,
				checked: item.checked,
				lines: body,
			});
			i = j;
			continue;
		}
		stack = [];
		const body = [line];
		let j = i + 1;
		for (; j < lines.length; j++) {
			if (lines[j]!.trim() === '' || startsBlock(lines, j)) break;
			body.push(lines[j]!);
		}
		blocks.push({kind: 'paragraph', source: body.join('\n'), key: '', lines: body});
		i = j;
	}
	alignNumbers(blocks);
	return blocks;
}

function stripIndent(line: string, indent: number): string {
	let n = 0;
	while (n < indent && line[n] === ' ') n++;
	return line.slice(n);
}

// Numbers of one list share the widest number's digits so the texts line up; the key follows it.
function alignNumbers(blocks: MdBlock[]): void {
	let run: Extract<MdBlock, {kind: 'item'}>[] = [];
	const flush = (): void => {
		const digits = Math.max(0, ...run.map(b => b.digits));
		for (const b of run) {
			b.digits = digits;
			b.key += `|${digits}`;
		}
		run = [];
	};
	for (const b of blocks) {
		if (b.kind === 'item' && b.depth === 0 && b.marker === 'number') run.push(b);
		else if (b.kind === 'blank' || (b.kind === 'item' && b.depth > 0)) continue;
		else flush();
	}
	flush();
}

// The line that opened a fence still unclosed at the end of the text.
export function openFenceLine(text: string): string | undefined {
	let open: {line: string; fence: Fence} | undefined;
	for (const line of text.split('\n')) {
		if (open === undefined) {
			const f = fenceOpen(line);
			if (f !== undefined) open = {line, fence: f};
		} else if (fenceCloses(line, open.fence)) {
			open = undefined;
		}
	}
	return open?.line;
}

export type InlineToken =
	| {kind: 'text'; text: string}
	| {kind: 'escape'; text: string}
	| {kind: 'code'; text: string}
	| {kind: 'bold' | 'italic' | 'strike'; children: InlineToken[]}
	| {kind: 'link'; children: InlineToken[]; url: string};

const MAX_INLINE_DEPTH = 4;
const MAX_URL = 2000;
const ESCAPABLE = '\\`*_{}[]()#+-.!|~>';

type Span = {end: number; content: [number, number]};

// Backtick runs are indexed once: an opener meets the next run of equal length (or stays literal).
function codeSpans(text: string): Map<number, Span> {
	const byLen = new Map<number, number[]>();
	const runs: Array<[number, number]> = [];
	for (let i = 0; i < text.length; ) {
		const c = text[i];
		if (c === '\\' && i + 1 < text.length && ESCAPABLE.includes(text[i + 1]!)) {
			i += 2;
			continue;
		}
		if (c !== '`') {
			i++;
			continue;
		}
		let n = 0;
		while (text[i + n] === '`') n++;
		runs.push([i, n]);
		i += n;
	}
	const spans = new Map<number, Span>();
	const slots = new Map<number, number>();
	for (const [pos, len] of runs) {
		let list = byLen.get(len);
		if (!list) byLen.set(len, (list = []));
		list.push(pos);
	}
	let consumed = -1;
	for (const [pos, len] of runs) {
		if (pos < consumed) continue;
		const list = byLen.get(len)!;
		let k = slots.get(len) ?? 0;
		while (k < list.length && list[k]! <= pos) k++;
		slots.set(len, k);
		if (k >= list.length) continue;
		const close = list[k]!;
		spans.set(pos, {end: close + len, content: [pos + len, close]});
		consumed = close + len;
	}
	return spans;
}

type Scan = {text: string; spans: Map<number, Span>};

function isAlnum(c: string | undefined): boolean {
	return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

function findCloser(s: Scan, from: number, to: number, ch: string, n: number): number {
	const {text} = s;
	for (let j = from; j < to; ) {
		const span = s.spans.get(j);
		if (span !== undefined) {
			j = span.end;
			continue;
		}
		const c = text[j];
		if (c === '\\' && j + 1 < to && ESCAPABLE.includes(text[j + 1]!)) {
			j += 2;
			continue;
		}
		if (c !== ch) {
			j++;
			continue;
		}
		let run = 0;
		while (j + run < to && text[j + run] === ch) run++;
		const before = text[j - 1];
		const after = text[j + run];
		const valid = run >= n && (n > 1 || run === 1) && j > from && !isWhite(before) && !(ch === '_' && isAlnum(after));
		if (valid) return j + run - n;
		j += run;
	}
	return -1;
}

function tokenize(s: Scan, from: number, to: number, depth: number): InlineToken[] {
	const {text} = s;
	const out: InlineToken[] = [];
	// Per call: a miss only holds for this range's end.
	const failed = new Set<string>();
	let buf = '';
	const flush = (): void => {
		if (buf !== '') out.push({kind: 'text', text: buf});
		buf = '';
	};
	let i = from;
	while (i < to) {
		const c = text[i]!;
		const span = s.spans.get(i);
		if (span !== undefined && span.end <= to) {
			flush();
			let code = text.slice(span.content[0], span.content[1]).replace(/\n/g, ' ');
			if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') code = code.slice(1, -1);
			out.push({kind: 'code', text: code});
			i = span.end;
			continue;
		}
		if (c === '\\' && i + 1 < to && ESCAPABLE.includes(text[i + 1]!)) {
			flush();
			out.push({kind: 'escape', text: text[i + 1]!});
			i += 2;
			continue;
		}
		if (depth < MAX_INLINE_DEPTH && (c === '*' || c === '_' || c === '~')) {
			let run = 0;
			while (i + run < to && text[i + run] === c) run++;
			const n = c === '~' ? (run >= 2 ? 2 : 0) : Math.min(run, 2);
			const prev = text[i - 1];
			const opens = n > 0 && !isWhite(text[i + run]) && !(c === '_' && isAlnum(prev));
			if (opens) {
				const tag = `${c}${n}`;
				if (!failed.has(tag)) {
					const start = i + n;
					const close = findCloser(s, start, to, c, n);
					if (close > start) {
						flush();
						const children = tokenize(s, start, close, depth + 1);
						out.push({kind: c === '~' ? 'strike' : n === 2 ? 'bold' : 'italic', children});
						i = close + n;
						continue;
					}
					failed.add(tag);
				}
			}
			buf += text.slice(i, i + run);
			i += run;
			continue;
		}
		if (c === '[' && depth < MAX_INLINE_DEPTH && !failed.has('[')) {
			const link = linkAt(s, i, to, failed);
			if (link !== undefined) {
				flush();
				out.push({kind: 'link', children: tokenize(s, i + 1, link.labelEnd, depth + 1), url: link.url});
				i = link.end;
				continue;
			}
		}
		buf += c;
		i++;
	}
	flush();
	return out;
}

function linkAt(s: Scan, i: number, to: number, failed: Set<string>): {labelEnd: number; url: string; end: number} | undefined {
	const {text} = s;
	let j = i + 1;
	for (; j < to; j++) {
		const span = s.spans.get(j);
		if (span !== undefined) {
			j = span.end - 1;
			continue;
		}
		const c = text[j];
		if (c === '\\') j++;
		else if (c === '[') return undefined;
		else if (c === ']') break;
	}
	if (j >= to || j === i + 1) {
		if (j >= to) failed.add('[');
		return undefined;
	}
	if (text[j + 1] !== '(') return undefined;
	let k = j + 2;
	const limit = Math.min(to, k + MAX_URL);
	while (k < limit && text[k] !== ')' && !isWhite(text[k])) k++;
	if (k >= limit || text[k] !== ')' || k === j + 2) return undefined;
	return {labelEnd: j, url: text.slice(j + 2, k), end: k + 1};
}

export function inlineTokens(text: string): InlineToken[] {
	return tokenize({text, spans: codeSpans(text)}, 0, text.length, 0);
}
