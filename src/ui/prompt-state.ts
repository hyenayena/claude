import type {Key} from 'ink';
import {BASH_REVIEW_MAX, PAYLOAD_REVIEW_MAX, QUESTION_LIMITS, REASON_MAX} from '../chat/permission.js';
import type {PermissionDecision, Preview, QuestionRequest, QuestionSpec, ToolRequest} from '../chat/permission.js';
import {sanitizeMultilineInput, wrapRows, type FrameRow, type Tone} from '../kit.js';

export type Reveal = (s: string) => string;

export const ARM_MS = 400;

export type PromptKeyName =
	| 'up'
	| 'down'
	| 'pageUp'
	| 'pageDown'
	| 'home'
	| 'end'
	| 'tab'
	| 'shiftTab'
	| 'enter'
	| 'esc'
	| 'backspace'
	| 'ctrlC'
	| 'space'
	| 'char'
	| 'other';

export interface PromptKey {
	name: PromptKeyName;
	char?: string;
}

/** Normalises Ink's (input, key); anything that is not a single recognised key becomes `other`. */
export function normalizeKey(input: string, key: Key): PromptKey {
	if (key.ctrl) return input === 'c' ? {name: 'ctrlC'} : {name: 'other'};
	if (key.escape) return {name: 'esc'};
	if (key.return) return key.meta || key.shift ? {name: 'other'} : {name: 'enter'};
	if (key.upArrow) return {name: 'up'};
	if (key.downArrow) return {name: 'down'};
	if (key.pageUp) return {name: 'pageUp'};
	if (key.pageDown) return {name: 'pageDown'};
	if (key.home) return {name: 'home'};
	if (key.end) return {name: 'end'};
	if (key.tab) return key.shift ? {name: 'shiftTab'} : {name: 'tab'};
	if (key.backspace || key.delete) return {name: 'backspace'};
	if (key.meta) return {name: 'other'};
	if (input === ' ') return {name: 'space'};
	if (input !== '' && [...input].length === 1) return {name: 'char', char: input};
	return {name: 'other'};
}

export type ChoiceId = 'allow' | 'always' | 'deny' | 'reason' | 'stop';

export interface Choice {
	id: ChoiceId;
	label: string;
	hotkey: string;
}

/** Requests that must never be approved with a single keystroke. */
export const isRestricted = (req: ToolRequest): boolean => req.defaultToNo || req.oversize;

export function choicesFor(req: ToolRequest): Choice[] {
	const out: Choice[] = [{id: 'allow', label: 'Allow once', hotkey: 'y'}];
	if (req.always !== false && !isRestricted(req)) {
		out.push({id: 'always', label: 'Always allow in this chat', hotkey: 'a'});
	}
	out.push(
		{id: 'deny', label: 'Deny', hotkey: 'n'},
		{id: 'reason', label: 'Deny with a reason', hotkey: 'r'},
		{id: 'stop', label: 'Deny all and stop the turn', hotkey: 's'},
	);
	return out;
}

export type ToolView = 'choose' | 'reason' | 'full';

export interface ToolPromptState {
	view: ToolView;
	selected: number;
	armedAt: number;
	reason: string;
	scroll: number;
}

export interface KeyResult<S> {
	state: S;
	decision?: PermissionDecision;
	stopTurn?: boolean;
	notice?: string;
}

export interface Pager {
	/** Highest valid scroll offset. */
	max: number;
	page: number;
}

const NO_PAGER: Pager = {max: 0, page: 10};

export function initToolPrompt(req: ToolRequest, now: number, armMs = ARM_MS): ToolPromptState {
	const choices = choicesFor(req);
	const selected = isRestricted(req) ? choices.findIndex(c => c.id === 'deny') : 0;
	return {view: 'choose', selected, armedAt: now + armMs, reason: '', scroll: 0};
}

export const isArmed = (state: {armedAt: number}, now: number): boolean => now >= state.armedAt;

export function rearm<S extends {armedAt: number}>(state: S, now: number, armMs = ARM_MS): S {
	return {...state, armedAt: now + armMs};
}

const wrapIndex = (i: number, n: number): number => ((i % n) + n) % n;

export function appendText(current: string, raw: string, max: number): string {
	return (current + sanitizeMultilineInput(raw).replace(/\n/g, ' ')).slice(0, max);
}

const decide = (
	state: ToolPromptState,
	decision: PermissionDecision,
	extra: {stopTurn?: boolean} = {},
): KeyResult<ToolPromptState> => ({state, decision, ...extra});

