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

test('the scrolled cursor row shows a left cut marker and maps from the first shown grapheme', () => {
	const text = 'abcdefghijkl';
	const [row] = inputRows(text, 12, 11, 1);
	assert.equal(row?.before, '…ghijkl');
	assert.equal(row?.leftCut, true);
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 2), 6, 'the marker maps to the first shown grapheme');
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 3), 6);
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 4), 7);
	assert.equal(cursorFromClick(text, 12, 11, 1, 0, 9), 12);
});

test('other rows are cut with a right marker while the cursor row scrolls', () => {
	const text = 'abcdefghij\nabcdefghijkl';
	const rows = inputRows(text, text.length, 11, 2);
	assert.equal(rows[0]?.before, 'abcdefg…');
	assert.equal(rows[0]?.rightCut, true);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 0, 3), 1);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 0, 40), 10);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 1, 2), 17);
	assert.equal(cursorFromClick(text, text.length, 11, 2, 1, 4), 18);
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

test('a window never starts inside a surrogate pair', () => {
	const text = 'a\u{1f600}bcdefg';
	assert.equal(inputRows(text, text.length, 11, 1)[0]?.before, '…bcdefg');
	assert.equal(cursorFromClick(text, text.length, 11, 1, 0, 2), 3);
	assert.equal(cursorFromClick(text, text.length, 11, 1, 0, 4), 4);
});
