import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runTurn, TurnFailure} from '../src/session.js';
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

const NOW_S = Math.floor(Date.now() / 1000);
const clock = {now: () => NOW_S * 1000, timeZone: 'UTC'};
const runAt = (f: ReturnType<typeof fake>) => runTurn({query: f.query, prompt: 'hi', options: {} as never, redact, clock});
const limitMsg = {type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: "You've hit your limit"}]}};
const failed = (extra: Msg = {}) => ({type: 'result', subtype: 'success', is_error: true, result: 'x', session_id: 's-res', ...extra});

test('usage limit is classified, carries the session id and model', async () => {
	const f = fake([
		init,
		{type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: NOW_S + 3600, rateLimitType: 'five_hour'}},
		limitMsg,
		failed(),
	]);
	const err = await runAt(f).then(
		() => undefined,
		(e: unknown) => e,
	);
	assert.ok(err instanceof TurnFailure);
	assert.equal(err.kind, 'usage-limit');
	assert.equal(err.sessionId, 's-res');
	assert.equal(err.model, 'm1');
	assert.match(err.message, /Usage limit reached/);
	assert.match(err.message, /claude ask/);
});

test('a rate_limit error without a rejected report is a rate-limit', async () => {
	const f = fake([init, {...limitMsg, message: {content: [{type: 'text', text: 'API Error: 429'}]}}, failed()]);
	await assert.rejects(runAt(f), (e: unknown) => e instanceof TurnFailure && e.kind === 'rate-limit');
});

test('blocking_limit is a context failure', async () => {
	const f = fake([
		init,
		{type: 'assistant', error: 'invalid_request', message: {content: [{type: 'text', text: 'Prompt is too long'}]}},
		failed({terminal_reason: 'blocking_limit', result: 'Prompt is too long'}),
	]);
	await assert.rejects(runAt(f), (e: unknown) => e instanceof TurnFailure && e.kind === 'context' && e.sessionId === 's-res');
});

test('billing errors are classified', async () => {
	const f = fake([init, {type: 'assistant', error: 'billing_error', message: {content: []}}, failed()]);
	await assert.rejects(runAt(f), (e: unknown) => e instanceof TurnFailure && e.kind === 'billing');
});

test('a resume failure carries no session id', async () => {
	const f = fake([failed({subtype: 'error_during_execution', result: '', errors: ['No conversation found with session ID: x'], session_id: undefined})]);
	await assert.rejects(runAt(f), (e: unknown) => e instanceof TurnFailure && e.kind === 'resume' && e.sessionId === undefined);
});

test('cancel and auth failures carry the session id when known', async () => {
	const ac = new AbortController();
	const f = fake([init], {hang: true});
	const p = run(f, {signal: ac.signal});
	setImmediate(() => ac.abort());
	await assert.rejects(p, (e: unknown) => e instanceof TurnFailure && e.kind === 'cancelled' && e.sessionId === 's-init');
	const g = fake([init, {type: 'assistant', error: 'authentication_failed', message: {content: []}}, failed()]);
	await assert.rejects(run(g), (e: unknown) => e instanceof TurnFailure && e.kind === 'auth' && e.sessionId === 's-res');
});

test('a generic failure still reads as before and has no kind', async () => {
	const f = fake([init, failed({result: `boom ${SECRET}`})]);
	await assert.rejects(run(f), (e: unknown) => e instanceof TurnFailure && e.kind === undefined && !e.message.includes(SECRET));
});

test('limit messages are redacted and use the injected clock for resetsAt', async () => {
	const FAR = 4_000_000_000;
	const farClock = {now: () => FAR * 1000, timeZone: 'UTC'};
	const f = fake([
		init,
		{type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: FAR + 600, rateLimitType: 'five_hour'}},
		{type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: 'limit'}]}},
		failed(),
	]);
	const err = await runTurn({query: f.query, prompt: 'hi', options: {} as never, redact, clock: farClock}).catch((e: unknown) => e);
	assert.ok(err instanceof TurnFailure);
	assert.match(err.message, /resets at .*\(in 10m\)/);

	const g = fake([init, {type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: `You've hit your limit ${SECRET}`}]}}, failed()]);
	const e2 = await runAt(g).catch((e: unknown) => e);
	assert.ok(e2 instanceof TurnFailure && e2.kind === 'usage-limit');
	assert.ok(!e2.message.includes(SECRET));
});
