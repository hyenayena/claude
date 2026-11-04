import assert from 'node:assert/strict';
import {test} from 'node:test';
import {viewerRowsOf} from '../../src/ui/ChatView.js';

test('the transcript viewer wraps once per width and reuses the rows while scrolling', () => {
	const v = {lines: ['x'.repeat(25), 'short'], top: -1};
	const rows = viewerRowsOf(v, 11);
	assert.deepEqual(rows, ['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx', 'short']);
	assert.equal(viewerRowsOf(v, 11), rows);
	const scrolled = {...v, top: 2};
	assert.equal(viewerRowsOf(scrolled, 11), rows);
	assert.notEqual(viewerRowsOf(v, 21), rows);
	assert.equal(viewerRowsOf(v, 21).length, 3);
});

test('render items are laid out per width and cached with the rows', () => {
	const widths: number[] = [];
	const item = {render: (w: number) => (widths.push(w), [`card ${w}`, 'second'])};
	const v = {lines: ['head', item], top: -1};
	const rows = viewerRowsOf(v, 21);
	assert.deepEqual(rows, ['head', 'card 20', 'second']);
	assert.equal(viewerRowsOf(v, 21), rows);
	assert.deepEqual(widths, [20]);
	assert.deepEqual(viewerRowsOf(v, 11), ['head', 'card 10', 'second']);
});
