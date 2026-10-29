import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import {SPINNERS, Spinner, useViewHost} from './kit.js';

export const WAIT_POLL_MS = 1000;

export type WaitState = {free: boolean; title?: string};

export interface WaitingViewProps {
	check: () => Promise<WaitState>;
	onFree: () => void;
	onCancel: () => void;
	title?: string;
	pollMs?: number;
	host?: ViewHost;
}

export const waitingText = (title: string | undefined): string =>
	`Waiting for session ${title ?? 'in another yena'} to finish · claude stop ends it · Esc cancels`;

export function WaitingView(props: WaitingViewProps) {
	const {focused} = useViewHost(props.host);
	const [title, setTitle] = useState(props.title);
	const latest = useRef(props);
	latest.current = props;

	useEffect(() => {
		let stopped = false;
		let timer: NodeJS.Timeout | undefined;
		const tick = (): void => {
			latest.current.check().then(
				state => {
					if (stopped) return;
					if (state.free) {
						stopped = true;
						latest.current.onFree();
						return;
					}
					setTitle(state.title);
					timer = setTimeout(tick, latest.current.pollMs ?? WAIT_POLL_MS);
				},
				() => {
					if (!stopped) timer = setTimeout(tick, latest.current.pollMs ?? WAIT_POLL_MS);
				},
			);
		};
		timer = setTimeout(tick, latest.current.pollMs ?? WAIT_POLL_MS);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, []);

	useInput(
		(input, key) => {
			if (props.host?.isHostKey(input, key)) return;
			if (key.escape || (key.ctrl && input === 'c')) props.onCancel();
		},
		{isActive: focused},
	);

	return (
		<Box>
			<Text wrap="truncate">
				<Spinner frames={SPINNERS.braille} intervalMs={80} /> {waitingText(title)}
			</Text>
		</Box>
	);
}
