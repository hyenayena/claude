import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
import type {ToolRequest} from '../../src/chat/permission.js';
import {makeReveal} from '../../src/chat/reveal.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {ChatView} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness, toolReq} from './testkit.js';

const reveal = makeReveal(s => s);
const scrub = makeScrub(s => s);

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

async function enterOn(request: ToolRequest, rows: number) {
	const controller = fakeController();
	controller.pendingPermissions.push(request);
	const h = mountHarness(
		<ChatView
			controller={controller}
			print={() => {}}
			close={() => {}}
			scrub={scrub}
			reveal={reveal}
			credentialLabel="API key"
			armMs={20}
			projectDir="/app"
		/>,
		{columns: 80, rows},
	);
	cleanup.push(() => h.unmount());
	await h.settle(100);
	h.press('\r');
	await h.settle(100);
	return controller.calls.answers.map(a => a.decision.kind);
}

test('Enter below 4 rows denies instead of approving', async () => {
	for (const rows of [3, 2, 1]) {
		assert.deepEqual(await enterOn(toolReq(), rows), ['deny'], `rows ${rows}`);
	}
});

test('a stray Enter on a defaultToNo or oversize prompt denies at every size', async () => {
	const risky = [toolReq({defaultToNo: true}), toolReq({oversize: true, input: {command: 'x'.repeat(30_000)}})];
	for (const request of risky) {
		for (const rows of [24, 9, 4]) {
			assert.deepEqual(await enterOn(request, rows), ['deny'], `rows ${rows}`);
		}
	}
});
