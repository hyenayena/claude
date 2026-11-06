import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clampTier, DEFAULT_TIERS, parseTierModel, tierMapFromState} from '../../src/chat/tiers.js';
import {isTier, maxTier, tierRank} from '../../src/deps/chat.js';

test('model tier syntax: one tier, or an ascending range with a default', () => {
	assert.deepEqual(parseTierModel('strong'), {low: 'strong', high: 'strong', default: 'strong'});
	assert.deepEqual(parseTierModel(' MAX '), {low: 'max', high: 'max', default: 'max'});
	assert.deepEqual(parseTierModel('light/STRONG'), {low: 'light', high: 'strong', default: 'strong'});
	assert.deepEqual(parseTierModel('light/strong'), {low: 'light', high: 'strong', default: 'light'});
	assert.deepEqual(parseTierModel('Light / Max'), {low: 'light', high: 'max', default: 'light'});
	assert.deepEqual(parseTierModel('light/standard/max'), {low: 'light', high: 'max', default: 'standard'});
	assert.deepEqual(parseTierModel('light/standard/MAX'), {low: 'light', high: 'max', default: 'max'});
	assert.deepEqual(parseTierModel('light/standard/strong/max'), {low: 'light', high: 'max', default: 'standard'});
	assert.deepEqual(parseTierModel('LIGHT/standard/strong/max'), {low: 'light', high: 'max', default: 'light'});
	assert.deepEqual(parseTierModel('light/standard/STRONG/max'), {low: 'light', high: 'max', default: 'strong'});
});

test('concrete models and inherit are not tier syntax; broken tier syntax is invalid', () => {
	for (const concrete of ['opus', 'sonnet', 'haiku', 'fable', 'inherit', 'claude-opus-4-1', '']) assert.equal(parseTierModel(concrete), undefined, concrete);
	for (const bad of ['light/huge', 'strong/light', 'light/light', 'LIGHT/STRONG', 'light//max', 'light/', '/max', 'light/standard/strong/max/max', 'opus/max', 'LIGHT/STANDARD/max']) {
		assert.equal(parseTierModel(bad), 'invalid', bad);
	}
});

test('tiers rank, compare and clamp into a range', () => {
	assert.ok(isTier('max') && !isTier('MAX') && !isTier(3));
	assert.ok(tierRank('light') < tierRank('standard') && tierRank('strong') < tierRank('max'));
	assert.equal(maxTier('standard', 'strong'), 'strong');
	assert.equal(maxTier('max', 'light'), 'max');
	const r = {low: 'standard', high: 'strong'} as const;
	assert.equal(clampTier('light', r), 'standard');
	assert.equal(clampTier('strong', r), 'strong');
	assert.equal(clampTier('max', r), 'strong');
});

test('the tier map uses stored values and falls back to the defaults', () => {
	assert.deepEqual(tierMapFromState({}), DEFAULT_TIERS);
	assert.deepEqual(DEFAULT_TIERS.light, {model: 'haiku', effort: 'medium'});
	assert.deepEqual(DEFAULT_TIERS.max, {model: 'opus', effort: 'high'});
	const map = tierMapFromState({tierLightModel: 'sonnet', tierMaxEffort: 'max', tierStrongModel: 'fable'});
	assert.deepEqual(map.light, {model: 'sonnet', effort: 'medium'});
	assert.deepEqual(map.max, {model: 'opus', effort: 'max'});
	assert.deepEqual(map.strong, {model: 'fable', effort: 'medium'});
	assert.deepEqual(map.standard, DEFAULT_TIERS.standard);
});
