import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clampChars, summarizeArgs} from '../../src/chat/truncate.js';

test('clampChars adds a footer only when over the cap', () => {
	assert.equal(clampChars('abc', 5), 'abc');
	assert.equal(clampChars('abcdefg', 5), 'abcde… [truncated 2 chars]');
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

test('summarizeArgs honours a custom cap', () => {
	assert.equal(summarizeArgs('Read', {file_path: 'p'.repeat(300)}, 500).length, 300);
});
