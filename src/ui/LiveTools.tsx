import React from 'react';
import {Box, Text} from 'ink';
import {inkTone, spinnerFrames} from '../kit.js';
import {useSpinnerFrame} from './kit.js';
import {formatToolGroup, runningToolRow} from './tool-card.js';
import type {Scrub} from './tool-args.js';
import {LIVE, type RunningTool, type ToolOut} from './transcript.js';

const FRAMES = spinnerFrames('braille');

export function LiveTools({
	tools,
	fold,
	scrub,
	maxRows,
	width,
	now,
}: {
	tools: RunningTool[];
	fold: readonly ToolOut[];
	scrub: Scrub;
	maxRows: number;
	width: number;
	now?: number;
}) {
	const folded = fold.length > 0 ? 1 : 0;
	const active = tools.length > 0 || folded > 0;
	const frame = useSpinnerFrame(FRAMES, 120, active);

	const {shown, more} = toolLayout(tools.length + folded, maxRows);
	if (!active || maxRows <= 0) return null;
	const clock = now ?? Date.now();
	const rows = [
		...(folded > 0 ? [{key: 'fold', text: formatToolGroup(fold, scrub, width).split('\n')[0] ?? ''}] : []),
		...tools.map(tool => ({key: tool.id, text: runningToolRow(tool, scrub, width, frame, clock)})),
	].slice(0, shown);
	return (
		<Box flexDirection="column">
			{rows.map(row => (
				<Text key={row.key}>{row.text}</Text>
			))}
			{more > 0 && <Text {...inkTone('muted')}>{moreRow(shown, more, width)}</Text>}
		</Box>
	);
}

function moreRow(shown: number, more: number, width: number): string {
	const text = shown === 0 ? `${more} tools running` : `+${more} more`;
	return text.length > width ? text.slice(0, Math.max(0, width)) : text;
}

export function toolLayout(count: number, maxRows: number): {shown: number; more: number; rows: number} {
	if (count === 0 || maxRows <= 0) return {shown: 0, more: 0, rows: 0};
	const cap = Math.min(maxRows, LIVE.maxTools + 1);
	if (count <= cap && count <= LIVE.maxTools) return {shown: count, more: 0, rows: count};
	const shown = Math.min(cap - 1, LIVE.maxTools);
	return {shown, more: count - shown, rows: shown + 1};
}
