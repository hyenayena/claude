import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {authFile, pinnedAccount, setOrder, useAccount} from '../../src/accounts.js';
import {loginCredentialsFile} from '../../src/login-slot.js';
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

const setup = async (o: {apiKeyOnly?: boolean; login?: boolean} = {}) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-engine-account-'));
	if (o.login) {
		await mkdir(join(dataDir, 'config'), {recursive: true});
		await writeFile(loginCredentialsFile(join(dataDir, 'config')), '{}');
	}
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
		{fresh: true, ...(o.apiKeyOnly && {apiKeyOnly: true})},
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

const limitHit = async (q: Q | undefined) => {
	q?.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
	q?.emit({type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour', utilization: 1}});
	q?.emit({type: 'assistant', error: 'rate_limit', message: {id: 'm', content: [{type: 'text', text: "You've hit your limit · resets 3pm"}]}, parent_tool_use_id: null});
	q?.emit({type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", session_id: 'sess-1'});
	await tick();
	await tick();
};

const outcomes = (events: ChatEvent[]) => events.filter(e => e.type === 'turn-end').map(e => e.type === 'turn-end' && e.outcome);

const readAuthText = async (dataDir: string): Promise<string | undefined> => {
	try {
		return await readFile(authFile(dataDir), 'utf8');
	} catch {
		return undefined;
	}
};

test('after a limit the next turn runs on the same account even when others follow it', async () => {
	const {engine, opts, queries, events, accountEvents, log, turn} = await setup();
	engine.session.send('one');
	await limitHit(queries.at(-1));
	assert.deepEqual(outcomes(events), ['limit']);
	assert.equal(queries.length, 1);
	assert.equal(queries[0]?.closed, 0);
	assert.equal(engine.cred.account, 'a');
	assert.deepEqual(accountEvents(), []);
	const before = await readAuthText(opts.dataDir);
	await turn('again');
	assert.equal(queries.length, 1, 'the same process, the same account');
	assert.equal(engine.cred.account, 'a');
	assert.equal(await readAuthText(opts.dataDir), before, 'a limit writes nothing to the auth state');
	assert.ok(!log.records.some(r => r.msg === 'account limited' || r.msg === 'account switched'));
	engine.close();
});

test('a pinned account is used at the next spawn and announced as pinned', async () => {
	const {engine, opts, queries, accountEvents, turn} = await setup();
	await turn('one');
	assert.equal(engine.cred.account, 'a');
	useAccount(accountsCtx(opts), 'b');
	await turn('two');
	assert.equal(queries.length, 2);
	assert.equal(engine.cred.account, 'b');
	assert.deepEqual(accountEvents(), [{type: 'account', account: 'b', previous: 'a', reason: 'pinned'}]);
	engine.close();
});

test('an order change is announced as changed at the next turn', async () => {
	const {engine, opts, queries, accountEvents, turn} = await setup();
	await turn('one');
	setOrder(accountsCtx(opts), ['b', 'a']);
	await turn('two');
	assert.equal(queries.length, 2);
	assert.equal(engine.cred.account, 'b');
	assert.deepEqual(accountEvents(), [{type: 'account', account: 'b', previous: 'a', reason: 'changed'}]);
	assert.equal(pinnedAccount(accountsCtx(opts)), undefined);
	engine.close();
});

test('the engine logs no account names for an account change', async () => {
	const {engine, opts, turn, log} = await setup();
	await turn('one');
	useAccount(accountsCtx(opts), 'b');
	await turn('two');
	assert.ok(log.records.some(r => r.msg === 'account changed'));
	for (const r of log.records.filter(r => r.msg === 'account changed' || r.msg === 'account changing')) {
		assert.ok(!JSON.stringify(r.fields).match(/"(a|b)"/), JSON.stringify(r.fields));
	}
	engine.close();
});

test('an apiKeyOnly engine never spawns on the login, also after "auth use login"', async () => {
	const {engine, opts, queries, accountEvents, turn} = await setup({apiKeyOnly: true, login: true});
	assert.equal(accountsCtx(opts).login?.present, true);
	setOrder(accountsCtx(opts), ['login', 'a', 'b']);
	await turn('one');
	assert.equal(engine.cred.account, 'a');
	assert.equal(engine.cred.source, 'stored');
	useAccount(accountsCtx(opts), 'login');
	await turn('two');
	assert.equal(engine.cred.account, 'a');
	assert.equal(queries.length, 1, 'no respawn to the login');
	assert.deepEqual(accountEvents(), []);
	engine.close();
});

test('an engine without apiKeyOnly uses the login when it comes first', async () => {
	const {engine, opts, turn} = await setup({login: true});
	setOrder(accountsCtx(opts), ['login', 'a', 'b']);
	await turn('one');
	assert.equal(engine.cred.account, 'login');
	assert.equal(engine.cred.source, 'claude-login');
	engine.close();
});