const DISABLED_SHORTCUT = 'That shortcut is disabled for this request. Select "Allow once" and press Enter.';

export function toolPromptKey(
	state: ToolPromptState,
	req: ToolRequest,
	key: PromptKey,
	now: number,
	pager: Pager = NO_PAGER,
	armMs = ARM_MS,
	blind = false,
): KeyResult<ToolPromptState> {
	// Stopping is the safe direction, so Ctrl+C is never held back by the typeahead guard
	if (key.name === 'ctrlC') return decide(state, {kind: 'deny', stop: true}, {stopTurn: true});
	if (!isArmed(state, now)) return {state};
	const choices = choicesFor(req);
	const move = (to: number): KeyResult<ToolPromptState> => ({state: {...state, selected: wrapIndex(to, choices.length)}});

	if (state.view === 'reason') {
		switch (key.name) {
			case 'esc':
				return {state: rearm({...state, view: 'choose', reason: ''}, now, armMs)};
			case 'enter': {
				const reason = state.reason.trim();
				return decide(state, {kind: 'deny', ...(reason !== '' && {reason})});
			}
			case 'backspace':
				return {state: {...state, reason: state.reason.slice(0, -1)}};
			case 'space':
				return {state: {...state, reason: appendText(state.reason, ' ', REASON_MAX)}};
			case 'char':
				return {state: {...state, reason: appendText(state.reason, key.char ?? '', REASON_MAX)}};
			default:
				return {state};
		}
	}

	if (state.view === 'full') {
		const clamp = (n: number): number => Math.max(0, Math.min(pager.max, n));
		switch (key.name) {
			case 'esc':
				return {state: rearm({...state, view: 'choose', scroll: 0}, now, armMs)};
			case 'char':
				if (key.char === 'q' || key.char === 'v') return {state: rearm({...state, view: 'choose', scroll: 0}, now, armMs)};
				return {state};
			case 'up':
				return {state: {...state, scroll: clamp(state.scroll - 1)}};
			case 'down':
				return {state: {...state, scroll: clamp(state.scroll + 1)}};
			case 'pageUp':
				return {state: {...state, scroll: clamp(state.scroll - pager.page)}};
			case 'pageDown':
				return {state: {...state, scroll: clamp(state.scroll + pager.page)}};
			case 'home':
				return {state: {...state, scroll: 0}};
			case 'end':
				return {state: {...state, scroll: clamp(pager.max)}};
			default:
				return {state};
		}
	}

	// Nothing reviewable is on screen, so only refusing is possible
	if (blind) {
		const at = choices[state.selected]?.id;
		if (key.name === 'esc' || (key.name === 'char' && key.char === 'n')) return decide(state, {kind: 'deny'});
		if (key.name === 'char' && key.char === 's') return decide(state, {kind: 'deny', stop: true}, {stopTurn: true});
		if (key.name === 'enter' && at === 'stop') return decide(state, {kind: 'deny', stop: true}, {stopTurn: true});
		if (key.name === 'enter') return decide(state, {kind: 'deny'});
		return {state};
	}

	const restricted = isRestricted(req);
	const openReason = (): KeyResult<ToolPromptState> => ({state: rearm({...state, view: 'reason', reason: ''}, now, armMs)});
	switch (key.name) {
		case 'up':
		case 'shiftTab':
			return move(state.selected - 1);
		case 'down':
		case 'tab':
			return move(state.selected + 1);
		case 'esc':
			return decide(state, {kind: 'deny'});
		case 'enter': {
			switch (choices[state.selected]?.id) {
				case 'allow':
					return decide(state, {kind: 'allow'});
				case 'always':
					return decide(state, {kind: 'allow', always: true});
				case 'reason':
					return openReason();
				case 'stop':
					return decide(state, {kind: 'deny', stop: true}, {stopTurn: true});
				default:
					return decide(state, {kind: 'deny'});
			}
		}
		case 'char':
			switch (key.char) {
				case 'y':
					return restricted ? {state, notice: DISABLED_SHORTCUT} : decide(state, {kind: 'allow'});
				case 'a':
					if (req.always === false) return {state};
					return restricted ? {state, notice: DISABLED_SHORTCUT} : decide(state, {kind: 'allow', always: true});
				case 'n':
					return decide(state, {kind: 'deny'});
				case 'r':
					return openReason();
				case 's':
					return decide(state, {kind: 'deny', stop: true}, {stopTurn: true});
				case 'v':
					return {state: rearm({...state, view: 'full', scroll: 0}, now, armMs)};
				default:
					return {state};
			}
		default:
			return {state};
	}
}

