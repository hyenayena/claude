import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
import {makeReveal} from '../../src/chat/reveal.js';
import {PermissionPrompt, toolHeader} from '../../src/ui/PermissionPrompt.js';
import {initQuestionPrompt, initToolPrompt, layoutPrompt, type ToolPromptState} from '../../src/ui/prompt-state.js';
import {optionWindow, QuestionPrompt} from '../../src/ui/QuestionPrompt.js';
import {stringCells} from '../../src/kit.js';
import {mountHarness, questionReq, toolReq} from './testkit.js';

const reveal = makeReveal(s => s);
let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

const show = async (el: React.ReactElement, size = {columns: 80, rows: 24}) => {
	const h = mountHarness(el, size);
	cleanup.push(() => h.unmount());
	await h.settle(40);
	return h.lastFrame();
};

const tool = (req = toolReq(), over: Partial<React.ComponentProps<typeof PermissionPrompt>> = {}, rows = 24) => (
	<PermissionPrompt
		request={req}
		state={initToolPrompt(req, 0)}
		layout={layoutPrompt(rows, 80)}
		reveal={reveal}
		position={1}
		total={1}
		approvals={0}
		{...over}
	/>
);

test('Bash prompt: fixed header, bordered content, five choices and a hint', async () => {
	const frame = await show(tool(toolReq({description: 'lists files', highlights: [{level: 'info', text: 'non-ASCII'}]})));
	const lines = frame.split('\n');
	assert.equal(lines.slice(0, 2).join(' '), 'Bash: run this command as root in /app (network access, can modify the project)?', 'a long header wraps instead of being cut');
	assert.match(frame, /│ ls -la/);
	assert.match(frame, /│ cwd: \/app/);
	assert.match(frame, /│ Notable: non-ASCII/);
	assert.match(frame, /yena's description \(not verified\): lists files/);
	assert.match(frame, /❯ y {2}Allow once/);
	assert.match(frame, /a {2}Always allow in this chat/);
	assert.match(frame, /Always allow this exact command in this chat: ls -la/);
	assert.match(frame, /s {2}Deny all and stop the turn/);
	assert.match(frame, /y allow · a always/);
});

test('Edit prompt shows the path header, the preview label and the diff', async () => {
	const req = toolReq({
		toolName: 'Edit',
		path: '/app/a.ts',
		input: {file_path: '/app/a.ts'},
		always: false,
		preview: {
			rows: [
				{kind: 'del', text: 'old', no: 3},
				{kind: 'add', text: 'new', no: 3},
			],
			added: 1,
			removed: 1,
			truncated: false,
			approximate: true,
		},
	});
	const frame = await show(tool(req));
	assert.equal(frame.split('\n')[0], 'Edit: /app/a.ts');
	assert.match(frame, /Preview of the proposed change \(approximate\)/);
	assert.match(frame, /3 - old/);
	assert.match(frame, /3 \+ new/);
	assert.match(frame, /Always-allow is not available for this command/);
	assert.doesNotMatch(frame, /Always allow in this chat/);
});

test('restricted requests hide the y shortcut and open on Deny', async () => {
	const req = toolReq({defaultToNo: true, always: false});
	const frame = await show(tool(req));
	assert.match(frame, /❯ n {2}Deny/);
	assert.doesNotMatch(frame, /y {2}Allow once/);
	assert.match(frame, /^ {3}\s*Allow once/m);
	assert.doesNotMatch(frame, /y allow/);
});

test('queue position and approval fatigue appear in the header', async () => {
	const frame = await show(tool(toolReq(), {position: 2, total: 3, approvals: 5}));
	assert.match(frame.split('\n')[0] as string, /^Permission 2 of 3 · 5 approvals this turn · Bash/);
});

test('a notice replaces the hint line', async () => {
	const frame = await show(tool(toolReq(), {notice: 'That shortcut is disabled'}));
	assert.match(frame, /That shortcut is disabled/);
	assert.doesNotMatch(frame, /v view full/);
});

test('reason mode shows the editor and the full view shows the pager', async () => {
	const req = toolReq();
	const reason: ToolPromptState = {...initToolPrompt(req, 0), view: 'reason', reason: 'because'};
	const frame = await show(tool(req, {state: reason}));
	assert.match(frame, /Reason: because/);
	assert.doesNotMatch(frame, /Allow once/);

	const command = Array.from({length: 60}, (_, i) => `line ${i}`).join('\n');
	const big = toolReq({input: {command}});
	const full: ToolPromptState = {...initToolPrompt(big, 0), view: 'full', scroll: 5};
	const pager = await show(tool(big, {state: full}));
	assert.match(pager, /Full view · rows 6-/);
	assert.match(pager, /│ line 5\n/);
	assert.doesNotMatch(pager, /Allow once/);
});

test('compact layout at 10 rows keeps header, border, body, one choices line and the status slot', async () => {
	const command = Array.from({length: 30}, (_, i) => `line ${i}`).join('\n');
	const frame = await show(tool(toolReq({input: {command}}), {layout: layoutPrompt(10, 80)}, 10), {columns: 80, rows: 10});
	const lines = frame.replace(/\n+$/, '').split('\n');
	assert.ok(lines.length <= 7, `${lines.length} rows`);
	assert.match(frame, /more rows \(press v to view\)/);
	assert.match(frame, /❯ Allow once \(y\)/);
	const tiny = await show(tool(toolReq({input: {command}}), {layout: layoutPrompt(7, 40)}, 7), {columns: 40, rows: 7});
	assert.match(tiny, /\(press v to view\)/);
});

test('toolHeader reveals control characters in paths', () => {
	const req = toolReq({toolName: 'Write', path: '/app/a\u001b[2Jb', input: {}});
	assert.equal(toolHeader(req, reveal), 'Write: /app/a\u27e6\\x1b\u27e7[2Jb');
});

test('question prompt has its own header, options and Other row', async () => {
	const req = questionReq();
	const frame = await show(
		<QuestionPrompt
			request={req}
			state={initQuestionPrompt(req, 0)}
			layout={layoutPrompt(24, 80)}
			reveal={reveal}
			position={1}
			total={1}
		/>,
	);
	assert.equal(frame.split('\n')[0], 'Question from yena (not a permission request) · Question');
	assert.match(frame, /│ \[Color\] Which color\?/);
	assert.match(frame, /❯ 1 Red — warm/);
	assert.match(frame, /3 Other \(type your own answer\)/);
	assert.doesNotMatch(frame, /Allow once/);
});

test('multi-select marks and the Other editor render', async () => {
	const req = questionReq({
		questions: [
			{
				question: 'Pick',
				header: 'P',
				multiSelect: true,
				options: [
					{label: 'Red', description: ''},
					{label: 'Blue', description: ''},
				],
			},
		],
	});
	const base = initQuestionPrompt(req, 0);
	const picked = await show(
		<QuestionPrompt request={req} state={{...base, picked: [1]}} layout={layoutPrompt(24, 80)} reveal={reveal} position={1} total={1} />,
	);
	assert.match(picked, /1 \[ \] Red/);
	assert.match(picked, /2 \[x\] Blue/);
	const other = await show(
		<QuestionPrompt request={req} state={{...base, view: 'other', other: 'mine'}} layout={layoutPrompt(24, 80)} reveal={reveal} position={1} total={1} />,
	);
	assert.match(other, /Your answer: mine/);
});

test('a symlink target shows the resolved path in the prompt, the tiny form and the pager', async () => {
	const req = toolReq({
		toolName: 'Write',
		path: '/app/sub/linkpkg',
		resolvedPath: '/app/package.json',
		input: {file_path: 'sub/linkpkg', content: 'x'},
		always: false,
	});
	assert.match(await show(tool(req)), /│ resolves to: \/app\/package\.json/);
	assert.match(await show(tool(req, {layout: layoutPrompt(6, 80)}, 6), {columns: 80, rows: 6}), /resolves to: \/app\/package\.json/);
	const full: ToolPromptState = {...initToolPrompt(req, 0), view: 'full'};
	assert.match(await show(tool(req, {state: full})), /resolves to: \/app\/package\.json/);
	assert.doesNotMatch(await show(tool(toolReq({toolName: 'Write', path: '/app/a', input: {}}))), /resolves to/);
});

test('Command prompt: header shows the console line and there is no always option', async () => {
	const req = toolReq({toolName: 'Command', input: {command: 'mod remove x'}, always: false});
	assert.equal(toolHeader(req, reveal), 'Run console command: mod remove x?');
	const frame = await show(tool(req));
	assert.ok(frame.includes('Run console command: mod remove x?'));
	assert.ok(frame.includes('mod remove x'));
	assert.equal(/a always/.test(frame), false);
});

const CSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');
const plainRows = (frame: string) => frame.replace(CSI, '').split('\n');
const words = (frame: string) => plainRows(frame).join(' ').replace(/[│❯]/g, ' ').split(/\s+/).filter(Boolean);
const LONG = 'the quick brown fox jumps over the lazy dog and keeps running far beyond the right edge of a narrow terminal window';

test('long question options wrap instead of ending in an ellipsis, within the width and height', async () => {
	const req = questionReq({
		questions: [{question: 'Which?', header: 'H', multiSelect: false, options: [{label: 'First', description: LONG}, {label: 'Second', description: 'short'}]}],
	});
	const frame = await show(
		<QuestionPrompt request={req} state={initQuestionPrompt(req, 0)} layout={layoutPrompt(24, 60)} reveal={reveal} position={1} total={1} />,
		{columns: 60, rows: 24},
	);
	const rows = plainRows(frame);
	for (const w of LONG.split(' ')) assert.ok(words(frame).includes(w), `"${w}" is shown`);
	assert.doesNotMatch(frame, /…/, "neither the options nor the key hint are cut");
	assert.ok(words(frame).includes("stop"), "the key hint keeps its last key");
	assert.match(frame, /2 Second — short/);
	assert.ok(rows.every(r => stringCells(r) <= 59), 'no row reaches the last column');
	assert.ok(rows.length <= 24);
});

test('a long typed Other answer and denial reason stay visible over several rows', async () => {
	const req = questionReq();
	const other = await show(
		<QuestionPrompt request={req} state={{...initQuestionPrompt(req, 0), view: 'other', other: LONG}} layout={layoutPrompt(24, 60)} reveal={reveal} position={1} total={1} />,
		{columns: 60, rows: 24},
	);
	for (const w of LONG.split(' ')) assert.ok(words(other).includes(w), `answer word "${w}" is shown`);
	assert.match(other, /Your answer: the quick/);
	assert.match(other, /Enter confirms · Esc goes back/);

	const reason: ToolPromptState = {...initToolPrompt(toolReq(), 0), view: 'reason', reason: LONG};
	const denied = await show(tool(toolReq(), {state: reason, layout: layoutPrompt(24, 60)}), {columns: 60, rows: 24});
	for (const w of LONG.split(' ')) assert.ok(words(denied).includes(w), `reason word "${w}" is shown`);
	assert.ok(plainRows(denied).length <= 24);
});

test('optionWindow keeps the cursor option and fills the room around it', () => {
	assert.deepEqual(optionWindow([1, 1, 1, 1], 0, 2), [0, 1]);
	assert.deepEqual(optionWindow([1, 1, 1, 1], 3, 2), [2, 3]);
	assert.deepEqual(optionWindow([3, 1, 1], 1, 3), [1, 2]);
	assert.deepEqual(optionWindow([5, 1], 0, 2), [0, 0], 'a tall cursor option is still shown');
	assert.deepEqual(optionWindow([], 0, 3), [0, -1]);
});
