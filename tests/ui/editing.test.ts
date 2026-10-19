import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editorReduce, emptyEditor, type EditorAction, type EditorState} from '../../src/ui/editor.js';
import {vimKey, vimStart, type VimState} from '../../src/ui/vim.js';
import {matchFiles, mentionAt} from '../../src/chat/files.js';

const run = (text: string, cursor: number, ...actions: EditorAction[]): EditorState =>
	actions.reduce((s, a) => editorReduce(s, a), {...emptyEditor, text, cursor} as EditorState);

test('kill, yank and word motions', () => {
	let s = run('git commit -m msg', 17, {type: 'killWordBack'});
	assert.equal(s.text, 'git commit -m ');
	assert.equal(s.killed, 'msg');
	s = editorReduce(s, {type: 'yank'});
	assert.equal(s.text, 'git commit -m msg');
	s = run('one two three', 4, {type: 'killEnd'});
	assert.deepEqual([s.text, s.killed], ['one ', 'two three']);
	s = run('one two three', 0, {type: 'wordRight'}, {type: 'wordRight'});
	assert.equal(s.cursor, 7);
	s = editorReduce(s, {type: 'wordLeft'});
	assert.equal(s.cursor, 4);
	s = run('one two', 0, {type: 'killWordForward'}, {type: 'backspace'}, {type: 'right'});
	assert.equal(s.killed, 'one', 'the kill ring survives other edits');
	assert.deepEqual(run('abc', 1, {type: 'set', text: 'xy'}), {text: 'xy', cursor: 2, truncated: false});
});

const press = (state: VimState, ...keys: Array<string | {escape?: true; return?: true}>) => {
	const effects = [];
	let s = state;
	for (const k of keys) {
		const r = vimKey(s, typeof k === 'string' ? {input: k} : {input: '', ...k});
		s = r.state;
		effects.push(r.effect);
	}
	return {state: s, effects};
};

test('vim: Esc goes to NORMAL, i/a/A/o back to INSERT; operators and motions map to edits', () => {
	assert.equal(vimKey(vimStart, {input: 'x'}).handled, false, 'INSERT types normally');
	let r = press(vimStart, {escape: true});
	assert.equal(r.state.mode, 'normal');
	assert.deepEqual(press(r.state, 'd', 'w').effects.at(-1), {kind: 'edit', actions: [{type: 'killToNextWord'}]});
	assert.equal(run('one two', 0, {type: 'killToNextWord'}).text, 'two');
	assert.deepEqual(press(r.state, 'd', 'd').effects.at(-1), {kind: 'edit', actions: [{type: 'home'}, {type: 'killEnd'}]});
	const cw = press(r.state, 'c', 'w');
	assert.equal(cw.state.mode, 'insert');
	assert.deepEqual(press(r.state, 'y', 'y').effects.at(-1), {kind: 'edit', actions: [{type: 'home'}, {type: 'killEnd'}, {type: 'yank'}]});
	assert.deepEqual(press(r.state, 'u').effects[0], {kind: 'undo'});
	assert.deepEqual(press(r.state, 'k').effects[0], {kind: 'history', step: -1});
	assert.deepEqual(press(r.state, {return: true}).effects[0], {kind: 'submit'});
	assert.deepEqual(press(r.state, {escape: true}).effects[0], {kind: 'escape'});
	assert.equal(press(r.state, 'A').state.mode, 'insert');
	r = press(r.state, ':');
	assert.equal(r.state.mode, 'insert');
	assert.deepEqual(r.effects[0], {kind: 'edit', actions: [{type: 'insert', text: ':'}]});
	assert.equal(press(press(vimStart, {escape: true}).state, 'd', {escape: true}).effects.at(-1)!.kind, 'none', 'Esc cancels a pending operator');
});

test('@ mentions: token at the cursor and ranked file matches', () => {
	assert.deepEqual(mentionAt('read @src/ap', 12), {start: 5, query: 'src/ap'});
	assert.equal(mentionAt('mail me@x', 9), undefined);
	assert.equal(mentionAt('no mention', 10), undefined);
	const files = ['src/app.tsx', 'tests/app.test.tsx', 'README.md', 'src/api.ts', 'docs/apple.md'];
	assert.deepEqual(matchFiles(files, 'app', 3), ['src/app.tsx', 'docs/apple.md', 'tests/app.test.tsx']);
	assert.deepEqual(matchFiles(files, 'src/', 6), ['src/api.ts', 'src/app.tsx']);
	assert.deepEqual(matchFiles(files, 'zzz'), []);
});
