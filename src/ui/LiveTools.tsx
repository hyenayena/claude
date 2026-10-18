import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import {toolRunningText, type Scrub} from './present.js';
import {LIVE, type RunningTool} from './transcript.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function LiveTools({tools, scrub, maxRows}: {tools: RunningTool[]; scrub: Scrub; maxRows: number}) {
	const [frame, setFrame] = useState(0);
	const active = tools.length > 0;
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), 120);
		return () => clearInterval(timer);
	}, [active]);

	const {shown, more} = toolLayout(tools.length, maxRows);
	if (!active || maxRows <= 0) return null;
	return (
		<Box flexDirection="column">
			{tools.slice(0, shown).map(tool => (
				<Text key={tool.id} wrap="truncate">
					{FRAMES[frame]} {toolRunningText(tool, scrub)}
				</Text>
			))}
			{more > 0 && (
				<Text dimColor wrap="truncate">
					{shown === 0 ? `${more} tools running` : `+${more} more`}
				</Text>
			)}
		</Box>
	);
}

// With a single row available, collapse everything into one summary line.
export function toolLayout(count: number, maxRows: number): {shown: number; more: number; rows: number} {
	if (count === 0 || maxRows <= 0) return {shown: 0, more: 0, rows: 0};
	const cap = Math.min(maxRows, LIVE.maxTools + 1);
	if (count <= cap && count <= LIVE.maxTools) return {shown: count, more: 0, rows: count};
	const shown = Math.min(cap - 1, LIVE.maxTools);
	return {shown, more: count - shown, rows: shown + 1};
}
