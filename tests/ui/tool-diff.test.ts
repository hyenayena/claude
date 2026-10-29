import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editRows, patchRows, WRITE_HEAD_LINES, writeRows} from '../../src/ui/tool-diff.js';

test('patch rows number removed lines from oldStart and the others from newStart', () => {
	const {rows, added, removed} = patchRows({
		hunks: [
			{oldStart: 10, newStart: 12, lines: [' a', '-b', '-c', '+d', '\\ No newline at end of file', ' e\r']},
			{oldStart: 40, newStart: 41, lines: ['+f']},
		],
	});
	assert.deepEqual(rows, [
		{kind: 'ctx', text: 'a', no: 12},
		{kind: 'del', text: 'b', no: 11},
		{kind: 'del', text: 'c', no: 12},
		{kind: 'add', text: 'd', no: 13},
		{kind: 'ctx', text: 'e', no: 14},
		{kind: 'gap', text: ''},
		{kind: 'add', text: 'f', no: 41},
	]);
	assert.equal(added, 2);
	assert.equal(removed, 2);
});

test('an Edit without a patch falls back to a diff of its strings without line numbers', () => {
	const r = editRows({old_string: 'a', new_string: 'b\nc'});
	assert.equal(r.added, 2);
	assert.equal(r.removed, 1);
	assert.ok(r.rows.length > 0);
	assert.ok(r.rows.every(row => row.no === undefined));
	assert.deepEqual(editRows({old_string: 'a', new_string: 'b'}, {hunks: []}).rows.map(x => x.kind), ['del', 'add']);
});

test('a Write shows the head of a new file, the diff of an overwrite, nothing for an empty patch', () => {
	const content = Array.from({length: 15}, (_, i) => `l${i + 1}`).join('\n') + '\n';
	for (const patch of [undefined, {hunks: [], created: true as const}]) {
		const w = writeRows({content}, patch);
		assert.equal(w.mode, 'head');
		assert.equal(w.total, 15);
		assert.equal(w.rows.length, WRITE_HEAD_LINES);
		assert.deepEqual(w.rows[0], {kind: 'add', text: 'l1', no: 1});
		assert.deepEqual(w.rows[9], {kind: 'add', text: 'l10', no: 10});
	}
	const diff = writeRows({content: 'x'}, {hunks: [{oldStart: 1, newStart: 1, lines: ['-y', '+x']}]});
	assert.equal(diff.mode, 'diff');
	assert.equal(diff.added, 1);
	assert.equal(diff.removed, 1);
	const none = writeRows({content: 'x'}, {hunks: []});
	assert.equal(none.mode, 'none');
	assert.deepEqual(none.rows, []);
});
