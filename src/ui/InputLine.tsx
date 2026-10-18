import React from 'react';
import {Box, Text} from 'ink';

interface Row {
	before: string;
	cell: string | null;
	after: string;
}

export function inputRows(text: string, cursor: number, columns: number, maxRows: number): Row[] {
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
	const rows: Row[] = [];
	for (let i = first; i < Math.min(lines.length, first + maxRows); i++) {
		const line = lines[i] as string;
		const col = i === cursorLine ? remaining : -1;
		const start = col >= avail ? col - avail + 1 : 0;
		const view = line.slice(start, start + avail);
		if (col < 0) rows.push({before: view, cell: null, after: ''});
		else {
			const at = col - start;
			rows.push({before: view.slice(0, at), cell: view[at] ?? ' ', after: view.slice(at + 1)});
		}
	}
	return rows;
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
