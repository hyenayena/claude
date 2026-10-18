import assert from 'node:assert/strict';
import {test} from 'node:test';
import {diffLines, locateEdit, previewNewFile} from '../../src/chat/diff.js';

const kinds = (p: {rows: {kind: string}[]}) => p.rows.map(r => r.kind);

test('identical and empty inputs give no rows', () => {
	for (const [a, b] of [['', ''], ['a\nb\n', 'a\nb\n'], ['x', 'x']] as const) {
		const p = diffLines(a, b);
		assert.deepEqual(p, {rows: [], added: 0, removed: 0, truncated: false, approximate: false});
	}
});

test('single line changes', () => {
	const p = diffLines('a', 'b');
	assert.deepEqual(p.rows, [
		{kind: 'del', text: 'a', no: 1},
		{kind: 'add', text: 'b', no: 1},
	]);
	assert.equal(p.added, 1);
	assert.equal(p.removed, 1);
	assert.equal(diffLines('', 'x\ny').added, 2);
	assert.equal(diffLines('x\ny', '').removed, 2);
});

test('context, line numbers and gap rows', () => {
	const old = Array.from({length: 30}, (_, i) => `l${i + 1}`);
	const next = [...old];
	next[14] = 'CHANGED';
	const p = diffLines(old.join('\n'), next.join('\n'));
	assert.deepEqual(kinds(p), ['gap', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'gap']);
	assert.equal(p.rows[0]?.text, '... 11 unchanged lines');
	assert.equal(p.rows[1]?.no, 12);
	assert.equal(p.rows[4]?.no, 15);
	assert.equal(p.rows[9]?.text, '... 12 unchanged lines');
	assert.equal(p.approximate, false);
});

test('insertion and deletion in the middle', () => {
	const p = diffLines('a\nb\nc\nd', 'a\nb\nX\nY\nc\nd', {context: 1});
	assert.deepEqual(
		p.rows.map(r => [r.kind, r.text]),
		[['gap', '... 1 unchanged lines'], ['ctx', 'b'], ['add', 'X'], ['add', 'Y'], ['ctx', 'c'], ['gap', '... 1 unchanged lines']],
	);
	const q = diffLines('a\nb\nc\nd\ne', 'a\nd\ne');
	assert.equal(q.removed, 2);
	assert.equal(q.added, 0);
});

test('Myers handles interleaved edits minimally', () => {
	const p = diffLines('a\nb\nc\nd\ne\nf', 'a\nc\nb\nd\nf\ng');
	assert.equal(p.added + p.removed <= 6, true);
	const kept = p.rows.filter(r => r.kind === 'ctx').length;
	assert.ok(kept >= 3);
});

test('CRLF and mixed endings', () => {
	const same = diffLines('a\r\nb\r\n', 'a\r\nb\r\n');
	assert.equal(same.rows.length, 0);
	const p = diffLines('a\r\nb\r\n', 'a\r\nB\r\n');
	assert.deepEqual(p.rows.map(r => r.text), ['a', 'b', 'B']);
	const mixed = diffLines('a\r\nb\n', 'a\nb\n');
	assert.equal(mixed.removed, 1);
	assert.equal(mixed.rows.find(r => r.kind === 'del')?.text, 'a');
});

test('ESC and bidi stay raw', () => {
	const evil = 'x\u001b[31m‮';
	const p = diffLines('a', evil);
	assert.equal(p.rows.find(r => r.kind === 'add')?.text, evil);
});

test('maxRows truncates with a marker', () => {
	const old = Array.from({length: 100}, (_, i) => `o${i}`).join('\n');
	const next = Array.from({length: 100}, (_, i) => `n${i}`).join('\n');
	const p = diffLines(old, next, {maxRows: 10});
	assert.equal(p.rows.length, 11);
	assert.equal(p.truncated, true);
	assert.equal(p.rows[10]?.kind, 'meta');
	assert.equal(p.added, 100);
});

