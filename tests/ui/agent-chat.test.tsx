import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement, isValidElement, type ReactElement} from 'react';
import {makeScrub} from '../../src/chat/scrub.js';
import {ChatView, clearSentHistory, type ChatViewProps} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness, toolReq, type FakeController} from './testkit.js';

void React;
const scrub = makeScrub(s => s);
const ESC = '\u001b';
const ENTER = '\r';
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
	clearSentHistory();
});

function setup(extra: Partial<ChatViewProps> = {}, size = {columns: 80, rows: 30}) {
	const controller: FakeController = fakeController();
	const h = mountHarness(createElement(ChatView, {controller, print: () => {}, close: () => {}, scrub, ...extra}), size);
	cleanup.push(() => h.unmount());
	return {controller, ...h};
}

const spawn = (c: FakeController, id: string, type: string) =>
	c.ui({kind: 'tool-use', toolUseId: id, name: 'Agent', input: {subagent_type: type, prompt: `Prompt of ${type}`}});

test('without a header slot the panel sits in the chat; ↓ selects, Enter opens, ←/→ switch, Esc goes back', async () => {
	const t = setup();
	await t.settle();
	t.controller.setState('running');
	spawn(t.controller, 'a1', 'Explore');
	spawn(t.controller, 'a2', 'Coder');
	t.controller.ui({kind: 'agent-message', agentId: 'a1', items: [{type: 'text', text: 'Looking around'}]});
	await t.settle();
	assert.match(t.lastFrame(), /Explore/);
	assert.match(t.lastFrame(), /Coder/);
	assert.match(t.lastFrame(), /╭/, 'the fallback panel draws its boxes in the chat');
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /Subagent Explore · read-only/);
	assert.match(t.lastFrame(), /> Prompt of Explore/);
	assert.match(t.lastFrame(), /Looking around/);
	t.press(RIGHT);
	await t.settle();
	assert.match(t.lastFrame(), /Subagent Coder · read-only/);
	t.press(LEFT);
	await t.settle();
	assert.match(t.lastFrame(), /Subagent Explore · read-only/);
	t.press('abc');
	await t.settle();
	t.press(ESC);
	await t.settle(80);
	assert.doesNotMatch(t.lastFrame(), /read-only/);
	assert.equal(t.controller.calls.interrupts, 0, 'Esc in the subagent view never interrupts the turn');
	t.press(ESC);
	await t.settle(80);
	assert.equal(t.controller.calls.interrupts, 0, 'Esc in the selection only leaves it');
	t.press('x');
	await t.settle();
	assert.match(t.lastFrame(), /> x/, 'typing in the view was ignored; the selection lets a printable key through');
});

test('↓ does nothing special without boxes, with text in the input, or while browsing history', async () => {
	const t = setup();
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /read-only/);
	spawn(t.controller, 'a1', 'Explore');
	t.press('hi');
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /read-only/);
	assert.deepEqual(t.controller.calls.sent, ['hi']);
});

test('↑ from the top row of boxes returns to the input', async () => {
	const t = setup();
	await t.settle();
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(UP);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /read-only/);
});

function headerHostFake(columns = 50) {
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
	const send = (e: Record<string, unknown>) =>
		listeners.at(-1)!({button: 'none', shift: false, meta: false, ctrl: false, width: columns, height: 7, ...e});
	return {host, headers, listeners, send};
}

test('with a header slot the panel goes to the host; a header click opens and closes a box', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	assert.equal(f.headers.length, 1);
	assert.ok(isValidElement(f.headers[0]));
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /╭/, 'no fallback panel inside the chat');
	const header = mountHarness(f.headers[0] as ReactElement, {columns: 50, rows: 30});
	cleanup.push(() => header.unmount());
	await header.settle();
	assert.match(header.lastFrame(), /Explore/);
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 1, region: 'header'}), true);
	await t.settle();
	assert.match(t.lastFrame(), /Subagent Explore · read-only/);
	assert.equal(f.send({kind: 'wheel', wheel: 'down', x: 3, y: 3, height: 10}), true, 'the wheel scrolls the open view');
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 1, region: 'header'}), true);
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /read-only/);
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 6, region: 'header'}), true, 'header events never fall through');
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 1, region: 'body'}), false, 'an unknown region is refused');
	t.unmount();
	assert.equal(f.headers.at(-1), null, 'the header is cleared on unmount');
});

