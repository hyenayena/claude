import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatToolBlock, todoLines, toolHeader} from '../../src/ui/present.js';
import {initialTranscript, parseTodos, reduceTranscript} from '../../src/ui/transcript.js';

const id = (s: string) => s;
const plain = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');

const todos = [
	{content: 'Plan', status: 'completed', activeForm: 'Planning'},
	{content: 'Write code', status: 'in_progress', activeForm: 'Writing code'},
	{content: 'Test', status: 'pending'},
	{content: '', status: 'pending'},
	{status: 'pending'},
];

test('parseTodos keeps well-formed items and defaults unknown statuses to pending', () => {
	assert.deepEqual(parseTodos({todos}), [
		{content: 'Plan', status: 'completed', activeForm: 'Planning'},
		{content: 'Write code', status: 'in_progress', activeForm: 'Writing code'},
		{content: 'Test', status: 'pending'},
	]);
	assert.deepEqual(parseTodos({todos: [{content: 'x', status: 'weird'}]}), [{content: 'x', status: 'pending'}]);
	assert.deepEqual(parseTodos(null), []);
});

test('a TodoWrite call becomes the checklist; it is shown while something is open', () => {
	let s = initialTranscript();
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'tool-use', toolUseId: 't1', name: 'TodoWrite', input: {todos}}}).state;
	assert.deepEqual(todoLines(s.todos, id, 10).map(plain), ['  ⎿  ☒ Plan', '     ☐ Writing code', '     ☐ Test']);
	const done = parseTodos({todos: [{content: 'a', status: 'completed'}]});
	assert.deepEqual(todoLines(done, id, 10), []);
	assert.deepEqual(todoLines(s.todos, id, 0), []);
});

test('a long checklist keeps the current item and counts the rest', () => {
	const many = parseTodos({
		todos: Array.from({length: 10}, (_v, i) => ({content: `item ${i}`, status: i < 6 ? 'completed' : i === 6 ? 'in_progress' : 'pending'})),
	});
	const lines = todoLines(many, id, 4).map(plain);
	assert.equal(lines.length, 4);
	assert.ok(lines.some(l => l.trimStart().replace(/^⎿\s+/, '').startsWith('☐ item 6')));
	assert.match(lines.at(-1)!, /^ {5}… \+7 more$/);
});

test('the TodoWrite tool block is one short line', () => {
	assert.equal(toolHeader('TodoWrite', {todos}, id), 'TodoWrite(3 items)');
	const block = plain(formatToolBlock({name: 'TodoWrite', input: {todos}, isError: false, text: 'Todos have been modified'}, id));
	assert.match(block, /checklist: 1\/3 done/);
});
