import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runTurn} from '../src/session.js';
import type {QueryFn} from '../src/types.js';

const SECRET = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const redact = (s: string) => s.split(SECRET).join('[redacted]');

type Msg = Record<string, unknown>;

const fake = (
	msgs: Msg[],
	opts: {throwAfter?: Error; hang?: boolean} = {},
): {query: QueryFn; closed: () => number; seen: () => unknown} => {
	let closed = 0;
	let seen: unknown;
	const query = ((arg: unknown) => {
		seen = arg;
		let release: (() => void) | undefined;
		const gen = (async function* () {
			for (const m of msgs) yield m;
			if (opts.hang) await new Promise<void>(r => (release = r));
			if (opts.throwAfter) throw opts.throwAfter;
		})();
		return Object.assign(gen, {
			close: () => {
				closed++;
				release?.();
			},
		});
	}) as unknown as QueryFn;
	return {query, closed: () => closed, seen: () => seen};
};

const init = {type: 'system', subtype: 'init', session_id: 's-init', model: 'm1', apiKeySource: 'ANTHROPIC_API_KEY'};
const ok = (result: string) => ({type: 'result', subtype: 'success', is_error: false, result, session_id: 's-res'});
const run = (f: ReturnType<typeof fake>, extra: {signal?: AbortSignal; options?: object} = {}) =>
	runTurn({query: f.query, prompt: 'hi', options: (extra.options ?? {}) as never, signal: extra.signal, redact});

test('success returns text and session info, closes the query', async () => {
	const f = fake([init, ok('hello')]);
	const r = await run(f);
	assert.equal(r.text, 'hello');
	assert.equal(r.sessionId, 's-res');
	assert.equal(r.model, 'm1');
	assert.equal(r.apiKeySource, 'ANTHROPIC_API_KEY');
	assert.equal(f.closed(), 1);
});

test('session id comes from init when result lacks it', async () => {
	const f = fake([init, {type: 'result', subtype: 'success', is_error: false, result: 'x'}]);
	assert.equal((await run(f)).sessionId, 's-init');
});

test('empty result falls back to last assistant text', async () => {
	const f = fake([
		init,
		{type: 'assistant', message: {content: [{type: 'text', text: 'foo'}, {type: 'tool_use'}, {type: 'text', text: 'bar'}]}},
		ok(''),
	]);
	assert.equal((await run(f)).text, 'foobar');
});

test('options are passed through, including resume', async () => {
	const f = fake([init, ok('x')]);
	await run(f, {options: {resume: 'abc'}});
	assert.deepEqual(f.seen(), {prompt: 'hi', options: {resume: 'abc'}});
});

test('is_error result followed by a throw keeps the mapped error', async () => {
	const f = fake([init, {type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', session_id: 's'}], {
		throwAfter: new Error('process exited with code 1'),
	});
	await assert.rejects(run(f), /^Error: Not authenticated\. Run "claude auth status"/);
	assert.equal(f.closed(), 1);
});

test('authentication_failed assistant error maps to the auth message', async () => {
	const f = fake([init, {type: 'assistant', error: 'authentication_failed', message: {content: []}}], {
		throwAfter: new Error('boom'),
	});
	await assert.rejects(run(f), /Not authenticated/);
});

test('resume not found maps to the claude new message', async () => {
	const f = fake([{type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: x'}]);
	await assert.rejects(run(f), {
		message: 'The stored session no longer exists. Run "claude new" or "claude ask --new <text>".',
	});
});

test('real SDK shapes: resume miss carries the text in errors[] with result absent', async () => {
	const f = fake([
		{type: 'system', subtype: 'init', session_id: 's-new', model: 'm1'},
		{type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: 11111111-2222-4333-8444-555555555555']},
	]);
	await assert.rejects(run(f), {
		message: 'The stored session no longer exists. Run "claude new" or "claude ask --new <text>".',
	});
});

test('real SDK shapes: rejected credential is a success-subtype error result after an auth_failed assistant', async () => {
	const f = fake([
		init,
		{type: 'assistant', error: 'authentication_failed', message: {content: [{type: 'text', text: 'Invalid API key'}]}},
		{type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.', terminal_reason: 'api_error'},
	]);
	await assert.rejects(run(f), {
		message: 'Not authenticated. Run "claude auth status", set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>".',
	});
});

test('generic throw maps to request failed and is redacted', async () => {
	const f = fake([], {throwAfter: new Error(`bad thing with ${SECRET}`)});
	await assert.rejects(run(f), (e: Error) => {
		assert.equal(e.message, 'Claude request failed: bad thing with [redacted]');
		return true;
	});
	assert.equal(f.closed(), 1);
});

test('generic error result is redacted', async () => {
	const f = fake([{type: 'result', subtype: 'error_max_turns', is_error: true, result: `oops ${SECRET}`}]);
	await assert.rejects(run(f), {message: 'Claude request failed: oops [redacted]'});
});

test('abort closes the query and rejects with Request cancelled', async () => {
	const f = fake([init], {hang: true});
	const ac = new AbortController();
	const p = run(f, {signal: ac.signal});
	setTimeout(() => ac.abort(), 10);
	await assert.rejects(p, {message: 'Request cancelled'});
	assert.ok(f.closed() >= 1);
});

test('already aborted signal rejects without querying', async () => {
	const f = fake([init, ok('x')]);
	const ac = new AbortController();
	ac.abort();
	await assert.rejects(run(f, {signal: ac.signal}), {message: 'Request cancelled'});
	assert.equal(f.seen(), undefined);
});

test('missing result is an error', async () => {
	const f = fake([init]);
	await assert.rejects(run(f), /no result/);
});