test('over the line cap gives the approximate summary', () => {
	const old = Array.from({length: 20_000}, () => 'same').join('\n');
	const next = `${old}\nextra`.replace('same', 'diff');
	const start = Date.now();
	const p = diffLines(old, next);
	assert.ok(Date.now() - start < 500);
	assert.equal(p.approximate, true);
	assert.equal(p.truncated, true);
	assert.equal(p.rows[0]?.kind, 'meta');
	assert.match(p.rows[0]?.text ?? '', /^\+\d+ -\d+ lines \(too large to diff in detail\)$/);
});

test('over the char cap gives the summary', () => {
	const p = diffLines('a'.repeat(300_000), 'b');
	assert.equal(p.approximate, true);
	assert.match(p.rows[0]?.text ?? '', /too large/);
});

test('alternating pattern hits the edit-distance cap in bounded time', () => {
	const n = 4000;
	const a = Array.from({length: n}, (_, i) => (i % 2 ? 'x' : `a${i}`)).join('\n');
	const b = Array.from({length: n}, (_, i) => (i % 2 ? `b${i}` : 'y')).join('\n');
	const start = Date.now();
	const p = diffLines(a, b);
	assert.ok(Date.now() - start < 500);
	assert.equal(p.approximate, true);
	assert.match(p.rows[0]?.text ?? '', /too large/);
});

test('small edit distance under the cap is exact', () => {
	const lines = Array.from({length: 4000}, (_, i) => `line ${i}`);
	const next = [...lines];
	next[10] = 'changed';
	next[3000] = 'changed too';
	const p = diffLines(lines.join('\n'), next.join('\n'));
	assert.equal(p.approximate, false);
	assert.equal(p.added, 2);
	assert.equal(p.removed, 2);
});

test('1 MiB strings do not throw or hang', () => {
	const big = 'x'.repeat(1024 * 1024);
	const start = Date.now();
	assert.equal(diffLines(big, `${big}y`).approximate, true);
	assert.ok(Date.now() - start < 500);
});

test('locateEdit: zero, one and many matches', () => {
	const text = 'a\nfoo\nb\nfoo\nc';
	assert.deepEqual(locateEdit(text, 'zzz', 'q', false), {
		lines: [],
		warnings: ['old_string not found in the current file'],
	});
	assert.deepEqual(locateEdit(text, 'b', 'q', false), {lines: [3], warnings: []});
	assert.deepEqual(locateEdit(text, 'foo', 'q', false), {
		lines: [2, 4],
		warnings: ['matches 2 places; Edit will fail unless unique'],
	});
	assert.deepEqual(locateEdit(text, 'foo', 'q', true), {lines: [2, 4], warnings: []});
	assert.deepEqual(locateEdit(text, 'o\nb', 'q', false), {lines: [2], warnings: []});
});

test('locateEdit never throws', () => {
	assert.deepEqual(locateEdit('abc', '', 'x', false).lines, []);
	assert.deepEqual(locateEdit(undefined as unknown as string, 'a', 'x', false).lines, []);
	const many = locateEdit('a'.repeat(5000), 'a', 'b', true);
	assert.equal(many.lines.length, 1000);
});

test('previewNewFile', () => {
	const p = previewNewFile('a\nb\n');
	assert.deepEqual(p.rows, [
		{kind: 'add', text: 'a', no: 1},
		{kind: 'add', text: 'b', no: 2},
		{kind: 'meta', text: '2 lines, 4 bytes'},
	]);
	assert.equal(p.added, 2);
	const big = previewNewFile(Array.from({length: 100}, () => 'l').join('\n'));
	assert.equal(big.truncated, true);
	assert.equal(big.added, 100);
	assert.ok(big.rows.length < 50);
	assert.deepEqual(previewNewFile('').rows, [{kind: 'meta', text: '0 lines, 0 bytes'}]);
});
