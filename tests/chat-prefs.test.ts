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

test('router, classifier and tier settings store only what they mean and show the tier defaults', async () => {
	const state: ClaudeState = {};
	const log = {error() {}, warn() {}, info() {}, debug() {}, child: () => log, addRedactor() {}} as unknown as Logger;
	const store = {read: async () => ({...state}), update: async (p: Partial<ClaudeState>) => void Object.assign(state, p)};
	const live: unknown[] = [];
	const settings = chatSettings(store, () => true, log, {applyLive: p => live.push(p)});
	const by = (k: string) => settings.find(s => s.key === k)!;
	const keys = settings.map(s => s.key);
	assert.deepEqual(keys.slice(0, 4), ['chatPermissionMode', 'chatRouter', 'chatClassifier', 'tierLightModel']);
	assert.equal(by('chatRouter').label, 'Model router');
	assert.match(by('chatRouter').description!, /^Picks the model of the chat and its agents by tier/);
	assert.match(by('chatClassifier').description!, /only with the model router on/);
	assert.match(by('chatModel').description!, /used when the model router is off or the chat is not routed/);
	assert.match(by('chatEffort').description!, /used when the model router is off or the chat is not routed/);
	assert.equal(await by('chatRouter').get(), '');
	assert.equal(await by('chatClassifier').get(), '');
	await by('chatRouter').set('on');
	await by('chatClassifier').set('off');
	assert.deepEqual(state, {chatRouter: 'on', chatClassifier: 'off'});
	await assert.rejects(async () => by('chatRouter').set('off'), /Unknown option/);
	await assert.rejects(async () => by('chatClassifier').set('on'), /Unknown option/);
	assert.equal(by('tierLightModel').label, 'Light tier: model');
	assert.equal(by('tierMaxEffort').label, 'Max tier: effort');
	assert.deepEqual(by('tierStrongModel').options.map(o => o.value), ['haiku', 'sonnet', 'opus', 'fable']);
	assert.equal(await by('tierLightModel').get(), 'haiku');
	assert.equal(await by('tierMaxEffort').get(), 'high');
	await by('tierLightModel').set('sonnet');
	await by('tierMaxEffort').set('max');
	assert.equal(await by('tierLightModel').get(), 'sonnet');
	assert.equal(await by('tierMaxEffort').get(), 'max');
	await by('tierMaxEffort').set('');
	assert.equal(await by('tierMaxEffort').get(), 'high');
	await assert.rejects(async () => by('tierLightModel').set('claude-opus-9'), /Unknown option/);
	await assert.rejects(async () => by('tierLightEffort').set('turbo'), /Unknown option/);
	for (const t of ['light', 'standard', 'strong', 'max']) {
		const cap = t[0]!.toUpperCase() + t.slice(1);
		for (const f of ['Model', 'Effort']) assert.deepEqual(by(`tier${cap}${f}`).inline, {row: t, section: 'Model tiers'});
	}
	assert.equal(settings.filter(s => s.inline).length, 8);
	assert.deepEqual(by('tierStrongModel').options.map(o => o.label), ['haiku', 'sonnet', 'opus', 'fable']);
	assert.deepEqual(by('tierLightEffort').options.map(o => [o.value, o.label]), ['low', 'medium', 'high', 'xhigh', 'max'].map(e => [e, e]));
	await by('tierLightModel').set('haiku');
	await by('tierMaxEffort').set('max');
	await by('tierMaxEffort').set('high');
	await by('tierStandardEffort').set('medium');
	assert.equal(state.tierLightModel, undefined, 'cycling onto the tier default follows the default again');
	assert.equal(state.tierMaxEffort, undefined);
	assert.equal(state.tierStandardEffort, undefined);
	assert.equal(await by('tierLightModel').get(), 'haiku');
	assert.equal(await by('tierMaxEffort').get(), 'high');
	assert.deepEqual(live, [], 'router settings need no live patch');
});
