import assert from 'node:assert/strict';
import {test} from 'node:test';
import {matchCommands, parseSlash, slashQuery} from '../../src/ui/slash.js';
import {commandHost} from '../../src/ui/view-commands.js';

test('"/x" is a console command, "//x" a literal message, the rest is not a slash line', () => {
	assert.deepEqual(parseSlash('/project list'), {kind: 'command', line: 'project list'});
	assert.deepEqual(parseSlash('//compact'), {kind: 'literal', text: '/compact'});
	assert.equal(parseSlash('/'), undefined);
	assert.equal(parseSlash('/a\nb'), undefined);
	assert.equal(parseSlash('hello /x'), undefined);
});

test('hints: prefix matches first, only while the bare "/name" is typed at the end', () => {
	const cmds = [{name: 'settings', description: ''}, {name: 'test', description: ''}, {name: 'dev', description: ''}];
	assert.deepEqual(matchCommands(cmds, 'te', 5).map(c => c.name), ['test']);
	assert.deepEqual(matchCommands(cmds, 'e', 5).map(c => c.name), ['settings', 'test', 'dev']);
	assert.deepEqual(matchCommands(cmds, '', 2).map(c => c.name), ['settings', 'test']);
	assert.equal(slashQuery('/pro', 4), 'pro');
	assert.equal(slashQuery('/pro', 2), undefined);
	assert.equal(slashQuery('/project ', 9), undefined);
	assert.equal(slashQuery('//x', 3), undefined);
	assert.equal(slashQuery('pro', 3), undefined);
});

test('commandHost feature-detects the host and never throws', () => {
	assert.equal(commandHost(undefined), undefined);
	assert.equal(commandHost({runLine: () => true}), undefined);
	const h = commandHost({runLine: () => {
		throw new Error('x');
	}, listCommands: () => [{name: 'a', description: 'b'}, {nope: 1}, null]})!;
	assert.equal(h.runLine('a'), false);
	assert.deepEqual(h.listCommands(), [{name: 'a', description: 'b'}]);
	assert.deepEqual(commandHost({runLine: () => 'yes', listCommands: () => 'x'})!.listCommands(), []);
	assert.equal(commandHost({runLine: () => 'yes', listCommands: () => []})!.runLine('a'), false);
});