export type QuestionView = 'choose' | 'other';

export interface QuestionPromptState {
	view: QuestionView;
	index: number;
	cursor: number;
	picked: number[];
	other: string;
	otherPicked: boolean;
	answers: Record<string, string>;
	armedAt: number;
}

export function initQuestionPrompt(_req: QuestionRequest, now: number, armMs = ARM_MS): QuestionPromptState {
	return {view: 'choose', index: 0, cursor: 0, picked: [], other: '', otherPicked: false, answers: {}, armedAt: now + armMs};
}

/** Options plus the synthetic trailing "Other" row. */
export const questionRows = (spec: QuestionSpec): number => spec.options.length + 1;

const NEED_ONE = 'Select at least one option with Space, then press Enter.';
const NEED_TEXT = 'Type an answer first, or press Esc to go back.';

function finishQuestion(
	state: QuestionPromptState,
	req: QuestionRequest,
	text: string,
	now: number,
	armMs: number,
): KeyResult<QuestionPromptState> {
	const spec = req.questions[state.index] as QuestionSpec;
	const answers = {...state.answers, [spec.question]: text};
	if (state.index + 1 >= req.questions.length) {
		return {state: {...state, answers}, decision: {kind: 'answers', answers}};
	}
	return {
		state: rearm(
			{...state, view: 'choose', index: state.index + 1, cursor: 0, picked: [], other: '', otherPicked: false, answers},
			now,
			armMs,
		),
	};
}

function multiAnswer(state: QuestionPromptState, spec: QuestionSpec): string {
	const labels = [...state.picked].sort((a, b) => a - b).map(i => spec.options[i]?.label ?? '');
	if (state.otherPicked && state.other !== '') labels.push(state.other);
	return labels.join(', ');
}

export function questionPromptKey(
	state: QuestionPromptState,
	req: QuestionRequest,
	key: PromptKey,
	now: number,
	armMs = ARM_MS,
	blind = false,
): KeyResult<QuestionPromptState> {
	if (key.name === 'ctrlC') return {state, decision: {kind: 'deny', stop: true}, stopTurn: true};
	if (!isArmed(state, now)) return {state};
	if (blind && state.view === 'choose') {
		if (key.name === 'esc' || (key.name === 'char' && key.char === 'n')) return {state, decision: {kind: 'deny'}};
		if (key.name === 'char' && key.char === 's') return {state, decision: {kind: 'deny', stop: true}, stopTurn: true};
		return {state};
	}
	const spec = req.questions[state.index] as QuestionSpec;
	const rows = questionRows(spec);
	const otherRow = rows - 1;
	const openOther = (): KeyResult<QuestionPromptState> => ({
		state: rearm({...state, view: 'other', cursor: otherRow}, now, armMs),
	});

	if (state.view === 'other') {
		const max = QUESTION_LIMITS.freeText;
		switch (key.name) {
			case 'esc':
				return {state: rearm({...state, view: 'choose'}, now, armMs)};
			case 'backspace':
				return {state: {...state, other: state.other.slice(0, -1)}};
			case 'space':
				return {state: {...state, other: appendText(state.other, ' ', max)}};
			case 'char':
				return {state: {...state, other: appendText(state.other, key.char ?? '', max)}};
			case 'enter': {
				const text = state.other.trim();
				if (text === '') return {state, notice: NEED_TEXT};
				if (!spec.multiSelect) return finishQuestion({...state, other: text}, req, text, now, armMs);
				return {state: rearm({...state, view: 'choose', other: text, otherPicked: true}, now, armMs)};
			}
			default:
				return {state};
		}
	}

	const toggle = (i: number): KeyResult<QuestionPromptState> => {
		const picked = state.picked.includes(i) ? state.picked.filter(p => p !== i) : [...state.picked, i];
		return {state: {...state, cursor: i, picked}};
	};
	const submitMulti = (): KeyResult<QuestionPromptState> => {
		const answer = multiAnswer(state, spec);
		if (answer === '') return {state, notice: NEED_ONE};
		return finishQuestion(state, req, answer, now, armMs);
	};

	switch (key.name) {
		case 'up':
		case 'shiftTab':
			return {state: {...state, cursor: wrapIndex(state.cursor - 1, rows)}};
		case 'down':
		case 'tab':
			return {state: {...state, cursor: wrapIndex(state.cursor + 1, rows)}};
		case 'esc':
			return {state, decision: {kind: 'deny'}};
		case 'space':
			if (!spec.multiSelect) return {state};
			if (state.cursor === otherRow) {
				if (state.otherPicked) return {state: {...state, otherPicked: false}};
				return openOther();
			}
			return toggle(state.cursor);
		case 'enter':
			if (state.cursor === otherRow) {
				if (spec.multiSelect && state.otherPicked) return submitMulti();
				return openOther();
			}
			if (spec.multiSelect) return submitMulti();
			return finishQuestion(state, req, spec.options[state.cursor]?.label ?? '', now, armMs);
		case 'char': {
			const ch = key.char ?? '';
			if (ch === 'n') return {state, decision: {kind: 'deny'}};
			if (ch === 's') return {state, decision: {kind: 'deny', stop: true}, stopTurn: true};
			if (ch === 'o') return openOther();
			if (/^[1-9]$/.test(ch)) {
				const i = Number(ch) - 1;
				if (i >= rows) return {state};
				if (i === otherRow) return openOther();
				if (spec.multiSelect) return toggle(i);
				return finishQuestion({...state, cursor: i}, req, spec.options[i]?.label ?? '', now, armMs);
			}
			return {state};
		}
		default:
			return {state};
	}
}

