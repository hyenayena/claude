import React from 'react';
import {Box, Text} from 'ink';
import {cellWidth} from '../chat/wrap.js';

interface Row {
	before: string;
	cell: string | null;
	after: string;
}

interface WindowRow {
	// Offset of the line in the text, first shown unit of the line, shown slice, and the cursor
	// column in the line (-1 on other rows).
	offset: number;
	start: number;
	view: string;
	col: number;
}

// Shared by rendering and click mapping so the two cannot drift.
function inputWindow(text: string, cursor: number, columns: number, maxRows: number): WindowRow[] {
	const lines = text.split('\n');
	let remaining = cursor;
	let cursorLine = 0;
	for (let i = 0; i < lines.length; i++) {
		const len = (lines[i] as string).length;
		if (remaining <= len) {
			cursorLine = i;
			break;
		}
		remaining -= len + 1;
		cursorLine = i;
	}
	const first = Math.max(0, Math.min(cursorLine - maxRows + 1, lines.length - maxRows));
	const avail = Math.max(8, columns - 3);
	let offset = 0;
	for (let i = 0; i < first; i++) offset += (lines[i] as string).length + 1;
	const rows: WindowRow[] = [];
	for (let i = first; i < Math.min(lines.length, first + maxRows); i++) {
		const line = lines[i] as string;
		const col = i === cursorLine ? remaining : -1;
		const start = col >= avail ? col - avail + 1 : 0;
		rows.push({offset, start, view: line.slice(start, start + avail), col});
		offset += line.length + 1;
	}
	return rows;
}

export function inputRows(text: string, cursor: number, columns: number, maxRows: number): Row[] {
	return inputWindow(text, cursor, columns, maxRows).map(({start, view, col}) => {
		if (col < 0) return {before: view, cell: null, after: ''};
		const at = col - start;
		return {before: view.slice(0, at), cell: view[at] ?? ' ', after: view.slice(at + 1)};
	});
}

const PREFIX_CELLS = 2;
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

// Terminals draw a cluster (ZWJ emoji, base plus combining marks) as wide as its widest code point.
function graphemeWidth(g: string): number {
	let w = 0;
	for (const ch of g) w = Math.max(w, cellWidth(ch.codePointAt(0) as number));
	return w;
}

/**
 * The text offset for a click on `row` (0-based among the shown input rows) at terminal cell
 * `cell` (0-based, the two prefix cells included); undefined when that row is not shown.
 */
export function cursorFromClick(
	text: string,
	cursor: number,
	columns: number,
	maxRows: number,
	row: number,
	cell: number,
): number | undefined {
	const rows = inputWindow(text, cursor, columns, Math.max(1, maxRows));
	if (!Number.isInteger(row) || row < 0 || row >= rows.length) return undefined;
	const {offset, start, view} = rows[row] as WindowRow;
	const newline = text.indexOf('\n', offset);
	const end = newline === -1 ? text.length : newline;
	const target = Math.max(0, cell - PREFIX_CELLS);
	let used = 0;
	let hit: number | undefined;
	for (const {segment, index} of segmenter.segment(view)) {
		const w = graphemeWidth(segment);
		if (target < used + w) {
			hit = offset + start + index;
			break;
		}
		used += w;
	}
	if (hit === undefined) return end;
	// A scrolled slice may begin inside a cluster, so snap against the whole line.
	let snapped = offset;
	for (const {index} of segmenter.segment(text.slice(offset, end))) {
		if (offset + index > hit) break;
		snapped = offset + index;
	}
	return snapped;
}

export function InputLine({
	text,
	cursor,
	columns,
	running,
	maxRows,
}: {
	text: string;
	cursor: number;
	columns: number;
	running: boolean;
	maxRows: number;
}) {
	if (running && text === '') {
		return (
			<Text wrap="truncate">
				{'> '}
				<Text dimColor>Waiting for the answer… (Esc to interrupt)</Text>
			</Text>
		);
	}
	const rows = inputRows(text, cursor, columns, Math.max(1, maxRows));
	return (
		<Box flexDirection="column">
			{rows.map((row, i) => (
				<Text key={i} wrap="truncate">
					{i === 0 ? '> ' : '  '}
					{row.before}
					{row.cell !== null && <Text inverse>{row.cell}</Text>}
					{row.after}
				</Text>
			))}
		</Box>
	);
}
