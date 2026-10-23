import React from 'react';
import {Text} from 'ink';
import {SPINNERS, useSpinnerFrame} from './kit.js';
import {workingText} from './present.js';
import type {Phase, StatusLine} from './transcript.js';

// Claude Code's accent colour for the spinner.
const ACCENT = '#D77757';

export function WorkingLine({phase, status, since, now = Date.now}: {phase: Phase; status: StatusLine; since: number; now?: () => number}) {
	// Each frame re-renders the line, which also moves the seconds on.
	const frame = useSpinnerFrame(SPINNERS.sparkle, 120, true);
	return (
		<Text wrap="truncate">
			<Text color={ACCENT}>{frame}</Text> <Text color={ACCENT}>{workingText(phase, status, (now() - since) / 1000)}</Text>
		</Text>
	);
}
