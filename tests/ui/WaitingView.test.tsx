import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement} from 'react';
void React;
import {waitingText, WaitingView} from '../../src/ui/WaitingView.js';
import {mountHarness, wait} from './testkit.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

test('shows the waiting line with the title, polls, and calls onFree', async () => {
	let free = false;
	let freed = 0;
	const h = mountHarness(
		createElement(WaitingView, {
			check: async () => ({free, title: 'Fix parser'}),
			onFree: () => freed++,
			onCancel() {},
			pollMs: 10,
			title: 'chat',
		}),
	);
	cleanup.push(() => h.unmount());
	await h.settle(40);
	assert.match(h.lastFrame(), /Waiting for session Fix parser to finish · claude stop ends it · Esc cancels/);
	assert.equal(freed, 0);
	free = true;
	await wait(60);
	assert.equal(freed, 1);
});

test('Esc cancels', async () => {
	let cancelled = 0;
	const h = mountHarness(createElement(WaitingView, {check: async () => ({free: false}), onFree() {}, onCancel: () => cancelled++, pollMs: 10}));
	cleanup.push(() => h.unmount());
	await h.settle();
	h.press('\u001b');
	await h.settle(50);
	assert.equal(cancelled, 1);
	assert.match(waitingText(undefined), /in another yena/);
});
