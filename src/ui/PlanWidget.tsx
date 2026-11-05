import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {Box, Text, useWindowSize} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import {SPINNERS, useSpinnerFrame, useViewHost} from './kit.js';
import {planVisible, planWidgetRows, type PlanView} from './plan-widget.js';
import type {Scrub} from './tool-args.js';
import type {Store} from './store.js';

export type PlanWidgetProps = {store: Store<PlanView>; host?: ViewHost; scrub: Scrub; rows?: number};

export function PlanWidget({store, host, scrub, rows}: PlanWidgetProps) {
	const view = useSyncExternalStore(store.subscribe, store.get);
	const {columns} = useViewHost(host);
	const terminal = useWindowSize();
	const [, setTick] = useState(0);
	const animated = planVisible(view) && view.running && view.items.some(i => i.status === 'in_progress');
	const spinner = useSpinnerFrame(SPINNERS.braille, 120, animated);
	const until = view.flash?.until;
	useEffect(() => {
		if (until === undefined) return;
		const wait = until - Date.now();
		if (wait <= 0) return;
		const timer = setTimeout(() => setTick(n => n + 1), wait + 1);
		return () => clearTimeout(timer);
	}, [until]);
	const lines = planWidgetRows(view, {columns, rows: rows ?? terminal.rows, scrub, spinner, now: Date.now()});
	if (lines.length === 0) return null;
	return (
		<Box flexDirection="column">
			{lines.map((line, i) => (
				<Text key={i} wrap="truncate">
					{line}
				</Text>
			))}
		</Box>
	);
}