export interface PromptLayout {
	/** Rows the whole prompt may use, status bar included. */
	budget: number;
	compactChoices: boolean;
	showHint: boolean;
	bodyRows: number;
	bodyHidden: boolean;
	pagerRows: number;
	width: number;
	/** `tiny` below 10 rows (the command line or path stays in the header), `minimal` below 4: the frame must stay under the terminal height. */
	tier: 'full' | 'tiny' | 'minimal';
}

/** Same ceiling as the chat view, minus one more row on very small terminals. */
export function layoutPrompt(rows: number, columns: number, choiceRows = 5): PromptLayout {
	const tier = rows < 4 ? 'minimal' : rows < 10 ? 'tiny' : 'full';
	const budget = tier === 'full' ? Math.max(3, rows >= 12 ? rows - 3 : rows - 2) : Math.max(2, rows - 1);
	const compact = budget < 14;
	const fixed = 1 + 1 + (compact ? 1 : choiceRows) + (compact ? 0 : 1) + 2;
	const body = Math.max(1, budget - fixed);
	return {
		budget,
		compactChoices: compact,
		showHint: !compact,
		bodyRows: body,
		bodyHidden: budget < 8,
		pagerRows: Math.max(1, budget - 2),
		width: Math.max(10, columns - 4),
		tier,
	};
}

export type {Tone};

export type BodyRow = FrameRow;

const ALWAYS_SHOWN = 100;
const NOTE_MAX = 500;
const DESCRIPTION_MAX = 300;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function pushWrapped(rows: BodyRow[], text: string, tone: Tone, width: number, indent = ''): void {
	const parts = wrapRows(text, Math.max(1, width - indent.length), {mode: 'char'});
	parts.forEach((part, i) => rows.push({text: `${i === 0 ? '' : indent}${part}`, tone}));
}

function previewRows(preview: Preview, reveal: Reveal, width: number): BodyRow[] {
	const rows: BodyRow[] = [];
	let budget = PAYLOAD_REVIEW_MAX;
	const digits = Math.max(1, ...preview.rows.map(r => String(r.no ?? '').length));
	for (const row of preview.rows) {
		if (budget <= 0) {
			rows.push({text: '… [preview truncated]', tone: 'dim'});
			break;
		}
		budget -= row.text.length + 1;
		const text = reveal(row.text);
		if (row.kind === 'gap') {
			rows.push({text: text === '' ? '⋯' : text, tone: 'dim'});
			continue;
		}
		if (row.kind === 'meta') {
			pushWrapped(rows, text, 'dim', width);
			continue;
		}
		const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
		const gutter = `${row.no === undefined ? ' '.repeat(digits) : String(row.no).padStart(digits)} ${sign} `;
		const tone: Tone = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : 'plain';
		const parts = wrapRows(text, Math.max(1, width - gutter.length), {mode: 'char'});
		parts.forEach((part, i) => rows.push({text: `${i === 0 ? gutter : ' '.repeat(gutter.length)}${part}`, tone}));
	}
	return rows;
}

