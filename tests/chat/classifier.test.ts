import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Options, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {createClassifier} from '../../src/chat/classifier.js';
import {ROUTER_SYSTEM} from '../../src/chat/router.js';
import {buildRouterOptions, resolvePaths} from '../../src/config.js';
import type {ChatQueryFn, Credential} from '../../src/types.js';
import {makeFakeLog} from '../helpers/fake-log.js';

type Script = (prompt: string) => AsyncGenerator<unknown>;

const fakeQuery = (script: Script) => {
	const calls: {options: Options | undefined; closed: number; prompt: string}[] = [];
	const query: ChatQueryFn = p => {
		const call = {options: p.options, closed: 0, prompt: ''};
		calls.push(call);
		const gen = (async function* () {
			for await (const m of p.prompt as AsyncIterable<SDKUserMessage>) {
				call.prompt = String(m.message.content);
				break;
			}
			yield* script(call.prompt);
		})();
		return Object.assign(gen, {
			close: () => {
				call.closed++;
			},
		}) as never;
	};
	return {query, calls};
};

const result = (text: string) => ({type: 'result', subtype: 'success', result: text, usage: {input_tokens: 120, cache_read_input_tokens: 30, output_tokens: 9}});
const opts = {model: 'haiku'} as Options;

test('a valid answer gives the verdict, the time and the tokens, and closes the query', async () => {
	const {query, calls} = fakeQuery(async function* () {
		yield {type: 'system', subtype: 'init'};
		yield result('{"continues":false,"rating":"strong"}');
	});
	const c = createClassifier({query, options: () => opts, log: makeFakeLog()});
	const r = await c.classify('the task');
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(r.verdict, {continues: false, rating: 'strong'});
	assert.deepEqual(r.tokens, {in: 150, out: 9});
	assert.equal(calls[0]!.prompt, 'the task');
	assert.equal(calls[0]!.options, opts);
	assert.equal(calls[0]!.closed, 1);
});

test('a slow answer times out and the query is closed', async () => {
	const {query, calls} = fakeQuery(async function* () {
		await new Promise(r => setTimeout(r, 500));
		yield result('{"continues":false,"rating":"light"}');
	});
	const c = createClassifier({query, options: () => opts, log: makeFakeLog(), timeoutMs: 30});
	const r = await c.classify('x');
	assert.deepEqual({ok: r.ok, reason: !r.ok && r.reason}, {ok: false, reason: 'timeout'});
	assert.equal(calls[0]!.closed, 1);
});

test('a throwing query is an error, an unreadable answer is invalid, an error result is an error', async () => {
	const throwing = fakeQuery(async function* () {
		throw new Error('boom');
	});
	const r1 = await createClassifier({query: throwing.query, options: () => opts, log: makeFakeLog()}).classify('x');
	assert.equal(!r1.ok && r1.reason, 'error');
	assert.equal(throwing.calls[0]!.closed, 1);
	const invalid = fakeQuery(async function* () {
		yield result('I think it is hard');
	});
	const r2 = await createClassifier({query: invalid.query, options: () => opts, log: makeFakeLog()}).classify('x');
	assert.equal(!r2.ok && r2.reason, 'invalid');
	const failed = fakeQuery(async function* () {
		yield {type: 'result', subtype: 'error_during_execution'};
	});
	const r3 = await createClassifier({query: failed.query, options: () => opts, log: makeFakeLog()}).classify('x');
	assert.equal(!r3.ok && r3.reason, 'error');
});

test('an abort stops the classifier and closes the query', async () => {
	const {query, calls} = fakeQuery(async function* () {
		await new Promise(r => setTimeout(r, 500));
		yield result('{"continues":false,"rating":"light"}');
	});
	const ac = new AbortController();
	const c = createClassifier({query, options: () => opts, log: makeFakeLog()});
	const pending = c.classify('x', ac.signal);
	setTimeout(() => ac.abort(), 10);
	const r = await pending;
	assert.equal(!r.ok && r.reason, 'aborted');
	assert.equal(calls[0]!.closed, 1);
	const pre = await c.classify('x', ac.signal);
	assert.equal(!pre.ok && pre.reason, 'aborted');
	assert.equal(calls.length, 1);
});

test('router options run the light model with no tools, settings, hooks, session or thinking', async () => {
	const cred: Credential = {kind: 'api-key', source: 'env', value: 'sk-ant-api-TESTVALUE0123456789abcdef'};
	const o = buildRouterOptions({
		paths: resolvePaths('/data/claude', '/app/modules/claude'),
		cred,
		abortController: new AbortController(),
		model: 'haiku',
		env: {PATH: '/usr/bin'},
	});
	assert.equal(o.model, 'haiku');
	assert.equal(o.systemPrompt, ROUTER_SYSTEM);
	assert.deepEqual(o.tools, []);
	assert.deepEqual(o.settingSources, []);
	assert.deepEqual(o.mcpServers, {});
	assert.deepEqual(o.additionalDirectories, []);
	assert.equal(o.strictMcpConfig, true);
	assert.equal(o.persistSession, false);
	assert.equal(o.maxTurns, 1);
	assert.equal(o.effort, 'low');
	assert.deepEqual(o.thinking, {type: 'disabled'});
	assert.deepEqual(o.settings, {disableAllHooks: true});
	assert.equal(o.env?.ANTHROPIC_API_KEY, cred.value);
	const denied = await o.canUseTool!('Bash', {}, {signal: new AbortController().signal, toolUseID: 't'} as never);
	assert.equal(denied?.behavior, 'deny');
});
