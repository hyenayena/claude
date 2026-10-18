import React from 'react';
import {Box, Text} from 'ink';
import type {QuestionRequest} from '../chat/permission.js';
import {wrapRows} from '../chat/wrap.js';
import {Frame, headerPrefix} from './PermissionPrompt.js';
import {questionRows, type BodyRow, type PromptLayout, type QuestionPromptState, type Reveal} from './prompt-state.js';

export interface QuestionPromptProps {
	request: QuestionRequest;
	state: QuestionPromptState;
	layout: PromptLayout;
	reveal: Reveal;
	position: number;
	total: number;
	notice?: string;
}

export function QuestionPrompt(props: QuestionPromptProps) {
	const {request, state, layout, reveal} = props;
	const spec = request.questions[state.index] ?? request.questions[0];
	if (!spec) return null;
	if (layout.tier === 'minimal' || layout.budget < 4) {
		return (
			<Text color="yellow" bold wrap="truncate">
				Question from Claude – enlarge the terminal to answer (n to dismiss)
			</Text>
		);
	}
	if (layout.tier === 'tiny') {
		return (
			<Box flexDirection="column">
				<Text color="yellow" bold wrap="truncate">
					Question from Claude (not a permission request)
				</Text>
				{layout.budget >= 4 && (
					<Text dimColor wrap="truncate">
						{`│ ${reveal(spec.question).replace(/\s+/g, ' ')}`}
					</Text>
				)}
				{state.view === 'other' ? (
					<Text wrap="truncate">
						<Text color="yellow">Your answer: </Text>
						{reveal(state.other)}
						<Text inverse> </Text>
					</Text>
				) : (
					<Text wrap="truncate">1-9 answer · o other · n dismiss</Text>
				)}
			</Box>
		);
	}
	const count = request.questions.length;
	const optionCount = questionRows(spec);
	const title = count > 1 ? `Question ${state.index + 1} of ${count}` : 'Question';
	const header = `${headerPrefix(props.position, props.total, 0)}Question from Claude (not a permission request) · ${title}`;

	// Status bar and hint rows are outside this component's output
	const avail = Math.max(2, layout.budget - 1 - 1 - 2 - 1);
	const qWrapped = wrapRows(`[${reveal(spec.header)}] ${reveal(spec.question)}`, layout.width);
	const qRows = Math.min(qWrapped.length, Math.max(1, avail - optionCount));
	const body: BodyRow[] = qWrapped.slice(0, qRows).map(text => ({text, tone: 'plain'}));
	if (qRows < qWrapped.length) body[qRows - 1] = {text: `${(body[qRows - 1] as BodyRow).text.slice(0, -1)}…`, tone: 'plain'};

	const optAvail = Math.max(1, avail - qRows);
	const first = Math.max(0, Math.min(state.cursor - optAvail + 1, optionCount - optAvail));
	const visible = Array.from({length: Math.min(optAvail, optionCount)}, (_, k) => first + k);

	const row = (i: number): string => {
		const on = i === state.cursor;
		const isOther = i === optionCount - 1;
		const mark = spec.multiSelect ? (isOther ? (state.otherPicked ? '[x]' : '[ ]') : state.picked.includes(i) ? '[x]' : '[ ]') : '';
		const label = isOther
			? state.other !== '' && (state.otherPicked || !spec.multiSelect)
				? `Other: ${reveal(state.other)}`
				: 'Other (type your own answer)'
			: reveal(spec.options[i]?.label ?? '');
		const description = !isOther && spec.options[i]?.description ? ` — ${reveal(spec.options[i]?.description ?? '')}` : '';
		return `${on ? '❯' : ' '} ${i + 1} ${mark}${mark ? ' ' : ''}${label}${description}`;
	};

	const hint = spec.multiSelect
		? 'Space toggles · Enter submits · 1-9 toggle · o other · n/Esc dismiss · s stop'
		: 'Enter answers · 1-9 choose · o other · n/Esc dismiss · s stop';

	return (
		<Box flexDirection="column">
			<Text color="yellow" bold wrap="truncate">
				{header}
			</Text>
			<Frame rows={body} width={layout.width} />
			{visible.map(i => (
				<Text key={i} wrap="truncate" color={i === state.cursor ? 'cyan' : undefined} bold={i === state.cursor}>
					{row(i)}
				</Text>
			))}
			{state.view === 'other' ? (
				<Text wrap="truncate">
					<Text color="yellow">Your answer: </Text>
					{reveal(state.other)}
					<Text inverse> </Text>
					<Text dimColor> Enter confirms · Esc goes back</Text>
				</Text>
			) : (
				(layout.showHint || props.notice !== undefined) && (
					<Text dimColor={props.notice === undefined} color={props.notice === undefined ? undefined : 'yellow'} wrap="truncate">
						{props.notice ?? hint}
					</Text>
				)
			)}
		</Box>
	);
}
