import React from 'react';
import {Box, Text} from 'ink';
import {inputRowCount, inputWindow, offsetAtCell} from '../kit.js';

interface Row {
	before: string;
	cell: string | null;
	after: string;
	leftCut: boolean;
	rightCut: boolean;
}

const PREFIX_CELLS = 2;
const maxCells = (columns: number): number => Math.max(8, columns - 3);

export function inputRowsNeeded(text: string, columns: number): number {
	return inputRowCount(text, maxCells(columns));
}

export function inputRows(text: string, cursor: number, columns: number, maxRows: number): Row[] {
	return inputWindow(text, cursor, maxCells(columns), maxRows).map(({before, cell, after, leftCut, rightCut}) => ({
		before,
		cell,
		after,
		leftCut,
		rightCut,
	}));
}

export function cursorFromClick(
	text: string,
	cursor: number,
	columns: number,
	maxRows: number,
	row: number,
	cell: number,
): number | undefined {
	return offsetAtCell(text, cursor, maxCells(columns), Math.max(1, maxRows), row, Math.max(0, cell - PREFIX_CELLS));
}

export function InputLine({
	text,
	cursor,
	columns,
	maxRows,
}: {
	text: string;
	cursor: number;
	columns: number;
	maxRows: number;
}) {
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
