import React, {useMemo} from 'react';
import {Text} from 'ink';
import {SPINNERS, useSpinnerFrame} from './kit.js';
import {pickWorkingVerb, workingText} from './present.js';
import type {Phase, StatusLine} from './transcript.js';

// Claude Code's accent colour for the spinner.
const ACCENT = '#D77757';

// lastEventAt: when the chat last heard from Claude Code; undefined while it waits for the user.
export function WorkingLine({
	phase,
	status,
	since,
	lastEventAt,
	now = Date.now,
}: {
	phase: Phase;
	status: StatusLine;
	since: number;
	lastEventAt?: number;
	now?: () => number;
}) {
	// Each frame re-renders the line, which also moves the seconds on.
	const frame = useSpinnerFrame(SPINNERS.sparkle, 120, true);
	// One verb per turn: `since` changes only when a new turn starts.
	const verb = useMemo(() => pickWorkingVerb(), [since]);
	const t = now();
	const quiet = lastEventAt === undefined ? 0 : (t - lastEventAt) / 1000;
	return (
		<Text wrap="truncate">
			<Text color={ACCENT}>{frame}</Text> <Text color={ACCENT}>{workingText(phase, status, (t - since) / 1000, quiet, verb)}</Text>
		</Text>
	);
}
