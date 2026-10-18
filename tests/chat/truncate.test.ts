import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clampChars, clampLines, summarizeArgs, summarizeResult, tailRows} from '../../src/chat/truncate.js';

test('clampChars adds a footer only when over the cap', () => {
	assert.equal(clampChars('abc', 5), 'abc');
	assert.equal(clampChars('abcdefg', 5), 'abcde… [truncated 2 chars]');
});

test('clampLines limits lines and line length', () => {
	assert.equal(clampLines('a\nb', 3, 10), 'a\nb');
	assert.equal(clampLines('a\nb\nc\nd\ne', 3, 10), 'a\nb\nc\n… +2 more lines');
	assert.equal(clampLines('x'.repeat(30), 3, 10), `${'x'.repeat(10)}…`);
});

test('summarizeResult shows 3 lines of at most 200 chars', () => {
	const out = summarizeResult(`${'y'.repeat(500)}\n2\n3\n4\n5`);
	const lines = out.split('\n');
	assert.equal(lines.length, 4);
	assert.equal(lines[0]?.length, 201);
	assert.equal(lines[3], '… +2 more lines');
});

test('summarizeResult only processes the first 64 KiB', () => {
	const out = summarizeResult('z\n'.repeat(100_000));
	assert.match(out, /more lines/);
	const n = Number(/\+(\d+) more/.exec(out)?.[1]);
	assert.ok(n < 40_000);
});

test('summarizeArgs per tool', () => {
	assert.equal(summarizeArgs('Read', {file_path: '/a/b', offset: 3, limit: 5}), '/a/b offset=3 limit=5');
	assert.equal(summarizeArgs('Grep', {pattern: 'foo', path: 'src', glob: '*.ts'}), 'foo path=src glob=*.ts');
	assert.equal(summarizeArgs('Glob', {pattern: '**/*.ts'}), '**/*.ts');
	assert.equal(summarizeArgs('Bash', {command: 'rm -rf /', timeout: 1}), 'command, timeout');
	assert.equal(summarizeArgs('Read', 'bogus'), '');
});

test('summarizeArgs caps at 100 chars', () => {
	assert.equal(summarizeArgs('Read', {file_path: 'p'.repeat(300)}).length, 100);
});

test('tailRows returns the last rows with approximate wrapping', () => {
	assert.deepEqual(tailRows('a\nb\nc', 2, 10), ['b', 'c']);
	assert.deepEqual(tailRows('abcdefghij', 2, 4), ['efgh', 'ij']);
	assert.deepEqual(tailRows('', 3, 10), ['']);
});

test('tailRows cuts a very long live line at whitespace', () => {
	const rows = tailRows(`${'w'.repeat(50)} ${'v'.repeat(30)}`, 5, 10);
	assert.ok(rows.join('').length <= 40);
});

test('summarizeArgs honours a custom cap', () => {
	assert.equal(summarizeArgs('Read', {file_path: 'p'.repeat(300)}, 500).length, 300);
});