test('agents still running when the view mounts are seeded from the controller tasks', async () => {
	const controller = fakeController();
	Object.assign(controller, {tasks: [{id: 'T1', status: 'running', background: true, taskType: 'local_agent', toolUseId: 'tu1', subagentType: 'Researcher', description: 'Dig'}]});
	const h = mountHarness(createElement(ChatView, {controller, print: () => {}, close: () => {}, scrub}), {columns: 80, rows: 30});
	cleanup.push(() => h.unmount());
	await h.settle();
	assert.match(h.lastFrame(), /Researcher/);
	h.press(DOWN);
	await h.settle();
	h.press(ENTER);
	await h.settle();
	assert.match(h.lastFrame(), /Earlier messages are not available/);
});

test('a permission prompt takes precedence over an open subagent view and its keys', async () => {
	const t = setup();
	await t.settle();
	t.controller.setState('running');
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /read-only/);
	t.controller.request(toolReq());
	await t.settle(400);
	assert.doesNotMatch(t.lastFrame(), /read-only/, 'the prompt is drawn instead of the subagent view');
	t.press(ESC);
	await t.settle(80);
	assert.equal(t.controller.calls.interrupts, 0, 'Esc in a prompt is the prompt\'s own key, never an interrupt');
	assert.equal(t.controller.pendingPermissions.length > 0 || t.controller.calls.answers.length > 0, true);
});

test('typing is ignored while a subagent is open', async () => {
	const t = setup();
	await t.settle();
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	t.press('typed');
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, []);
	t.press(ESC);
	await t.settle(80);
	assert.doesNotMatch(t.lastFrame(), /typed/);
});

test('a paste is ignored while a subagent is open', async () => {
	const t = setup();
	await t.settle();
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.press(DOWN);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	t.press(`${ESC}[200~pasted${ESC}[201~`);
	await t.settle();
	t.press(ESC);
	await t.settle(80);
	t.press(ESC);
	await t.settle(80);
	assert.doesNotMatch(t.lastFrame(), /pasted/);
});

test('the header wheel scrolls the panel away from an open box', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	for (let i = 0; i < 12; i++) spawn(t.controller, `a${i}`, `Worker${i}`);
	await t.settle();
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 1, region: 'header'}), true);
	await t.settle();
	assert.match(t.lastFrame(), /Subagent Worker0 · read-only/);
	const header = mountHarness(f.headers.at(-1) as ReactElement, {columns: 50, rows: 30});
	cleanup.push(() => header.unmount());
	await header.settle();
	assert.doesNotMatch(header.lastFrame(), /↑/);
	f.send({kind: 'wheel', wheel: 'down', x: 3, y: 3, region: 'header'});
	f.send({kind: 'wheel', wheel: 'down', x: 3, y: 3, region: 'header'});
	await header.settle();
	assert.match(header.lastFrame(), /↑ \d+ more/, 'the wheel is not undone by the open box');
	assert.doesNotMatch(header.lastFrame(), /Worker0\b/);
	assert.match(t.lastFrame(), /Subagent Worker0 · read-only/);
});

test('header clicks are ignored while a permission prompt is shown', async () => {
	const f = headerHostFake();
	const t = setup({host: f.host as never});
	await t.settle();
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(400);
	assert.equal(f.send({kind: 'press', button: 'left', x: 3, y: 1, region: 'header'}), true);
	await t.settle();
	t.controller.resolved(t.controller.pendingPermissions[0]!.id);
	await t.settle(80);
	assert.doesNotMatch(t.lastFrame(), /read-only/, 'the click did not open the box behind the prompt');
});

test('without a header slot the panel is drawn above a permission prompt and the transcript viewer', async () => {
	const t = setup({loadTranscript: async () => ['transcript line']});
	await t.settle();
	spawn(t.controller, 'a1', 'Explore');
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(400);
	assert.match(t.lastFrame(), /╭/, 'the panel is drawn with the prompt');
	assert.match(t.lastFrame(), /Explore/);
	t.controller.resolved(t.controller.pendingPermissions[0]!.id);
	await t.settle(80);
	t.press('\u000f');
	await t.settle(80);
	assert.match(t.lastFrame(), /Transcript \d+\/\d+/);
	assert.match(t.lastFrame(), /╭/, 'the panel is drawn with the viewer');
});
