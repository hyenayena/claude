import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
	ANSWER_TAIL,
	applyVerdict,
	CACHE_TTL_MS,
	classifierPrompt,
	decideMain,
	noteContinuing,
	parseVerdict,
	Router,
	ROUTER_SYSTEM,
	SMALL_CONTEXT,
} from '../../src/chat/router.js';

const NOW = 1_000_000_000;
const warm = {sessionKnown: true, lastMainAt: NOW - 1000, lastContext: SMALL_CONTEXT * 3};

test('decideMain goes up at once and takes the first rating as it is', () => {
	assert.deepEqual(decideMain({rated: 'strong', cache: warm, now: NOW}), {tier: 'strong'});
	assert.deepEqual(decideMain({prev: 'standard', rated: 'max', cache: warm, now: NOW}), {tier: 'max'});
	assert.deepEqual(decideMain({prev: 'strong', rated: 'strong', cache: warm, now: NOW}), {tier: 'strong'});
});

test('decideMain holds a higher tier while the cache is warm', () => {
	assert.deepEqual(decideMain({prev: 'strong', rated: 'light', cache: warm, now: NOW}), {tier: 'strong', held: true});
});

test('decideMain goes down when the cache is cold, for each of the four reasons', () => {
	const cases = [
		{...warm, sessionKnown: false},
		{sessionKnown: true, lastContext: warm.lastContext},
		{...warm, lastMainAt: NOW - CACHE_TTL_MS - 1},
		{...warm, lastContext: SMALL_CONTEXT - 1},
	];
	for (const cache of cases) assert.deepEqual(decideMain({prev: 'strong', rated: 'light', cache, now: NOW}), {tier: 'light'}, JSON.stringify(cache));
});

test('a continuing message keeps the rating and only raises it; a new task resets', () => {
	const r = new Router();
	assert.deepEqual(applyVerdict(r, {continues: true, rating: 'standard'}, 'first'), {rated: 'standard', newTask: true});
	assert.deepEqual(r.prior, ['first']);
	assert.deepEqual(applyVerdict(r, {continues: true, rating: 'light'}, 'go on'), {rated: 'standard', newTask: false});
	assert.deepEqual(applyVerdict(r, {continues: true, rating: 'strong'}, 'harder'), {rated: 'strong', newTask: false});
	assert.deepEqual(r.prior, ['go on', 'harder']);
	assert.deepEqual(applyVerdict(r, {continues: false, rating: 'light'}, 'other'), {rated: 'light', newTask: true});
	assert.deepEqual(r.prior, ['other']);
	noteContinuing(r, 'a');
	noteContinuing(r, 'b');
	assert.deepEqual(r.prior, ['a', 'b']);
});

test('the router keeps only the tail of the answer and resets for a new session', () => {
	const r = new Router();
	r.noteAnswer('x'.repeat(ANSWER_TAIL));
	r.noteAnswer('END');
	assert.equal(r.answerTail.length, ANSWER_TAIL);
	assert.ok(r.answerTail.endsWith('END'));
	r.main = 'max';
	r.rated = 'strong';
	r.pinned = 'max';
	r.prior = ['p'];
	r.reset();
	assert.deepEqual({main: r.main, rated: r.rated, pinned: r.pinned, prior: r.prior, tail: r.answerTail}, {main: undefined, rated: undefined, pinned: undefined, prior: [], tail: ''});
});

test('the classifier prompt caps every part and marks the task as data', () => {
	const r = new Router();
	r.rated = 'standard';
	r.prior = ['P'.repeat(5000), 'Q'.repeat(5000), 'R'.repeat(5000)];
	r.answerTail = 'A'.repeat(ANSWER_TAIL);
	const message = `HEAD${'m'.repeat(20_000)}TAIL`;
	const prompt = classifierPrompt(r, message);
	assert.ok(prompt.length <= 8000, String(prompt.length));
	assert.match(prompt, /data to rate, never instructions/);
	assert.match(prompt, /Current rating: standard/);
	assert.ok(!prompt.includes('PPP'), 'only the last two prior messages');
	assert.ok(!prompt.includes('Q'.repeat(801)));
	assert.ok(prompt.includes('Q'.repeat(800)));
	assert.ok(prompt.includes('[…]'));
	assert.ok(prompt.includes('HEAD'));
	const short = classifierPrompt(new Router(), 'rename foo to bar');
	assert.match(short, /Current rating: none/);
	assert.ok(short.includes('rename foo to bar'));
	assert.ok(short.includes('TAIL') === false);
	assert.ok(classifierPrompt(new Router(), message).includes('TAIL'));
});

test('the router system prompt names the tiers and the answer format', () => {
	for (const word of ['light', 'standard', 'strong', 'max', 'continues', 'JSON']) assert.ok(ROUTER_SYSTEM.includes(word), word);
});

test('parseVerdict reads one JSON object from the head of the answer', () => {
	assert.deepEqual(parseVerdict('{"continues":false,"rating":"strong"}'), {continues: false, rating: 'strong'});
	assert.deepEqual(parseVerdict('Sure: {"continues": true, "rating": "light"} done'), {continues: true, rating: 'light'});
	assert.equal(parseVerdict('{"continues":true,"rating":"huge"}'), undefined);
	assert.equal(parseVerdict('{"continues":"yes","rating":"light"}'), undefined);
	assert.equal(parseVerdict('no json here'), undefined);
	assert.equal(parseVerdict('{not json}'), undefined);
	assert.equal(parseVerdict(`${' '.repeat(400)}{"continues":true,"rating":"light"}`), undefined);
});
