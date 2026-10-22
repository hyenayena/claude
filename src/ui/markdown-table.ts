import {styledCells, wrapRows} from '../kit.js';

export type Align = 'left' | 'right' | 'center';
export type Table = {header: string[]; align: Align[]; rows: string[][]; end: number};
export type TableStyle = {dim: string; bold: string; boldOff: string; reset: string};
export type TableOptions = {width: number; inline: (s: string) => string; style: TableStyle};

const MAX_COLUMNS = 64;
const MIN_COLUMN = 3;
const DELIMITER_CELL = /^\s*:?-+:?\s*$/;
const FENCE_OPEN = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^#{1,6}\s+/;
const QUOTE = /^\s*>/;

function splitRow(line: string): string[] {
	const code: Array<[number, number]> = [];
	for (const m of line.matchAll(/`[^`\n]+`/g)) code.push([m.index, m.index + m[0].length]);
	const inCode = (i: number) => code.some(([a, b]) => i > a && i < b);
	const segments: string[] = [];
	let cur = '';
	let lastPipe = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (ch === '\\' && line[i + 1] === '|') {
			cur += '|';
			i++;
			lastPipe = false;
		} else if (ch === '|' && !inCode(i)) {
			segments.push(cur);
			cur = '';
			lastPipe = true;
		} else {
			cur += ch;
			lastPipe = false;
		}
	}
	segments.push(cur);
	if (line.trimStart().startsWith('|') && segments.length > 0) segments.shift();
	if (lastPipe || (segments.length > 0 && segments[segments.length - 1]!.trim() === '' && line.trimEnd().endsWith('|'))) segments.pop();
	return segments.map(s => s.trim());
}

function hasUnescapedPipe(line: string): boolean {
	return /(^|[^\\])\|/.test(line);
}

export function matchTable(lines: string[], start: number): Table | undefined {
	const headLine = lines[start];
	const delimLine = lines[start + 1];
	if (headLine === undefined || delimLine === undefined || !hasUnescapedPipe(headLine) || !delimLine.includes('|')) return undefined;
	const header = splitRow(headLine);
	const delim = splitRow(delimLine);
	if (header.length === 0 || header.length > MAX_COLUMNS || delim.length !== header.length) return undefined;
	if (!delim.every(c => DELIMITER_CELL.test(c))) return undefined;
	const align = delim.map((c): Align => {
		const left = c.startsWith(':');
		const right = c.endsWith(':');
		return left && right ? 'center' : right ? 'right' : 'left';
	});
	const rows: string[][] = [];
	let i = start + 2;
	for (; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === '' || FENCE_OPEN.test(line) || HEADING.test(line) || QUOTE.test(line)) break;
		const cells = splitRow(line).slice(0, header.length);
		while (cells.length < header.length) cells.push('');
		rows.push(cells);
	}
	return {header, align, rows, end: i};
}

function layoutWidths(natural: number[], avail: number): number[] | undefined {
	const n = natural.length;
	const mins = natural.map(w => Math.min(w, MIN_COLUMN));
	if (natural.reduce((a, b) => a + b, 0) <= avail) return natural;
	if (mins.reduce((a, b) => a + b, 0) > avail) return undefined;
	const widths = [...mins];
	let spare = avail - widths.reduce((a, b) => a + b, 0);
	while (spare > 0) {
		let best = -1;
		let bestRatio = 0;
		for (let i = 0; i < n; i++) {
			const deficit = natural[i]! - widths[i]!;
			if (deficit <= 0) continue;
			const ratio = deficit / natural[i]!;
			if (ratio > bestRatio) {
				best = i;
				bestRatio = ratio;
			}
		}
		if (best < 0) break;
		widths[best]!++;
		spare--;
	}
	return widths;
}

function pad(text: string, width: number, align: Align): string {
	const gap = Math.max(0, width - styledCells(text));
	if (align === 'right') return ' '.repeat(gap) + text;
	if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(gap - Math.floor(gap / 2));
	return text + ' '.repeat(gap);
}

function renderRecords(budget: number, headers: string[], bodies: string[][], style: TableStyle): string[] {
	const out: string[] = [];
	if (bodies.length === 0) {
		for (const h of headers) out.push(...wrapRows(h, budget));
		return out;
	}
	bodies.forEach((row, r) => {
		if (r > 0) out.push(`${style.dim}${'─'.repeat(Math.min(budget, 40))}${style.reset}`);
		row.forEach((cell, c) => {
			out.push(...wrapRows(`${headers[c]}: ${cell}`, budget));
		});
	});
	return out;
}

export function renderTable(table: Table, options: TableOptions): string[] {
	const {style} = options;
	const budget = Number.isFinite(options.width) ? Math.max(1, Math.floor(options.width)) : 1;
	const n = table.header.length;
	const headers = table.header.map(h => `${style.bold}${options.inline(h).split(style.boldOff).join('')}${style.reset}`);
	const bodies = table.rows.map(row => row.map(c => options.inline(c)));
	const natural = headers.map((h, c) => Math.max(1, styledCells(h), ...bodies.map(row => styledCells(row[c]!))));
	const widths = layoutWidths(natural, budget - (3 * n + 1));
	if (!widths) return renderRecords(budget, headers, bodies, style);

	const sep = `${style.dim}│${style.reset}`;
	const border = (l: string, m: string, r: string) => `${style.dim}${l}${widths.map(w => '─'.repeat(w + 2)).join(m)}${r}${style.reset}`;
	const rowLines = (cells: string[]): string[] => {
		const wrapped = cells.map((c, i) => wrapRows(c, widths[i]!));
		const height = Math.max(...wrapped.map(w => w.length));
		const lines: string[] = [];
		for (let k = 0; k < height; k++) {
			const parts = wrapped.map((w, i) => ` ${pad(w[k] ?? '', widths[i]!, table.align[i]!)}${style.reset} `);
			lines.push(`${sep}${parts.join(sep)}${sep}`);
		}
		return lines;
	};
	const out = [border('╭', '┬', '╮'), ...rowLines(headers)];
	out.push(border('├', '┼', '┤'));
	for (const row of bodies) out.push(...rowLines(row));
	out.push(border('╰', '┴', '╯'));
	return out;
}
