import React, {useMemo, useRef} from 'react';
import {Text} from 'ink';
import {SPINNERS, useSpinnerFrame} from './kit.js';
import {pickWorkingVerb, workingText} from './present.js';
import type {Phase, StatusLine} from './transcript.js';

const ACCENT = '#D77757';

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
	const frame = useSpinnerFrame(SPINNERS.sparkle, 120, true);
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
