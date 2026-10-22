import React, {useEffect, useState} from 'react';
import {Box, Text} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import type {ShellSnapshot, ShellWatch} from '../chat/shell-watch.js';
import {OutputTail, SPINNERS, useSpinnerFrame, useViewHost} from './kit.js';

export type ShellActivityProps = {
	watch: Pick<ShellWatch, 'get' | 'subscribe'>;
	host?: ViewHost;
	now?: () => number;
};

const DEFAULT_ROWS = 20;

export function ShellActivity({watch, host, now = Date.now}: ShellActivityProps) {
	const {columns} = useViewHost(host);
	const [snap, setSnap] = useState<ShellSnapshot>(() => watch.get());
	const [, setTick] = useState(0);
	const frame = useSpinnerFrame(SPINNERS.braille, 100);
	useEffect(() => {
		setSnap(watch.get());
		return watch.subscribe(() => setSnap(watch.get()));
	}, [watch]);
	useEffect(() => {
		const timer = setInterval(() => setTick(t => t + 1), 1000);
		return () => clearInterval(timer);
	}, []);

	const calls = snap.calls;
	const rows = Math.max(4, (host?.rows?.() ?? DEFAULT_ROWS) - 1);
	const each = Math.max(2, Math.floor(rows / Math.max(1, calls.length)));
	const width = Math.max(1, columns - 1);
	return (
		<Box flexDirection="column">
			{calls.map(call => {
				const secs = Math.max(0, Math.floor((now() - call.startedAt) / 1000));
				return (
					<Box key={call.toolUseId} flexDirection="column" flexShrink={0}>
						<OutputTail lines={call.lines} width={width} rows={each} title={`${frame} $ ${call.command} · ${secs}s`} />
					</Box>
				);
			})}
			{calls.length === 0 && <Text dimColor> </Text>}
		</Box>
	);
}
