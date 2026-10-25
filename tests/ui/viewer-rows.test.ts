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
