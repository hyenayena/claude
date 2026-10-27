import React from 'react';
import {Box, Text} from 'ink';
import type {QuestionRequest} from '../chat/permission.js';
import {hangingRows, truncateCells, wrapRows} from '../kit.js';
import {Frame, LabeledInput, labeledInputRows} from './kit.js';
import {headerPrefix} from './PermissionPrompt.js';
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

const ANSWER = 'Your answer: ';
const MAX_ANSWER_ROWS = 4;

/**
 * The options [first, last] to show in `room` rows when option i takes `heights[i]` rows: the
 * cursor's option always, then as many before it as fit (the cursor moves down to the bottom row,
 * as in a plain list), then those after it.
 */
export function optionWindow(heights: number[], cursor: number, room: number): [number, number] {
	if (heights.length === 0) return [0, -1];
	const at = Math.min(Math.max(0, cursor), heights.length - 1);
	let first = at;
	let last = at;
	let used = heights[at] as number;
	while (first > 0 && used + (heights[first - 1] as number) <= room) used += heights[--first] as number;
	while (last < heights.length - 1 && used + (heights[last + 1] as number) <= room) used += heights[++last] as number;
	return [first, last];
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
					<LabeledInput label={ANSWER} labelColor="yellow" text={reveal(state.other)} columns={layout.width} maxRows={1} />
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
	const width = layout.width;
	const headerAll = wrapRows(header, width);
	const headerRows = headerAll.length > 2 ? [headerAll[0] as string, truncateCells(headerAll.slice(1).join(' '), width)] : headerAll;
	const other = reveal(state.other);
	const answerRows = state.view === 'other' ? Math.min(MAX_ANSWER_ROWS, labeledInputRows(ANSWER, other, width)) : 0;
	const hint = spec.multiSelect
		? 'Space toggles · Enter submits · 1-9 toggle · o other · n/Esc dismiss · s stop'
		: 'Enter answers · 1-9 choose · o other · n/Esc dismiss · s stop';
	const hintRows = layout.showHint || props.notice !== undefined ? wrapRows(props.notice ?? hint, width).slice(0, 2) : [];
	const footerRows = state.view === 'other' ? answerRows + 1 : Math.max(1, hintRows.length);

	const optionRows = Array.from({length: optionCount}, (_, i) => {
		const on = i === state.cursor;
		const isOther = i === optionCount - 1;
		const mark = spec.multiSelect ? (isOther ? (state.otherPicked ? '[x]' : '[ ]') : state.picked.includes(i) ? '[x]' : '[ ]') : '';
		const label = isOther
			? state.other !== '' && (state.otherPicked || !spec.multiSelect)
				? `Other: ${other}`
				: 'Other (type your own answer)'
			: reveal(spec.options[i]?.label ?? '');
		const description = !isOther && spec.options[i]?.description ? ` — ${reveal(spec.options[i]?.description ?? '')}` : '';
		return hangingRows(`${on ? '❯' : ' '} ${i + 1} ${mark}${mark ? ' ' : ''}`, `${label}${description}`, width);
	});
	const optionTotal = optionRows.reduce((n, rows) => n + rows.length, 0);

	// Status bar and hint rows are outside this component's output
	const avail = Math.max(2, layout.budget - headerRows.length - 1 - 2 - footerRows);
	const qWrapped = wrapRows(`[${reveal(spec.header)}] ${reveal(spec.question)}`, width, {mode: 'char'});
	const qRows = Math.min(qWrapped.length, Math.max(1, avail - optionTotal, Math.floor(avail / 3)));
	const body: BodyRow[] = qWrapped.slice(0, qRows).map(text => ({text, tone: 'plain'}));
	if (qRows < qWrapped.length) body[qRows - 1] = {text: `${(body[qRows - 1] as BodyRow).text.slice(0, -1)}…`, tone: 'plain'};

	const optAvail = Math.max(1, avail - qRows);
	const [first, last] = optionWindow(optionRows.map(rows => rows.length), state.cursor, optAvail);
	const shownOptions = optionRows
		.slice(first, last + 1)
		.flatMap((rows, k) => rows.map(text => ({text, on: first + k === state.cursor})))
		.slice(0, optAvail);

	return (
		<Box flexDirection="column">
			{headerRows.map((text, i) => (
				<Text key={`h${i}`} color="yellow" bold wrap="truncate">
					{text}
				</Text>
			))}
			<Frame rows={body} width={layout.width} />
			{shownOptions.map((row, i) => (
				<Text key={`o${i}`} wrap="truncate" color={row.on ? 'cyan' : undefined} bold={row.on}>
					{row.text}
				</Text>
			))}
			{state.view === 'other' ? (
				<>
					<LabeledInput label={ANSWER} labelColor="yellow" text={other} columns={width} maxRows={answerRows} />
					<Text dimColor wrap="truncate">
						Enter confirms · Esc goes back
					</Text>
				</>
			) : (
				hintRows.map((text, i) => (
					<Text key={`n${i}`} dimColor={props.notice === undefined} color={props.notice === undefined ? undefined : 'yellow'} wrap="truncate">
						{text}
					</Text>
				))
			)}
		</Box>
	);
}
