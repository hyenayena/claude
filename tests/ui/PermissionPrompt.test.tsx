import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
import {makeReveal} from '../../src/chat/reveal.js';
import {PermissionPrompt, toolHeader} from '../../src/ui/PermissionPrompt.js';
import {initQuestionPrompt, initToolPrompt, layoutPrompt, type ToolPromptState} from '../../src/ui/prompt-state.js';
import {QuestionPrompt} from '../../src/ui/QuestionPrompt.js';
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
	assert.equal(lines[0], 'Bash: run this command as root in /app (network access, can modify the project)?');
	assert.match(frame, /│ ls -la/);
	assert.match(frame, /│ cwd: \/app/);
	assert.match(frame, /│ Notable: non-ASCII/);
	assert.match(frame, /Claude's description \(not verified\): lists files/);
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
	assert.equal(frame.split('\n')[0], 'Question from Claude (not a permission request) · Question');
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
