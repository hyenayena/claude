import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ToolPatch} from '../../src/chat/events.js';
import {fileChange, MAX_TURN_FILES, MAX_TURN_TOOL_IDS, TurnStats} from '../../src/chat/turn-stats.js';
import {fileCardOf} from '../../src/ui/file-card.js';

const hunk = (lines: string[]): ToolPatch => ({hunks: [{oldStart: 1, newStart: 1, lines}]});

const cases: {name: string; input: unknown; patch?: ToolPatch}[] = [
	{name: 'Edit', input: {file_path: '/p/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd'}},
	{name: 'Edit', input: {file_path: '/p/a.ts', old_string: 'a', new_string: 'b'}, patch: hunk([' x', '-a', '+b', '+c'])},
	{name: 'MultiEdit', input: {file_path: '/p/a.ts', edits: [{old_string: 'a', new_string: 'b\nc'}, {old_string: 'x\ny', new_string: 'z'}]}},
	{name: 'Write', input: {file_path: '/p/n.ts', content: 'one\ntwo\n'}, patch: {hunks: [], created: true}},
	{name: 'Write', input: {file_path: '/p/n.ts', content: 'one\ntwo\nthree'}},
	{name: 'Write', input: {file_path: '/p/n.ts', content: 'x'}, patch: hunk(['-a', '-b', '+c'])},
	{name: 'Write', input: {file_path: '/p/n.ts', content: 'x'}, patch: {hunks: []}},
	{name: 'NotebookEdit', input: {notebook_path: '/p/n.ipynb', new_source: 'a\nb'}},
	{name: 'NotebookEdit', input: {notebook_path: '/p/n.ipynb', edit_mode: 'delete'}},
];

test('the counts equal the ones of the file card', () => {
	for (const c of cases) {
		const card = fileCardOf({name: c.name, input: c.input, isError: false, ...(c.patch && {patch: c.patch})})!;
		const change = fileChange(c.name, c.input, c.patch)!;
		assert.deepEqual([change.added, change.removed], [card.added, card.removed], JSON.stringify(c));
	}
});

test('other tools and inputs without a path are not file changes', () => {
	assert.equal(fileChange('Bash', {command: 'ls'}), undefined);
	assert.equal(fileChange('Edit', {old_string: 'a'}), undefined);
	assert.equal(fileChange('Edit', null), undefined);
});

test('tools are counted once per id, a changed file only on a successful result, per path aggregated', () => {
	const s = new TurnStats();
	s.use('1', 'Edit', {file_path: '/p/a.ts', old_string: 'a', new_string: 'b'});
	s.use('1', 'Edit', {file_path: '/p/a.ts', old_string: 'a', new_string: 'b'});
	s.use('2', 'Edit', {file_path: '/p/a.ts', old_string: 'x', new_string: 'y\nz'});
	s.use('3', 'Write', {file_path: '/p/bad.ts', content: 'q'});
	s.use('4', 'Bash', {command: 'ls'});
	s.result('1', false);
	s.result('2', false);
	s.result('3', true);
	s.result('4', false);
	const sum = s.finish(1234.6, 99.4);
	assert.equal(sum.tools, 4);
	assert.deepEqual(sum.files, [{path: '/p/a.ts', added: 3, removed: 2}]);
	assert.deepEqual([sum.filesTotal, sum.added, sum.removed, sum.durationMs, sum.outputTokens], [1, 3, 2, 1235, 99]);
});

test('a result without a known call is ignored', () => {
	const s = new TurnStats();
	s.result('nope', false);
	assert.equal(s.finish(0, 0).filesTotal, 0);
});

test('the caps: tool ids, listed files and numbers', () => {
	const s = new TurnStats();
	for (let i = 0; i < MAX_TURN_TOOL_IDS + 10; i++) s.use(`t${i}`, 'Bash', {});
	assert.equal(s.finish(0, 0).tools, MAX_TURN_TOOL_IDS);
	const f = new TurnStats();
	for (let i = 0; i < MAX_TURN_FILES + 5; i++) {
		f.use(`f${i}`, 'Write', {file_path: `/p/${i}.ts`, content: 'a'});
		f.result(`f${i}`, false);
	}
	const sum = f.finish(10 ** 12, 10 ** 12);
	assert.equal(sum.files.length, MAX_TURN_FILES);
	assert.equal(sum.filesTotal, MAX_TURN_FILES + 5);
	assert.equal(sum.added, MAX_TURN_FILES + 5);
	assert.ok(sum.durationMs <= 604_800_000 && sum.outputTokens <= 1_000_000_000);
	assert.equal(fileChange('Write', {file_path: 'x'.repeat(5000), content: ''})!.path.length, 1024);
});

test('control characters in a path become ? so the summary frame stays small', () => {
	const c = fileChange('Write', {file_path: `/w/${String.fromCharCode(1).repeat(5)}x${String.fromCharCode(0x9b)}.ts`, content: 'a'});
	assert.equal(c?.path, '/w/?????x?.ts');
});
