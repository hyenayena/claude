import React, {useSyncExternalStore} from 'react';
import {Box, useWindowSize} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import {AgentPanel} from './AgentPanel.js';
import type {AgentStore} from './agent-store.js';
import {useViewHost} from './kit.js';
import {PlanWidget} from './PlanWidget.js';
import {planWidgetRows, type PlanView} from './plan-widget.js';
import type {Scrub} from './tool-args.js';
import type {Store} from './store.js';

export type ChatHeaderProps = {plan: Store<PlanView>; agents: AgentStore; host?: ViewHost; scrub: Scrub; rows?: number};

export function ChatHeader({plan, agents, host, scrub, rows}: ChatHeaderProps) {
	const view = useSyncExternalStore(plan.subscribe, plan.get);
	const {columns} = useViewHost(host);
	const terminal = useWindowSize();
	const total = rows ?? terminal.rows;
	const planHeight = planWidgetRows(view, {columns, rows: total, scrub, now: 0}).length;
	return (
		<Box flexDirection="column">
			<PlanWidget store={plan} {...(host !== undefined && {host})} scrub={scrub} rows={total} />
			<AgentPanel store={agents} {...(host !== undefined && {host})} scrub={scrub} rows={total - planHeight} />
		</Box>
	);
}
