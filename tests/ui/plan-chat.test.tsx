import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement, type ReactElement} from 'react';
import {makeScrub} from '../../src/chat/scrub.js';
import type {PlanItem} from '../../src/deps/chat.js';
import {stripStyles} from '../../src/kit.js';
import {ChatView, clearSentHistory, type ChatViewProps} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness, toolReq, type FakeController} from './testkit.js';

void React;
const scrub = makeScrub(s => s);
const ESC = '\u001b';
const CTRL_O = '\u000f';

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
	clearSentHistory();
});

const frame = (t: {lastFrame(): string}): string => stripStyles(t.lastFrame());

function headerHostFake(columns = 60) {
	const headers: unknown[] = [];
	const listeners: Array<(e: unknown) => boolean | void> = [];
	const host = {
		isFocused: () => true,
		columns: () => columns,
		subscribe: () => () => {},
		move: () => false,
		isHostKey: () => false,
		setHeader: (element: unknown) => void headers.push(element),
		subscribeMouse: (l: (e: unknown) => boolean | void) => {
			listeners.push(l);
			return () => void listeners.splice(listeners.indexOf(l), 1);
		},
	};
	const press = (x: number, y: number, extra: Record<string, unknown> = {}) =>
		listeners.at(-1)!({kind: 'press', button: 'left', shift: false, meta: false, ctrl: false, width: columns, height: 7, x, y, region: 'header', ...extra});
	return {host, headers, press};
}

function setup(extra: Partial<ChatViewProps> = {}, size = {columns: 60, rows: 30}) {
	const controller: FakeController = fakeController();
	const h = mountHarness(createElement(ChatView, {controller, print: () => {}, close: () => {}, scrub, ...extra}), size);
	cleanup.push(() => h.unmount());
	return {controller, ...h};
}

const many: PlanItem[] = Array.from({length: 20}, (_, i) => ({id: String(i + 1), content: `Step ${i + 1}`, status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending', ...(i === 3 && {activeForm: 'Doing step 4'})}));

async function mountHeader(headers: unknown[], size = {columns: 60, rows: 30}) {
	const header = mountHarness(headers.at(-1) as ReactElement, size);
	cleanup.push(() => header.unmount());
	await header.settle();
	return header;
}

test('the plan goes to the header slot and is not drawn in the chat', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	t.controller.setState('running');
	t.controller.ui({kind: 'plan', items: many});
	await t.settle();
	assert.doesNotMatch(frame(t), /Plan 3\/20/);
	const header = await mountHeader(f.headers);
	assert.match(frame(header), /☰ Plan 3\/20/);
	assert.match(frame(header), /Doing step 4/);
	assert.match(frame(header), /○ Step 5/);
});

test('a click on the widget toggles it; an agent click below it still hits the right box', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	t.controller.setState('running');
	t.controller.ui({kind: 'plan', items: many});
	t.controller.ui({kind: 'tool-use', toolUseId: 'a1', name: 'Agent', input: {subagent_type: 'Explore', prompt: 'Prompt of Explore'}});
	await t.settle();
	assert.equal(f.press(2, 0), true);
	await t.settle();
	const open = await mountHeader(f.headers);
	assert.match(frame(open), /Step 1\b/);
	assert.match(frame(open), /\+\d+ more/);
	assert.equal(f.press(2, 0), true);
	await t.settle();
	const closed = await mountHeader(f.headers);
	assert.doesNotMatch(frame(closed), /Step 1\b/);
	// summary mode: three plan rows, so the first box row sits at y = 3
	assert.equal(f.press(3, 4), true);
	await t.settle();
	assert.match(frame(t), /Subagent Explore · read-only/);
});

test('a click on the widget is ignored while a prompt waits', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	t.controller.ui({kind: 'plan', items: many});
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(200);
	assert.equal(f.press(2, 0), true);
	await t.settle();
	const header = await mountHeader(f.headers);
	assert.doesNotMatch(frame(header), /Step 1\b/);
});

test('Ctrl+O shows the whole plan before the changed files', async () => {
	const t = setup({loadTranscript: async () => ['hello']});
	await t.settle();
	t.controller.ui({kind: 'plan', items: many});
	await t.settle();
	t.press(CTRL_O);
	await t.settle(60);
	const text = frame(t);
	assert.match(text, /Plan 3\/20/);
	assert.match(text, /Step 20/);
	t.press(ESC);
});

test('plan tool results leave no tool row; a failed one does', async () => {
	const printed: string[] = [];
	const t = setup({print: s => void printed.push(stripStyles(s))});
	await t.settle();
	t.controller.setState('running');
	t.controller.ui({kind: 'tool-use', toolUseId: 'c1', name: 'TaskCreate', input: {subject: 'Write tests'}});
	t.controller.ui({kind: 'tool-result', toolUseId: 'c1', isError: false, text: 'Task #1 created successfully: Write tests'});
	t.controller.ui({kind: 'plan', items: [{id: '1', content: 'Write tests', status: 'pending'}, {id: '2', content: 'Docs', status: 'pending'}]});
	t.controller.ui({kind: 'tool-use', toolUseId: 'u1', name: 'TaskUpdate', input: {taskId: '9', status: 'completed'}});
	t.controller.ui({kind: 'tool-result', toolUseId: 'u1', isError: true, text: 'Task not found'});
	await t.settle();
	assert.ok(printed.some(p => /Plan · 2 steps/.test(p)), printed.join('|'));
	assert.ok(!printed.some(p => /TaskCreate/.test(p)));
	assert.ok(printed.some(p => /TaskUpdate/.test(p) && /Task not found/.test(p)) || printed.some(p => /Task not found/.test(p)));
});
