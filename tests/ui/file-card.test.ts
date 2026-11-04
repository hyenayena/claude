import '../helpers/sgr16.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {
	FILE_CARD_ROWS,
	FILE_CARD_TAIL,
	WRITE_HEAD_LINES,
	fileCardOf,
	formatFileCard,
	patchRows,
	previewCardRows,
} from '../../src/ui/file-card.js';
import {preloadHighlighter, resetHighlighterForTests} from '../../src/ui/highlight.js';

const scrub = (s: string) => s.split('SECRET').join('[redacted]');
const plainCard = (t: Parameters<typeof formatFileCard>[0], width = 80, full = false, depth: ColorDepth = 'none') =>
	withColorDepth(depth, () => stripStyles(formatFileCard(t, scrub, width, {full})));

test('patchRows numbers both sides and counts gaps from the hunk starts', () => {
	const {rows, added, removed} = patchRows({
		hunks: [
			{oldStart: 10, newStart: 12, lines: [' a', '-b', '-c', '+d', '\\ No newline at end of file', ' e\r']},
			{oldStart: 40, newStart: 41, lines: ['+f']},
		],
	});
	assert.deepEqual(rows, [
		{kind: 'ctx', text: 'a', oldNo: 10, newNo: 12},
		{kind: 'del', text: 'b', oldNo: 11},
		{kind: 'del', text: 'c', oldNo: 12},
		{kind: 'add', text: 'd', newNo: 13},
		{kind: 'ctx', text: 'e', oldNo: 13, newNo: 14},
		{kind: 'fold', count: 26},
		{kind: 'add', text: 'f', newNo: 41},
	]);
	assert.equal(added, 2);
	assert.equal(removed, 2);
});

test('an Edit without a patch falls back to the strings, without line numbers', () => {
	const card = fileCardOf({name: 'Edit', input: {file_path: '/a.ts', old_string: 'a', new_string: 'b\nc'}, isError: false})!;
	assert.equal(card.added, 2);
	assert.equal(card.removed, 1);
	assert.deepEqual(card.rows.map(r => r.kind), ['del', 'add', 'add']);
	assert.ok(card.rows.every(r => !('oldNo' in r) && !('newNo' in r)));
	const empty = fileCardOf({name: 'Edit', input: {file_path: '/a.ts', old_string: 'a', new_string: 'b'}, isError: false, patch: {hunks: []}})!;
	assert.deepEqual(empty.rows.map(r => r.kind), ['del', 'add']);
});

test('MultiEdit joins the edits with fold rows; NotebookEdit shows the new source as plain rows', () => {
	const multi = fileCardOf({name: 'MultiEdit', input: {file_path: '/a.ts', edits: [{old_string: 'a', new_string: 'b'}, {old_string: 'c', new_string: 'd'}]}, isError: false})!;
	assert.deepEqual(multi.rows.map(r => r.kind), ['del', 'add', 'fold', 'del', 'add']);
	assert.equal(multi.added, 2);
	const nb = fileCardOf({name: 'NotebookEdit', input: {notebook_path: '/n.ipynb', new_source: 'x = 1\ny = 2', cell_type: 'code'}, isError: false})!;
	assert.equal(nb.path, '/n.ipynb');
	assert.equal(nb.plain, true);
	assert.equal(nb.created, undefined);
	assert.deepEqual(nb.rows, [{kind: 'add', text: 'x = 1', newNo: 1}, {kind: 'add', text: 'y = 2', newNo: 2}]);
	const del = fileCardOf({name: 'NotebookEdit', input: {notebook_path: '/n.ipynb', edit_mode: 'delete'}, isError: false})!;
	assert.deepEqual(del.rows, [{kind: 'note', text: 'cell deleted'}]);
});

test('Write: create head, overwrite diff, same content; other tools and missing paths give no card', () => {
	const content = Array.from({length: 13}, (_, i) => `l${i + 1}`).join('\n');
	const created = fileCardOf({name: 'Write', input: {file_path: '/n.ts', content}, isError: false})!;
	assert.equal(created.created, true);
	assert.equal(created.added, 13);
	assert.equal(created.rows.length, WRITE_HEAD_LINES + 1);
	assert.deepEqual(created.rows.at(-1), {kind: 'note', text: '… +3 lines (ctrl+o to expand)'});
	const all = fileCardOf({name: 'Write', input: {file_path: '/n.ts', content}, isError: false}, {full: true})!;
	assert.equal(all.rows.length, 13);
	assert.ok(all.rows.every(r => r.kind === 'add'));
	const over = fileCardOf({name: 'Write', input: {file_path: '/n.ts', content: 'c'}, isError: false, patch: {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+c']}]}})!;
	assert.equal(over.created, undefined);
	assert.deepEqual(over.rows.map(r => r.kind), ['del', 'add']);
	const same = fileCardOf({name: 'Write', input: {file_path: '/n.ts', content: 'c'}, isError: false, patch: {hunks: []}})!;
	assert.deepEqual(same.rows, []);
	assert.equal(fileCardOf({name: 'Bash', input: {command: 'ls'}, isError: false}), undefined);
	assert.equal(fileCardOf({name: 'Edit', input: {}, isError: false}), undefined);
	assert.equal(formatFileCard({name: 'Edit', input: {}, isError: false}, scrub), '');
});

test('the chat card caps a long change at 40 rows with the last 8 kept, the full card does not', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: Array.from({length: 100}, (_, i) => `+l${i}`)}]};
	const t = {name: 'Edit', input: {file_path: '/a.ts'}, isError: false, patch};
	const rows = plainCard(t).split('\n');
	assert.equal(rows.length, 1 + FILE_CARD_ROWS);
	assert.match(rows[FILE_CARD_ROWS - FILE_CARD_TAIL]!, /… \+61 lines \(ctrl\+o to expand\)$/);
	assert.match(rows.at(-1)!, /l99$/);
	assert.equal(plainCard(t, 80, true).split('\n').length, 101);
});

