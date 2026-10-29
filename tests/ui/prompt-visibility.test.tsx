import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
import {makeReveal} from '../../src/chat/reveal.js';
import {ChatView} from '../../src/ui/ChatView.js';
import {questionReq, toolReq, fakeController, mountHarness} from './testkit.js';

const reveal = makeReveal(s => s);
const ARM = 40;
let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

const open = async (req: Parameters<ReturnType<typeof fakeController>['request']>[0], rows: number, columns = 80) => {
	const controller = fakeController();
	const h = mountHarness(
		<ChatView controller={controller} print={() => {}} close={() => {}} scrub={s => s} reveal={reveal} armMs={ARM} projectDir="/app" />,
		{columns, rows},
	);
	cleanup.push(() => h.unmount());
	await h.settle();
	controller.request(req);
	await h.settle(ARM + 60);
	return {controller, h};
};

const symlink = () =>
	toolReq({
		toolName: 'Write',
		path: '/app/lnk',
		resolvedPath: '/app/package.json',
		input: {file_path: 'lnk', content: 'x'},
		always: false,
	});

for (const rows of [24, 17, 12, 10, 8, 7, 6, 5, 4]) {
	test(`rows ${rows}: the symlink target and the path are visible before y is accepted`, async () => {
		const {controller, h} = await open(symlink(), rows);
		const frame = h.lastFrame();
		assert.match(frame, /resolves to: \/app\/package\.json/);
		assert.match(frame, /\/app\/lnk/);
		h.press('y');
		await h.settle();
		assert.deepEqual(controller.calls.answers.map(a => a.decision), [{kind: 'allow'}]);
	});

	test(`rows ${rows}: the first command line is visible before y is accepted`, async () => {
		const {h} = await open(toolReq({input: {command: 'visible-cmd --flag\nsecond'}}), rows);
		assert.match(h.lastFrame(), /visible-cmd --flag/);
	});
}

test('rows 3: the minimal tier cannot approve; only refusing works', async () => {
	for (const key of ['y', 'a', '\r', 'r', 'v']) {
		const {controller, h} = await open(toolReq(), 3);
		assert.match(h.lastFrame(), /Permission needed – enlarge the terminal to review \(n to deny\)/);
		h.press(key);
		await h.settle();
		const kinds = controller.calls.answers.map(a => a.decision.kind);
		assert.ok(!kinds.includes('allow'), `key ${JSON.stringify(key)}`);
	}
	const refusals: Array<[string, unknown]> = [
		['n', {kind: 'deny'}],
		['\u001b', {kind: 'deny'}],
		['s', {kind: 'deny', stop: true}],
		['\u0003', {kind: 'deny', stop: true}],
	];
	for (const [key, expected] of refusals) {
		const {controller, h} = await open(toolReq(), 3);
		h.press(key);
		await h.settle(60);
		assert.deepEqual(controller.calls.answers.map(a => a.decision), [expected], JSON.stringify(key));
	}
});

test('growing from 3 to 24 rows re-enables y only after re-arming', async () => {
	const {controller, h} = await open(toolReq(), 3);
	h.press('y');
	await h.settle();
	assert.equal(controller.calls.answers.length, 0);
	h.resize(80, 24);
	await h.settle(10);
	h.press('y');
	await h.settle();
	assert.equal(controller.calls.answers.length, 0);
	await h.settle(ARM + 60);
	assert.match(h.lastFrame(), /Allow once/);
	h.press('y');
	await h.settle();
	assert.deepEqual(controller.calls.answers.map(a => a.decision), [{kind: 'allow'}]);
});

test('questions below 5 rows cannot be answered, only dismissed or stopped', async () => {
	for (const rows of [4, 3]) {
		for (const key of ['1', ' ', '\r', 'o']) {
			const {controller, h} = await open(questionReq(), rows);
			assert.match(h.lastFrame(), /enlarge the terminal to answer \(n to dismiss\)/);
			h.press(key);
			await h.settle();
			assert.equal(controller.calls.answers.length, 0, `rows ${rows} key ${JSON.stringify(key)}`);
		}
		const {controller, h} = await open(questionReq(), rows);
		h.press('n');
		await h.settle();
		assert.deepEqual(controller.calls.answers.map(a => a.decision), [{kind: 'deny'}]);
	}
	const {controller, h} = await open(questionReq(), 5);
	h.press('1');
	await h.settle();
	assert.equal(controller.calls.answers[0]?.decision.kind, 'answers');
});
