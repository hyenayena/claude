import React, {useSyncExternalStore} from 'react';
import {useWindowSize} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import {layoutPanel} from './agent-panel.js';
import type {AgentStore} from './agent-store.js';
import {anyRunning} from './agents.js';
import {SPINNERS, SpanRows, useSpinnerFrame, useViewHost} from './kit.js';
import type {Scrub} from './present.js';

export type AgentPanelProps = {store: AgentStore; host?: ViewHost; scrub: Scrub; rows?: number};

export function AgentPanel({store, host, scrub, rows}: AgentPanelProps) {
	const state = useSyncExternalStore(store.subscribe, store.get);
	const {columns} = useViewHost(host);
	const terminal = useWindowSize();
	const active = anyRunning(state);
	const spinner = useSpinnerFrame(SPINNERS.sparkle, 120, active);
	const corner = useSpinnerFrame(SPINNERS.squareCorners, 120, active);
	const layout = layoutPanel(state, {columns, rows: rows ?? terminal.rows, scrub, spinner, corner});
	if (layout.height === 0) return null;
	return <SpanRows rows={layout.rows} />;
}