/** Everything the user should review, already revealed and wrapped to `width` cells. */
export function toolBodyRows(req: ToolRequest, reveal: Reveal, width: number): BodyRow[] {
	const rows: BodyRow[] = [];
	if (req.oversize) {
		pushWrapped(rows, 'Too large to review in full: only the start is shown. Deny is preselected.', 'warn', width);
	}
	for (const h of req.highlights) {
		pushWrapped(rows, `Notable: ${reveal(h.text)}`, h.level === 'warn' ? 'warn' : 'info', width, '  ');
	}

	if (req.resolvedPath !== undefined && req.resolvedPath !== req.path) {
		pushWrapped(rows, `resolves to: ${reveal(req.resolvedPath)}`, 'warn', width, '  ');
	}

	if (req.toolName === 'Bash') {
		const raw = typeof req.input['command'] === 'string' ? req.input['command'] : '';
		const command = raw.length > BASH_REVIEW_MAX ? raw.slice(0, BASH_REVIEW_MAX) : raw;
		pushWrapped(rows, reveal(command), 'plain', width);
		if (command.length < raw.length) rows.push({text: `… [${raw.length - command.length} more characters not shown]`, tone: 'dim'});
	} else if (req.toolName === 'Command') {
		pushWrapped(rows, reveal(String(req.input['command'] ?? '')), 'plain', width);
		rows.push({text: 'The command runs in the yena console and may change state.', tone: 'warn'});
	} else if (req.toolName === 'Mcp') {
		const {__mcpTool: _tool, ...args} = req.input;
		const json = JSON.stringify(args, null, 2) ?? '';
		for (const line of reveal(json.length > 8000 ? `${json.slice(0, 8000)}…` : json).split('\n')) pushWrapped(rows, line, 'plain', width);
		rows.push({text: 'Arguments go to the MCP server, which may reach outside the container.', tone: 'warn'});
	} else if (req.toolName === 'ExitPlanMode') {
		const plan = typeof req.input['plan'] === 'string' ? req.input['plan'] : '';
		if (plan) for (const line of reveal(plan).split('\n')) pushWrapped(rows, line, 'plain', width);
		else rows.push({text: 'The plan is in the answer above.', tone: 'dim'});
		rows.push({text: 'No: yena keeps planning (say why in the reason).', tone: 'dim'});
	} else if (req.toolName === 'WebFetch') {
		pushWrapped(rows, `URL: ${reveal(String(req.input['url'] ?? ''))}`, 'plain', width);
		const ask = typeof req.input['prompt'] === 'string' ? req.input['prompt'] : '';
		if (ask) pushWrapped(rows, `Looking for: ${reveal(ask)}`, 'dim', width);
		rows.push({text: 'The URL and anything in it leave the container.', tone: 'warn'});
	} else if (req.preview) {
		rows.push({
			text: req.preview.approximate ? 'Preview of the proposed change (approximate):' : 'Preview of the proposed change:',
			tone: 'dim',
		});
		rows.push(...previewRows(req.preview, reveal, width));
		if (req.preview.truncated) rows.push({text: '… [preview truncated]', tone: 'dim'});
	} else {
		rows.push({text: 'No preview is available for this change.', tone: 'warn'});
	}

	pushWrapped(rows, `cwd: ${reveal(req.cwd)}`, 'dim', width, '  ');
	const timeout = req.input['timeout'];
	if (req.toolName === 'Bash' && typeof timeout === 'number') {
		rows.push({text: `timeout: ${Math.round(timeout / 1000)}s`, tone: 'dim'});
	}
	if (req.description !== undefined && req.description !== '') {
		pushWrapped(rows, `yena's description (not verified): ${reveal(clip(req.description, DESCRIPTION_MAX))}`, 'dim', width, '  ');
	}
	if (req.cliNote !== undefined && req.cliNote.text !== '') {
		pushWrapped(rows, `Note: ${reveal(clip(req.cliNote.text, NOTE_MAX))}`, 'dim', width, '  ');
	}
	if (req.always !== false) {
		const cmd = typeof req.input['command'] === 'string' ? req.input['command'] : '';
		const label = req.toolName === 'Bash' ? `${req.always.label}: ${clip(cmd.replace(/\s+/g, ' '), ALWAYS_SHOWN)}` : req.always.label;
		pushWrapped(rows, reveal(label), 'dim', width, '  ');
	}
	return rows;
}

/** Fits `rows` into `max` rows, ending with a marker row when something was cut. */
export function clipBody(rows: BodyRow[], max: number, hidden: boolean): BodyRow[] {
	const marker: BodyRow = {text: '(press v to view)', tone: 'dim'};
	if (hidden) return rows.length === 0 ? [] : [marker];
	if (rows.length <= max) return rows;
	if (max <= 1) return [marker];
	const shown = rows.slice(0, max - 1);
	return [...shown, {text: `… +${rows.length - shown.length} more rows (press v to view)`, tone: 'dim'}];
}
