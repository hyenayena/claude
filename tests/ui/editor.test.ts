import assert from 'node:assert/strict';
import {test} from 'node:test';
import {editorReduce, emptyEditor, MAX_INPUT, type EditorState} from '../../src/ui/editor.js';

const ins = (s: EditorState, text: string) => editorReduce(s, {type: 'insert', text});

test('insert and cursor movement', () => {
	let s = ins(emptyEditor, 'abc');
	assert.deepEqual([s.text, s.cursor], ['abc', 3]);
	s = editorReduce(s, {type: 'left'});
	s = ins(s, 'X');
	assert.deepEqual([s.text, s.cursor], ['abXc', 3]);
});

test('backspace and delete respect bounds', () => {
	let s = ins(emptyEditor, 'ab');
	s = editorReduce(s, {type: 'backspace'});
	assert.equal(s.text, 'a');
	assert.equal(editorReduce(emptyEditor, {type: 'backspace'}), emptyEditor);
	s = editorReduce(s, {type: 'left'});
	s = editorReduce(s, {type: 'delete'});
	assert.equal(s.text, '');
	assert.equal(editorReduce(s, {type: 'delete'}), s);
});

test('home, end and kill work on the current line', () => {
	let s = ins(emptyEditor, 'one\ntwo');
	s = editorReduce(s, {type: 'home'});
	assert.equal(s.cursor, 4);
	s = editorReduce(s, {type: 'end'});
	assert.equal(s.cursor, 7);
	s = editorReduce(s, {type: 'killLine'});
	assert.equal(s.text, 'one\n');
	s = editorReduce(s, {type: 'home'});
	assert.equal(s.cursor, 4);
	s = editorReduce(s, {type: 'left'});
	s = editorReduce(s, {type: 'end'});
	assert.equal(s.cursor, 3);
});

test('insert normalizes CRLF and CR to newline', () => {
	const s = ins(emptyEditor, 'a\r\nb\rc');
	assert.equal(s.text, 'a\nb\nc');
});

test('cap at MAX_INPUT sets truncated', () => {
	const s = ins(emptyEditor, 'x'.repeat(MAX_INPUT + 10));
	assert.equal(s.text.length, MAX_INPUT);
	assert.equal(s.truncated, true);
	const t = ins(s, 'y');
	assert.equal(t.text.length, MAX_INPUT);
	assert.equal(t.truncated, true);
});
