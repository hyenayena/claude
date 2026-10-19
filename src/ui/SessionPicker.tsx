import React, {useState} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import type {SessionSummary} from '../chat/history.js';
import type {Scrub} from './present.js';
import {useViewHost} from './view-host.js';

export interface SessionPickerProps {
	sessions: SessionSummary[];
	scrub: Scrub;
	onPick: (sessionId: string) => void;
	close: () => void;
	host?: ViewHost;
	now?: number;
}

export const PICKER_HINT = '↑↓ select · Enter resume · Esc close';

export function ago(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86_400)} d ago`;
}

const fit = (s: string, width: number) => ([...s].length > width ? `${[...s].slice(0, Math.max(0, width - 1)).join('')}…` : s);

export function SessionPicker({sessions, scrub, onPick, close, host, now = Date.now()}: SessionPickerProps) {
	const terminal = useWindowSize();
	const {focused, columns} = useViewHost(host, terminal.columns);
	const rows = host?.rows?.() ?? terminal.rows - 1;
	const [cursor, setCursor] = useState(0);

	useInput(
		(input, key) => {
			if (host?.isHostKey(input, key)) return;
			if (key.escape || (key.ctrl && input === 'c')) return close();
			if (key.upArrow) return setCursor(i => Math.max(0, i - 1));
			if (key.downArrow) return setCursor(i => Math.min(sessions.length - 1, i + 1));
			if (key.return) {
				const s = sessions[cursor];
				if (s) {
					close();
					onPick(s.sessionId);
				}
			}
		},
		{isActive: focused},
	);

	const width = Math.max(1, columns - 1);
	const budget = Math.max(1, rows - 2);
	const start = Math.min(Math.max(0, cursor - Math.floor(budget / 2)), Math.max(0, sessions.length - budget));
	const visible = sessions.slice(start, start + budget);

	return (
		<Box flexDirection="column">
			<Box flexShrink={0}>
				<Text bold wrap="truncate-end">
					{fit(sessions.length === 0 ? 'No earlier chats in this project' : 'Resume a chat', width)}
				</Text>
			</Box>
			{visible.map((s, i) => {
				const selected = start + i === cursor;
				const meta = ` · ${ago(s.modified, now)} · ${s.prompts} msg`;
				const title = fit(`${selected ? '›' : ' '} ${scrub(s.title)}`, Math.max(1, width - [...meta].length));
				return (
					<Box key={s.sessionId} flexShrink={0}>
						<Text wrap="truncate-end" inverse={selected && focused}>
							{title}
							<Text dimColor>{meta}</Text>
						</Text>
					</Box>
				);
			})}
			<Box flexShrink={0}>
				<Text dimColor wrap="truncate-end">
					{fit(sessions.length === 0 ? 'Esc close' : PICKER_HINT, width)}
				</Text>
			</Box>
		</Box>
	);
}
