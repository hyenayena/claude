import React, {useMemo, useRef} from 'react';
import {Text} from 'ink';
import {SPINNERS, useSpinnerFrame} from './kit.js';
import {pickWorkingVerb, workingText} from './present.js';
import type {Phase, StatusLine} from './transcript.js';

// Claude Code's accent colour for the spinner.
const ACCENT = '#D77757';

// lastEventAt: when the chat last heard from Claude Code; undefined while it waits for the user.
// beat: counts the answers and tool calls printed; each one brings a new verb.
export function WorkingLine({
	phase,
	status,
	since,
	beat = 0,
	lastEventAt,
	now = Date.now,
}: {
	phase: Phase;
	status: StatusLine;
	since: number;
	beat?: number;
	lastEventAt?: number;
	now?: () => number;
}) {
	// Each frame re-renders the line, which also moves the seconds on.
	const frame = useSpinnerFrame(SPINNERS.sparkle, 120, true);
	// A new verb for every turn and every answer or tool call Claude prints.
	const verbRef = useRef<string | undefined>(undefined);
	const verb = useMemo(() => (verbRef.current = pickWorkingVerb(Math.random, verbRef.current)), [since, beat]);
	const t = now();
	const quiet = lastEventAt === undefined ? 0 : (t - lastEventAt) / 1000;
	return (
		<Text wrap="truncate">
			<Text color={ACCENT}>{frame}</Text> <Text color={ACCENT}>{workingText(phase, status, (t - since) / 1000, quiet, verb)}</Text>
		</Text>
	);
}
