import React, {useState} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import type {Scrub} from './present.js';
import type {PickerItem} from './picker-model.js';
import {useViewHost} from './view-host.js';

export type {PickerItem};


export interface ListPickerProps {
	title: string;
	empty: string;
	// Verb for Enter in the key hint, e.g. "resume".
	action: string;
	items: PickerItem[];
	scrub: Scrub;
	onPick: (id: string) => void;
	close: () => void;
	host?: ViewHost;
}


const fit = (s: string, width: number) => ([...s].length > width ? `${[...s].slice(0, Math.max(0, width - 1)).join('')}…` : s);

/** A list in the console panel: ↑↓ select, Enter picks (and closes), Esc closes. */
export function ListPicker({title, empty, action, items, scrub, onPick, close, host}: ListPickerProps) {
	const terminal = useWindowSize();
	const {focused, columns} = useViewHost(host, terminal.columns);
	const rows = host?.rows?.() ?? terminal.rows - 1;
	const [cursor, setCursor] = useState(0);

	useInput(
		(input, key) => {
			if (host?.isHostKey(input, key)) return;
			if (key.escape || (key.ctrl && input === 'c')) return close();
			if (key.upArrow) return setCursor(i => Math.max(0, i - 1));
			if (key.downArrow) return setCursor(i => Math.min(items.length - 1, i + 1));
			if (key.return) {
				const item = items[cursor];
				if (item) {
					close();
					onPick(item.id);
				}
			}
		},
		{isActive: focused},
	);

	const width = Math.max(1, columns - 1);
	const budget = Math.max(1, rows - 2);
	const start = Math.min(Math.max(0, cursor - Math.floor(budget / 2)), Math.max(0, items.length - budget));
	const visible = items.slice(start, start + budget);

	return (
		<Box flexDirection="column">
			<Box flexShrink={0}>
				<Text bold wrap="truncate-end">
					{fit(items.length === 0 ? empty : title, width)}
				</Text>
			</Box>
			{visible.map((item, i) => {
				const selected = start + i === cursor;
				const meta = item.meta ? ` · ${scrub(item.meta)}` : '';
				const label = fit(`${selected ? '›' : ' '} ${scrub(item.label).replace(/\s+/g, ' ')}`, Math.max(1, width - [...meta].length));
				return (
					<Box key={item.id} flexShrink={0}>
						<Text wrap="truncate-end" inverse={selected && focused}>
							{label}
							<Text dimColor>{meta}</Text>
						</Text>
					</Box>
				);
			})}
			<Box flexShrink={0}>
				<Text dimColor wrap="truncate-end">
					{fit(items.length === 0 ? 'Esc close' : `↑↓ select · Enter ${action} · Esc close`, width)}
				</Text>
			</Box>
		</Box>
	);
}
