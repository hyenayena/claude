import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cellWidth, countRows, stringWidth, wrapRows} from '../../src/chat/wrap.js';

test('cellWidth: ascii, wide, zero-width and emoji', () => {
	assert.equal(cellWidth(0x61), 1);
	assert.equal(cellWidth(0x4e2d), 2);
	assert.equal(cellWidth(0xff21), 2);
	assert.equal(cellWidth(0x0301), 0);
	assert.equal(cellWidth(0x200b), 0);
	assert.equal(cellWidth(0x200d), 0);
	assert.equal(cellWidth(0xfe0f), 0);
	assert.equal(cellWidth(0x1f600), 2);
	assert.equal(cellWidth(0x1b), 0);
});

test('wrapRows splits by cells, not by code units', () => {
	assert.deepEqual(wrapRows('abcdef', 4), ['abcd', 'ef']);
	assert.deepEqual(wrapRows('中中中', 4), ['中中', '中']);
	assert.deepEqual(wrapRows('中中中', 5), ['中中', '中']);
});

test('wrapRows keeps empty lines and strips CR', () => {
	assert.deepEqual(wrapRows('a\n\nb\r\nc', 10), ['a', '', 'b', 'c']);
	assert.deepEqual(wrapRows('', 10), ['']);
});

test('wrapRows breaks long tokens', () => {
	const rows = wrapRows('x'.repeat(25), 10);
	assert.deepEqual(rows.map(r => r.length), [10, 10, 5]);
});

test('combining marks and ZWJ sequences stay attached', () => {
	assert.deepEqual(wrapRows('ééé', 2), ['éé', 'é']);
	assert.equal(stringWidth('é'), 1);
	const family = '\u{1F468}‍\u{1F469}';
	assert.ok(wrapRows(family + family, 4).every(r => !r.startsWith('‍')));
});

test('degenerate widths terminate', () => {
	assert.deepEqual(wrapRows('ab中', 1), ['a', 'b', '中']);
	assert.deepEqual(wrapRows('ab', 0), ['a', 'b']);
	assert.deepEqual(wrapRows('ab', -5), ['a', 'b']);
	assert.deepEqual(wrapRows('ab', Number.NaN), ['a', 'b']);
	assert.equal(countRows('abcd', 2), 2);
});
