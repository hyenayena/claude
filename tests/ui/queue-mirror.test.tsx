import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement} from 'react';
void React;
import {makeScrub} from '../../src/chat/scrub.js';
import {ChatView} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness} from './testkit.js';

const scrub = makeScrub(s => s);
const ENTER = '\r';

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

function setup(queued?: string[]) {
	const controller = Object.assign(fakeController(), {
		detachesOnClose: true as const,
		setQueuedCalls: [] as string[][],
		setQueued(lines: readonly string[]) {
			this.setQueuedCalls.push([...lines]);
		},
		...(queued && {queued}),
	});
	return controller;
}

function mount(controller: ReturnType<typeof setup>) {
	const h = mountHarness(createElement(ChatView, {controller, print() {}, close() {}, scrub}));
	cleanup.push(() => h.unmount());
	return h;
}

test('setQueued mirrors every queue change', async () => {
	const c = setup();
	const t = mount(c);
	c.setState('running');
	await t.settle();
	for (const text of ['one', 'two']) {
		t.press(text);
		await t.settle();
		t.press(ENTER);
		await t.settle();
	}
	assert.deepEqual(c.setQueuedCalls, [['one'], ['one', 'two']]);
	c.setState('idle');
	c.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(c.calls.sent, ['one\n\ntwo']);
	assert.deepEqual(c.setQueuedCalls.at(-1), []);
});

test('the queue of a running chat is restored on attach', async () => {
	const c = setup(['kept one', 'kept two']);
	c.setState('running');
	const t = mount(c);
	await t.settle();
	assert.match(t.lastFrame(), /↳ queued: kept one/);
	c.setState('idle');
	c.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(c.calls.sent, ['kept one\n\nkept two']);
});

test('a queue left over for an idle chat becomes the draft and is cleared remotely', async () => {
	const c = setup(['left over']);
	const t = mount(c);
	await t.settle();
	assert.match(t.lastFrame(), /> left over/);
	assert.deepEqual(c.setQueuedCalls, [[]]);
});

test('leaving a chat in another process does not cancel its pending permissions', async () => {
	const c = setup();
	const t = mount(c);
	c.request({
		kind: 'tool', id: 'p1', seq: 1, toolName: 'Bash', input: {command: 'ls'}, cwd: '/x',
		highlights: [], defaultToNo: false, always: false, oversize: false,
	});
	await t.settle();
	t.unmount();
	assert.deepEqual(c.calls.answers, []);
});
