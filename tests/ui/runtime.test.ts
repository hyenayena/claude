import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {test} from 'node:test';

const hostRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const src = (name: string) => pathToFileURL(fileURLToPath(new URL('../../src/ui/' + name, import.meta.url))).href;
const testkit = pathToFileURL(fileURLToPath(new URL('./testkit.ts', import.meta.url))).href;

const script = `
import React from 'react';
const {mountHarness, fakeController} = await import(${JSON.stringify(testkit)});
const {StatusBar, ListPicker, Frame, Spinner, SPINNERS} = await import(${JSON.stringify(src('kit.ts'))});
const {InputLine} = await import(${JSON.stringify(src('InputLine.tsx'))});
const {LiveTools} = await import(${JSON.stringify(src('LiveTools.tsx'))});
const {ChatView} = await import(${JSON.stringify(src('ChatView.tsx'))});
const {PermissionPrompt} = await import(${JSON.stringify(src('PermissionPrompt.tsx'))});
const {QuestionPrompt} = await import(${JSON.stringify(src('QuestionPrompt.tsx'))});
const {initToolPrompt, initQuestionPrompt, layoutPrompt} = await import(${JSON.stringify(src('prompt-state.ts'))});
const {toolReq, questionReq} = await import(${JSON.stringify(testkit)});
const frames = {};
const show = async (name, el) => {
	const h = mountHarness(el);
	await h.settle(40);
	frames[name] = h.lastFrame();
	h.unmount();
};
await show('StatusBar', React.createElement(StatusBar, {text: 'status-ok'}));
await show('ListPicker', React.createElement(ListPicker, {title: 'picker-title', empty: 'none', action: 'resume', items: [{id: '1', label: 'picker-ok'}], onPick() {}, close() {}}));
await show('Frame', React.createElement(Frame, {rows: [{text: 'frame-ok', tone: 'plain'}], width: 40}));
await show('Spinner', React.createElement(Spinner, {frames: SPINNERS.squareCorners, intervalMs: 180}));
await show('InputLine', React.createElement(InputLine, {text: 'input-ok', cursor: 2, columns: 80, running: false, maxRows: 5}));
await show('LiveTools', React.createElement(LiveTools, {tools: [{id: 't', name: 'Bash', input: {command: 'tools-ok'}, elapsedSeconds: 0}], scrub: s => s, maxRows: 4}));
await show('ChatView', React.createElement(ChatView, {controller: fakeController(), print() {}, close() {}, scrub: s => s}));
const reveal = s => s;
const layout = layoutPrompt(24, 80);
const tr = toolReq({input: {command: 'perm-ok'}});
const qr = questionReq();
await show('PermissionPrompt', React.createElement(PermissionPrompt, {request: tr, state: initToolPrompt(tr, 0), layout, reveal, position: 1, total: 1, approvals: 0}));
await show('QuestionPrompt', React.createElement(QuestionPrompt, {request: qr, state: initQuestionPrompt(qr, 0), layout, reveal, position: 1, total: 1}));
const pending = fakeController();
pending.pendingPermissions.push(toolReq({input: {command: 'modal-ok'}}));
await show('ChatViewModal', React.createElement(ChatView, {controller: pending, print() {}, close() {}, scrub: s => s, reveal}));
process.stdout.write('FRAMES:' + JSON.stringify(frames));
process.exit(0);
`;

test('ui components render under tsx run from the host root', () => {
	const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
		cwd: hostRoot,
		encoding: 'utf8',
		timeout: 60_000,
	});
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /ReferenceError|React is not defined/);
	const frames = JSON.parse(result.stdout.slice(result.stdout.indexOf('FRAMES:') + 7)) as Record<string, string>;
	assert.match(frames['StatusBar'] as string, /status-ok/);
	assert.match(frames['ListPicker'] as string, /picker-ok/);
	assert.match(frames['Frame'] as string, /frame-ok/);
	assert.match(frames['Spinner'] as string, /[◰◳◲◱]/);
	assert.match(frames['InputLine'] as string, /input-ok/);
	assert.match(frames['LiveTools'] as string, /Bash\(tools-ok\)/);
	assert.match(frames['ChatView'] as string, /idle$/);
	assert.match(frames['PermissionPrompt'] as string, /perm-ok/);
	assert.match(frames['QuestionPrompt'] as string, /Which color\?/);
	assert.match(frames['ChatViewModal'] as string, /modal-ok/);
	assert.match(frames['ChatViewModal'] as string, /awaiting approval/);
});
