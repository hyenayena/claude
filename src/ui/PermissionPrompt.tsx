import React from 'react';
import {Box, Text} from 'ink';
import type {ToolRequest} from '../chat/permission.js';
import {
	choicesFor,
	clipBody,
	isRestricted,
	toolBodyRows,
	type PromptLayout,
	type Reveal,
	type Tone,
	type ToolPromptState,
} from './prompt-state.js';
import {truncateCells, wrapRows} from '../kit.js';
import {Frame, LabeledInput, labeledInputRows} from './kit.js';

const REASON = 'Reason: ';
const MAX_REASON_ROWS = 3;
const MAX_HEADER_ROWS = 3;

const PAGER_TONE: Record<Tone, {color?: string; dim?: boolean}> = {
	plain: {},
	dim: {dim: true},
	add: {color: 'green'},
	del: {color: 'red'},
	warn: {color: 'yellow'},
	info: {color: 'cyan'},
};

export function toolHeader(req: ToolRequest, reveal: Reveal): string {
	if (req.toolName === 'Bash') {
		return `Bash: run this command as root in ${reveal(req.cwd)} (network access, can modify the project)?`;
	}
	if (req.toolName === 'WebFetch') return `WebFetch: fetch ${reveal(String(req.input['url'] ?? ''))}?`;
	if (req.toolName === 'ExitPlanMode') return 'The plan is ready. Start working on it?';
	if (req.toolName === 'Command') return `Run console command: ${reveal(String(req.input['command'] ?? ''))}?`;
	if (req.toolName === 'Mcp') return `MCP: run ${reveal(String(req.input['__mcpTool'] ?? ''))}?`;
	return `${req.toolName}: ${reveal(req.path ?? String(req.input['file_path'] ?? ''))}`;
}

export interface PermissionPromptProps {
	request: ToolRequest;
	state: ToolPromptState;
	layout: PromptLayout;
	reveal: Reveal;
	position: number;
	total: number;
	approvals: number;
	notice?: string;
}

export function headerPrefix(position: number, total: number, approvals: number): string {
	const parts: string[] = [];
	if (total > 1) parts.push(`Permission ${position} of ${total}`);
	if (approvals >= 4) parts.push(`${approvals} approvals this turn`);
	return parts.length === 0 ? '' : `${parts.join(' · ')} · `;
}

