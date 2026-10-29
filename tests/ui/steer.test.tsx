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

function setup() {
	const base = fakeController();
	const controller = Object.assign(base, {
		steered: [] as string[],
		steerFails: false,
		steer(text: string) {
			if (controller.steerFails) throw new Error('No request is running');
			controller.steered.push(text);
			base.emit({type: 'sent', text});
		},
	});
	const t = mountHarness(createElement(ChatView, {controller, print() {}, close() {}, scrub}));
	cleanup.push(() => t.unmount());
	return {c: controller, t};
}

async function type(t: ReturnType<typeof setup>['t'], text: string) {
	t.press(text);
	await t.settle();
	t.press(ENTER);
	await t.settle();
}

test('Enter while a turn runs hands the message to the turn instead of queueing it', async () => {
	const {c, t} = setup();
	c.setState('running');
	await t.settle();
	await type(t, 'also check the tests');
	assert.deepEqual(c.steered, ['also check the tests']);
	assert.doesNotMatch(t.lastFrame(), /queued/);
	c.setState('idle');
	c.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(c.calls.sent, []);
});

test('a refused steer falls back to the queue, and later messages wait behind it', async () => {
	const {c, t} = setup();
	c.setState('running');
	await t.settle();
	c.steerFails = true;
	await type(t, 'one');
	c.steerFails = false;
	await type(t, 'two');
	assert.deepEqual(c.steered, []);
	assert.match(t.lastFrame(), /↳ queued: one/);
	c.setState('idle');
	c.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(c.calls.sent, ['one\n\ntwo']);
});

test('a steer the chat process could not deliver comes back to the queue or the draft', async () => {
	const {c, t} = setup();
	c.setState('running');
	await t.settle();
	c.emit({type: 'steer-failed', text: 'lost in transit'});
	await t.settle();
	assert.match(t.lastFrame(), /↳ queued: lost in transit/);
	c.setState('idle');
	c.emit({type: 'turn-end', outcome: 'interrupted'});
	await t.settle();
	c.emit({type: 'steer-failed', text: 'after the end'});
	await t.settle();
	assert.match(t.lastFrame(), /> after the end/);
});
