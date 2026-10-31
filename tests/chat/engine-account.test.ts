import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {markLimited, pinnedAccount, useAccount} from '../../src/accounts.js';
import {createChatEngine, type ChatEngine} from '../../src/chat/engine.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {accountsCtx, storeSecret, type CredentialOpts} from '../../src/credentials.js';
import type {ChatQueryFn} from '../../src/types.js';
import {hostVault} from '../../src/vault.js';
import {fakeCredentials} from '../helpers/fake-credentials.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const KEY_A = 'sk-ant-api03-AAAAVALUE0123456789abcdef';
const KEY_B = 'sk-ant-api03-BBBBVALUE0123456789abcdef';
const tick = () => new Promise<void>(r => setImmediate(r));

class Q {
	closed = 0;
	private buf: SDKMessage[] = [];
	private wake: (() => void) | undefined;
	constructor(prompt: AsyncIterable<unknown>) {
		void (async () => {
			for await (const _ of prompt) void _;
		})();
	}
	emit(m: unknown): void {
		this.buf.push(m as SDKMessage);
		this.wake?.();
	}
	interrupt(): Promise<void> {
		return Promise.resolve();
	}
	setPermissionMode(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {
		this.closed++;
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
		for (;;) {
			const m = this.buf.shift();
			if (!m) {
				await new Promise<void>(r => {
					this.wake = r;
				});
				continue;
			}
			yield m;
		}
	}
}

const setup = async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-engine-account-'));
	const log = makeFakeLog();
	const vault = hostVault(fakeCredentials(), log);
	const opts: CredentialOpts = {env: {}, dataDir, vault, log};
	await storeSecret(opts, KEY_A, 'a');
	await storeSecret(opts, KEY_B, 'b');
	const queries: Q[] = [];
	const query: ChatQueryFn = p => {
		const q = new Q(p.prompt);
		queries.push(q);
		return q as never;
	};
	const engine: ChatEngine = await createChatEngine(
		{fresh: true},
		{
			dataDir,
			env: {},
			log,
			vault,
			loadChatQuery: async () => query,
			store: {read: async () => ({})},
			isMissingModule: () => false,
			shellTmp: () => join(dataDir, 'shell'),
			sandboxProblem: () => 'unavailable',
			idleCloseMs: 60_000,
		},
		{stateUpdate: async () => undefined, warn: () => undefined},
	);
	const events: ChatEvent[] = [];
	engine.session.subscribe(e => events.push(e));
	const accountEvents = () => events.filter(e => e.type === 'account');
	const turn = async (text: string) => {
		engine.session.send(text);
		const q = queries.at(-1);
		q?.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
		q?.emit({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1', total_cost_usd: 0.1});
		await tick();
		await tick();
	};
	return {engine, opts, queries, events, accountEvents, turn, log};
};

test('the engine returns to the higher account once its limit has passed, at the next turn only', async () => {
	const {engine, opts, queries, accountEvents, turn} = await setup();
	await turn('one');
	assert.equal(engine.cred.account, 'a');
	assert.equal(accountEvents().length, 0);

	markLimited(accountsCtx(opts), 'a', Date.now() / 1000 + 3600, 'usage-limit');
	await turn('two');
	assert.equal(queries.length, 2);
	assert.equal(queries[0]?.closed, 1);
	assert.equal(engine.cred.account, 'b');
	assert.deepEqual(accountEvents(), [{type: 'account', account: 'b', previous: 'a', reason: 'changed'}]);

	await turn('three');
	assert.equal(queries.length, 2, 'nothing changes while a stays limited');

	markLimited(accountsCtx(opts), 'a', 1, 'usage-limit');
	await turn('four');
	assert.equal(queries.length, 3);
	assert.equal(engine.cred.account, 'a');
	assert.deepEqual(accountEvents().at(-1), {type: 'account', account: 'a', previous: 'b', reason: 'restored'});
	assert.equal(accountEvents().length, 2);

	await turn('five');
	assert.equal(queries.length, 3);
	assert.equal(accountEvents().length, 2);
	engine.close();
});

test('the engine logs no account names for an account return', async () => {
	const {engine, opts, turn, log} = await setup();
	await turn('one');
	markLimited(accountsCtx(opts), 'a', Date.now() / 1000 + 3600, 'usage-limit');
	await turn('two');
	assert.ok(log.records.some(r => r.msg === 'account changed'));
	for (const r of log.records.filter(r => r.msg === 'account changed' || r.msg === 'account returning')) {
		assert.ok(!JSON.stringify(r.fields).match(/"(a|b)"/), JSON.stringify(r.fields));
	}
	engine.close();
});

const limitHit = async (q: Q | undefined) => {
	q?.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
	q?.emit({type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', utilization: 1}});
	q?.emit({type: 'assistant', error: 'rate_limit', message: {id: 'm', content: [{type: 'text', text: "You've hit your limit · resets 3pm"}]}, parent_tool_use_id: null});
	q?.emit({type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", session_id: 'sess-1'});
	await tick();
	await tick();
};

test('a pinned account is used at the next spawn and announced as pinned', async () => {
	const {engine, opts, accountEvents, turn} = await setup();
	useAccount(accountsCtx(opts), 'b', {only: false});
	await turn('one');
	assert.equal(engine.cred.account, 'b');
	assert.deepEqual(accountEvents(), [{type: 'account', account: 'b', previous: 'a', reason: 'pinned'}]);
	engine.close();
});

test('with a plain pin the chat does not return to a higher account that has reset', async () => {
	const {engine, opts, queries, turn} = await setup();
	await turn('one');
	markLimited(accountsCtx(opts), 'a', Date.now() / 1000 + 3600, 'usage-limit');
	await turn('two');
	assert.equal(engine.cred.account, 'b');
	useAccount(accountsCtx(opts), 'b', {only: false});
	markLimited(accountsCtx(opts), 'a', 1, 'usage-limit');
	await turn('three');
	assert.equal(queries.length, 2);
	assert.equal(engine.cred.account, 'b');
	engine.close();
});

test('a plain pin that hits its limit is cleared and the priority order takes over', async () => {
	const {engine, opts, queries, events, accountEvents, log} = await setup();
	useAccount(accountsCtx(opts), 'b', {only: false});
	engine.session.send('one');
	await limitHit(queries.at(-1));
	assert.equal(queries.length, 2);
	assert.equal(engine.cred.account, 'a');
	assert.deepEqual(accountEvents().at(-1), {type: 'account', account: 'a', previous: 'b', reason: 'usage-limit'});
	assert.equal(pinnedAccount(accountsCtx(opts)), undefined);
	const limited = log.records.find(r => r.msg === 'account limited');
	assert.equal(limited?.fields?.unpinned, true);
	assert.ok(!JSON.stringify(limited?.fields).match(/"(a|b)"/));
	queries.at(-1)?.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
	queries.at(-1)?.emit({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1', total_cost_usd: 0.1});
	await tick();
	await tick();
	assert.deepEqual(events.filter(e => e.type === 'turn-end').map(e => e.type === 'turn-end' && e.outcome), ['ok']);
	engine.close();
});

test('an only pin never switches at its limit; the turn ends with the limit', async () => {
	const {engine, opts, queries, events, accountEvents, log} = await setup();
	useAccount(accountsCtx(opts), 'b', {only: true});
	engine.session.send('one');
	await limitHit(queries.at(-1));
	assert.equal(queries.length, 1);
	assert.equal(engine.cred.account, 'b');
	assert.ok(!accountEvents().some(e => e.type === 'account' && e.reason === 'usage-limit'));
	assert.deepEqual(events.filter(e => e.type === 'turn-end').map(e => e.type === 'turn-end' && e.outcome), ['limit']);
	assert.deepEqual(pinnedAccount(accountsCtx(opts)), {name: 'b', only: true});
	assert.equal(log.records.find(r => r.msg === 'account limited')?.fields?.unpinned, false);
	engine.close();
});
