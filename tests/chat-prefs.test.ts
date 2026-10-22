import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Logger} from '../../../src/api.js';
import {chatSettings, livePatch, withPatch} from '../src/chat-prefs.js';
import type {ClaudeState} from '../src/types.js';

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

test('the keep-working setting defaults to Off, stores only on, and tells the open chat', async () => {
	const state: ClaudeState = {};
	const applied: boolean[] = [];
	const logged: Array<Record<string, unknown> | undefined> = [];
	const log = {error() {}, warn() {}, info: (_m: string, f?: Record<string, unknown>) => void logged.push(f), debug() {}, child: () => log, addRedactor() {}} as unknown as Logger;
	const store = {read: async () => ({...state}), update: async (p: Partial<ClaudeState>) => void Object.assign(state, p)};
	const setting = chatSettings(store, () => true, log, {applyKeep: k => applied.push(k)}).find(s => s.key === 'chatKeepRunning')!;
	assert.equal(setting.label, 'Keep working after exit');
	assert.deepEqual(setting.options.map(o => o.value), ['', 'on']);
	assert.equal(await setting.get(), '');
	await setting.set('on');
	assert.equal(state.chatKeepRunning, 'on');
	assert.equal(await setting.get(), 'on');
	await setting.set('');
	assert.equal(await setting.get(), '');
	assert.deepEqual(applied, [true, false]);
	await assert.rejects(async () => setting.set('maybe'));
	assert.deepEqual(applied, [true, false]);
	assert.ok(logged.some(f => f?.key === 'chatKeepRunning' && f.value === 'on'));
});