test('rows never reach the width, at all depths and at the side-by-side threshold', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: [' keep', `-${'old '.repeat(60)}`, `+${'new '.repeat(60)}`, ' end']}]};
	const t = {name: 'Edit', input: {file_path: `/${'dir/'.repeat(12)}file.ts`}, isError: false, patch};
	for (const width of [20, 39, 79, 158, 159, 200]) {
		for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
			const out = withColorDepth(depth, () => formatFileCard(t, scrub, width));
			for (const row of out.split('\n')) assert.ok(styledCells(row) <= width, `${width} ${depth}`);
		}
	}
	assert.ok(plainCard(t, 159).split('\n').some(r => r.split('│').length === 3));
	assert.ok(plainCard(t, 158).split('\n').every(r => r.split('│').length <= 2));
});

test('layout is cached per width and the lines are scrubbed with the given scrub', () => {
	const t = {name: 'Edit', input: {file_path: '/a.ts'}, isError: false, patch: {hunks: [{oldStart: 1, newStart: 1, lines: ['-SECRET', '+ok']}]}};
	const a = withColorDepth('none', () => formatFileCard(t, scrub, 60));
	assert.ok(!a.includes('SECRET'));
	assert.ok(a.includes('[redacted]'));
	assert.equal(withColorDepth('none', () => formatFileCard(t, scrub, 60)), a);
	assert.notEqual(withColorDepth('none', () => formatFileCard(t, scrub, 30)), a);
});

test('the highlighter runs once per card across widths, and again once it became ready', async () => {
	resetHighlighterForTests();
	const t = {name: 'Edit', input: {file_path: '/a.ts'}, isError: false, patch: {hunks: [{oldStart: 1, newStart: 1, lines: ['-const a = 1;', '+const a = "two";']}]}};
	const first = withColorDepth('truecolor', () => formatFileCard(t, scrub, 80));
	assert.ok(!first.includes('38;2;198;120;221'));
	await preloadHighlighter();
	const second = withColorDepth('truecolor', () => formatFileCard(t, scrub, 80));
	assert.ok(second.includes('38;2;198;120;221'), 'keyword colour');
	assert.ok(second.includes('38;2;152;195;121'), 'string colour');
	for (const width of [30, 50, 80, 120, 80]) {
		const out = withColorDepth('truecolor', () => formatFileCard(t, scrub, width));
		assert.ok(out.includes('38;2;198;120;221'));
	}
});

test('previewCardRows draws the prompt preview without header and rule, within the width', () => {
	const preview = {
		rows: [
			{kind: 'gap' as const, text: '... 5 unchanged lines', count: 5},
			{kind: 'ctx' as const, text: 'keep', no: 6, oldNo: 6, newNo: 6},
			{kind: 'del' as const, text: 'old', no: 7},
			{kind: 'add' as const, text: 'new', no: 7},
			{kind: 'meta' as const, text: '+1 -1'},
		],
		added: 1,
		removed: 1,
		truncated: false,
		approximate: false,
	};
	for (const width of [20, 40, 100, 200]) {
		const rows = withColorDepth('none', () => previewCardRows(preview, '/a.ts', scrub, width));
		for (const r of rows) assert.ok(styledCells(r) <= width, `${width}`);
	}
	const rows = withColorDepth('none', () => previewCardRows(preview, '/a.ts', scrub, 80)).map(stripStyles);
	assert.equal(rows[0], '⋯ 5 unchanged lines');
	assert.match(rows[2]!, /^7 +- old/);
	assert.match(rows[3]!, /^ +7 \+ new/);
	assert.equal(rows[4], '+1 -1');
	const created = withColorDepth('none', () => previewCardRows({...preview, rows: [{kind: 'add', text: 'x', no: 1}], removed: 0}, '/n.ts', scrub, 80)).map(stripStyles);
	assert.deepEqual(created, ['1 x']);
});
