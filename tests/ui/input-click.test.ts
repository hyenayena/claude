import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cursorFromClick, inputRows} from '../../src/ui/InputLine.js';

const FAMILY = '\u{1f468}‍\u{1f469}‍\u{1f467}';

test('ASCII: cells map to offsets, prefix cells to the row start, past the end to the line end', () => {
	assert.equal(cursorFromClick('hello', 5, 80, 1, 0, 2), 0);
	assert.equal(cursorFromClick('hello', 5, 80, 1, 0, 4), 2);
	assert.equal(cursorFromClick('hello', 5, 80, 1, 0, 0), 0);
	assert.equal(cursorFromClick('hello', 5, 80, 1, 0, 1), 0);
	assert.equal(cursorFromClick('hello', 0, 80, 1, 0, 6), 4);
	assert.equal(cursorFromClick('hello', 0, 80, 1, 0, 7), 5);
	assert.equal(cursorFromClick('hello', 0, 80, 1, 0, 70), 5);
	assert.equal(cursorFromClick('', 0, 80, 1, 0, 9), 0);
});

test('wide characters take two cells each', () => {
	const text = '日本語';
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 2), 0);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 3), 0);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 4), 1);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 7), 2);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 8), 3);
});

test('a ZWJ emoji is one two-cell cluster', () => {
	const text = `a${FAMILY}b`;
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 3), 1);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 4), 1);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 5), 1 + FAMILY.length);
});

test('combining marks belong to their base character', () => {
	const text = 'éx';
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 2), 0);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 3), 2);
	assert.equal(cursorFromClick(text, 0, 80, 1, 0, 4), 3);
});

test('the scrolled cursor row maps from its first shown unit', () => {
	const text = 'abcdefghijkl';
	const [row] = inputRows(text, 12, 11, 1);
	assert.equal(row?.before, 'fghijkl');
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 2), 5);
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 4), 7);
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 9), 12);
});

test('other rows start at their first unit while the cursor row scrolls', () => {
	const text = 'abcdefghij\nabcdefghijkl';
	assert.equal(cursorFromClick(text, text.length, 11, 2, 0, 3), 1);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 0, 40), 10);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 1, 2), 16);
});

test('with the first lines scrolled off, row 0 is the first shown line', () => {
	const text = 'a\nb\nc\nd';
	assert.deepEqual(inputRows(text, 7, 80, 2).map(r => r.before), ['c', 'd']);
	assert.equal(cursorFromClick(text, 7, 80, 2, 0, 2), 4);
	assert.equal(cursorFromClick(text, 7, 80, 2, 0, 9), 5);
	assert.equal(cursorFromClick(text, 7, 80, 2, 1, 5), 7);
});

test('rows that are not shown give undefined', () => {
	assert.equal(cursorFromClick('a\nb\nc', 0, 80, 2, 2, 2), undefined);
	assert.equal(cursorFromClick('abc', 0, 80, 3, 1, 2), undefined);
	assert.equal(cursorFromClick('abc', 0, 80, 1, -1, 2), undefined);
	assert.equal(cursorFromClick('abc', 0, 80, 1, 0.5, 2), undefined);
});

test('a slice that starts inside a surrogate pair snaps to the cluster start', () => {
	const text = 'a\u{1f600}bcdefg';
	assert.equal(inputRows(text, text.length, 11, 1)[0]?.before.charCodeAt(0), 0xde00);
	assert.equal(cursorFromClick(text, text.length, 11, 1, 0, 2), 1);
});