export function PermissionPrompt(props: PermissionPromptProps) {
	const {request, state, layout, reveal} = props;
	const choices = choicesFor(request);
	const restricted = isRestricted(request);
	const all = React.useMemo(() => toolBodyRows(request, reveal, layout.width), [request, reveal, layout.width]);
	const prefix = headerPrefix(props.position, props.total, props.approvals);
	const header = `${headerPrefix(props.position, props.total, props.approvals)}${toolHeader(request, reveal)}`;
	if (layout.tier === 'minimal') {
		return (
			<Text color="yellow" bold wrap="truncate">
				Permission needed – enlarge the terminal to review (n to deny)
			</Text>
		);
	}
	const headerAll = wrapRows(header, layout.width);
	const headerRows =
		headerAll.length > MAX_HEADER_ROWS
			? [...headerAll.slice(0, MAX_HEADER_ROWS - 1), truncateCells(headerAll.slice(MAX_HEADER_ROWS - 1).join(' '), layout.width)]
			: headerAll;
	const reasonRows = state.view === 'reason' ? Math.min(MAX_REASON_ROWS, labeledInputRows(REASON, state.reason, layout.width)) : 0;
	const hintRows = layout.showHint && state.view === 'choose' ? wrapRows(props.notice ?? hintText(request), layout.width).slice(0, 2) : [];
	const extraRows = headerRows.length - 1 + Math.max(0, reasonRows - 1) + Math.max(0, hintRows.length - 1);
	const baseMax = state.view === 'reason' && layout.compactChoices ? Math.max(1, layout.bodyRows - 1) : layout.bodyRows;
	const bodyMax = Math.max(1, baseMax - extraRows);
	const body = clipBody(all, bodyMax, layout.bodyHidden);

	if (state.view === 'full') {
		const from = Math.min(state.scroll, Math.max(0, all.length - layout.pagerRows));
		const slice = all.slice(from, from + layout.pagerRows);
		const range = `${Math.min(all.length, from + 1)}-${from + slice.length} of ${all.length}`;
		return (
			<Box flexDirection="column">
				<Text color="yellow" bold wrap="truncate">
					{`Full view · rows ${range} · ↑/↓ PgUp/PgDn Home/End · Esc returns`}
				</Text>
				{slice.map((row, i) => (
					<Text key={i} wrap="truncate" color={PAGER_TONE[row.tone].color} dimColor={PAGER_TONE[row.tone].dim === true}>
						{`│ ${row.text}`}
					</Text>
				))}
			</Box>
		);
	}

	if (layout.tier === 'tiny') {
		const first = request.toolName === 'Bash' ? String(request.input['command'] ?? '').split('\n')[0] ?? '' : '';
		const title = request.toolName === 'Bash' ? `Bash: ${reveal(first)}` : toolHeader(request, reveal);
		const keys = (isRestricted(request) ? [] : ['[y]es']).concat(['[n]o']);
		const resolves =
			request.resolvedPath !== undefined && request.resolvedPath !== request.path
				? `resolves to: ${reveal(request.resolvedPath)}`
				: undefined;
		const roomForRow = layout.budget >= 4;
		let footerText = keys.concat(roomForRow ? ['[v]iew'] : []).join(' ');
		if (resolves !== undefined && !roomForRow) footerText = `${keys.join(' ')} │ ${resolves}`;
		return (
			<Box flexDirection="column">
				<Text color="yellow" bold wrap="truncate">
					{`${prefix}${title}`}
				</Text>
				{roomForRow && (
					<Text dimColor={resolves === undefined} color={resolves === undefined ? undefined : 'yellow'} wrap="truncate">
						{resolves === undefined ? '│ (press v to view)' : `│ ${resolves}`}
					</Text>
				)}
				{state.view === 'reason' ? (
					<LabeledInput label={REASON} labelColor="yellow" text={state.reason} columns={layout.width} maxRows={1} />
				) : (
					<Text wrap="truncate">{footerText}</Text>
				)}
			</Box>
		);
	}

	let footer: React.ReactNode;
	if (state.view === 'reason') {
		footer = (
			<>
				<LabeledInput label={REASON} labelColor="yellow" text={state.reason} columns={layout.width} maxRows={reasonRows} />
				<Text dimColor wrap="truncate">Enter sends the denial · Esc goes back</Text>
			</>
		);
	} else if (layout.compactChoices) {
		const current = choices[state.selected] ?? choices[0];
		footer = (
			<Text wrap="truncate">
				<Text color="cyan">{'❯ '}</Text>
				{current?.label} <Text dimColor>({current?.hotkey}) · ↑/↓ {state.selected + 1}/{choices.length} · Enter</Text>
			</Text>
		);
	} else {
		footer = (
			<>
				{choices.map((c, i) => {
					const on = i === state.selected;
					const shortcut = restricted && (c.id === 'allow' || c.id === 'always') ? ' ' : c.hotkey;
					return (
						<Text key={c.id} wrap="truncate" color={on ? 'cyan' : undefined} bold={on}>
							{`${on ? '❯' : ' '} ${shortcut}  ${c.label}`}
						</Text>
					);
				})}
				{request.always === false && (
					<Text dimColor wrap="truncate">{'    Always-allow is not available for this command'}</Text>
				)}
				{request.always !== false && restricted && (
					<Text dimColor wrap="truncate">{'    Always-allow is off for this request'}</Text>
				)}
			</>
		);
	}

	return (
		<Box flexDirection="column">
			{headerRows.map((text, i) => (
				<Text key={i} color="yellow" bold wrap="truncate">
					{text}
				</Text>
			))}
			<Frame rows={body} width={layout.width} />
			{footer}
			{hintRows.map((text, i) => (
				<Text key={`n${i}`} dimColor={props.notice === undefined} color={props.notice === undefined ? undefined : 'yellow'} wrap="truncate">
					{text}
				</Text>
			))}
		</Box>
	);
}

export function hintText(req: ToolRequest): string {
	const restricted = isRestricted(req);
	const keys = restricted ? [] : ['y allow', ...(req.always !== false ? ['a always'] : [])];
	return [...keys, 'n/Esc deny', 'r reason', 's stop', 'v view full'].join(' · ');
}
