import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement} from 'react';
import {makeScrub} from '../../src/chat/scrub.js';
import {ChatView, clearSentHistory} from '../../src/ui/ChatView.js';
import {fakeController, mountHarness} from './testkit.js';

const ESC = '\u001b';
const ENTER = '\r';
const paste = (s: string) => `${ESC}[200~${s}${ESC}[201~`;
const SGR = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
	clearSentHistory();
});

const COLUMNS = 50;

function setup({title = false, vim = false} = {}) {
	const listeners: Array<(e: unknown) => boolean | void> = [];
	const host = {
		isFocused: () => true,
		columns: () => COLUMNS,
		subscribe: () => () => {},
		move: () => true,
		isHostKey: () => false,
		subscribeMouse: (l: (e: unknown) => boolean | void) => {
			listeners.push(l);
			return () => void listeners.splice(listeners.indexOf(l), 1);
		},
		...(title && {setTitle: () => {}}),
	};
	const controller = fakeController();
	const h = mountHarness(
		createElement(ChatView, {
			controller,
			print() {},
			close() {},
			scrub: makeScrub(s => s),
			credentialLabel: 'API key',
			host,
			...(vim && {inputMode: () => 'vim' as const}),
		}),
		{columns: COLUMNS, rows: 24},
	);
	cleanup.push(() => h.unmount());
	// Debug frames are full writes; cursor toggles arrive as separate chunks.
	const frame = (): string[] => {
		const last = [...h.chunks].reverse().find(c => c.replace(SGR, '').trim() !== '') ?? '';
		const lines = last.replace(SGR, '').split('\n');
		while (lines.length > 0 && lines.at(-1) === '') lines.pop();
		return lines;
	};
	// Aims at the first cell showing `needle`, with the view height core would report: the rendered one.
	const clickOn = (needle: string, offset = 0) => {
		const lines = frame();
		const y = lines.findIndex(l => l.includes(needle));
		assert.ok(y >= 0, `${needle} is shown`);
		const x = lines[y]!.indexOf(needle) + offset;
		return clickAt(x, y);
	};
	const clickAt = (x: number, y: number) =>
		listeners.at(-1)!({kind: 'press', button: 'left', x, y, width: COLUMNS, height: frame().length, shift: false, meta: false, ctrl: false});
	return {h, controller, frame, clickOn};
}

for (const title of [false, true]) {
	test(`mouse: a click on any row of a multi-line draft lands there (${title ? 'title bar host' : 'status bar in the view'})`, async () => {
		const t = setup({title});
		await t.h.settle();
		t.h.press(paste('alpha\nbravo\ncharlie'));
		await t.h.settle();
		assert.equal(t.frame().some(l => l.includes('API key')), !title, 'the status bar is in the view only without setTitle');
		assert.equal(t.clickOn('bravo', 2), true);
		t.h.press('X');
		await t.h.settle();
		assert.equal(t.clickOn('alpha', 0), true);
		t.h.press('Y');
		await t.h.settle();
		assert.equal(t.clickOn('charlie', 7), true, 'past the end of the last line');
		t.h.press('Z');
		await t.h.settle();
		t.h.press(ENTER);
		await t.h.settle();
		assert.deepEqual(t.controller.calls.sent, ['Yalpha\nbrXavo\ncharlieZ']);
	});
}

test('mouse: in vim NORMAL the mode line below the input is accounted for on a multi-line draft', async () => {
	const t = setup({vim: true});
	await t.h.settle();
	t.h.press(paste('abc\ndef'));
	await t.h.settle();
	t.h.press(ESC);
	await t.h.settle(60);
	assert.ok(t.frame().some(l => l.includes('-- NORMAL --')));
	assert.equal(t.clickOn('abc', 1), true);
	t.h.press('x');
	await t.h.settle();
	assert.ok(t.frame().some(l => l.includes('> ac')), t.frame().join('\n'));
	assert.equal(t.clickOn('-- NORMAL --'), false);
});
