import assert from 'node:assert/strict';
import {test} from 'node:test';
import {livePatch, withPatch} from '../src/chat-prefs.js';

test('livePatch maps settings values to live changes', () => {
	assert.deepEqual(livePatch('chatModel', 'opus'), {model: 'opus'});
	assert.deepEqual(livePatch('chatModel', ''), {model: null});
	assert.deepEqual(livePatch('chatEffort', 'max'), {effort: 'max'});
	assert.deepEqual(livePatch('chatEffort', ''), {effort: null});
	assert.deepEqual(livePatch('chatThinking', 'disabled'), {thinking: 'disabled'});
	assert.deepEqual(livePatch('chatFastMode', ''), {fastMode: false});
	assert.deepEqual(livePatch('chatOutputStyle', 'Learning'), {outputStyle: 'Learning'});
	assert.equal(livePatch('chatPermissionMode', 'auto'), undefined);
});

test('withPatch keeps the next query in step with live changes', () => {
	let cur = withPatch({model: 'opus', tuning: {effort: 'low'}}, {model: 'haiku', effort: 'high', fastMode: true});
	assert.deepEqual(cur, {model: 'haiku', tuning: {effort: 'high', fastMode: true}});
	cur = withPatch(cur, {model: null, effort: null, fastMode: false, thinking: 'disabled', outputStyle: 'Explanatory'});
	assert.deepEqual(cur, {tuning: {thinking: 'disabled', outputStyle: 'Explanatory'}});
});
