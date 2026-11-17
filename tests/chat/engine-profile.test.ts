import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {HookCallback, Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {createChatEngine} from '../../src/chat/engine.js';
import type {ChatEvent, ChatProfile} from '../../src/deps/chat.js';
import {storeSecret, type CredentialOpts} from '../../src/credentials.js';
import type {ChatQueryFn, ClaudeState} from '../../src/types.js';
import {hostVault} from '../../src/vault.js';
import {fakeCredentials} from '../helpers/fake-credentials.js';
import {makeFakeLog, serialized} from '../helpers/fake-log.js';

const KEY = 'sk-ant-api03-AAAAVALUE0123456789abcdef';
const faults = {model: 0, gate: undefined as Promise<void> | undefined};
const tick = () => new Promise<void>(r => setImmediate(r));
const settle = async (n = 10) => {
	for (let i = 0; i < n; i++) await tick();
};

class ChatQ {
	readonly order: string[] = [];
	private buf: SDKMessage[] = [];
	private wake: (() => void) | undefined;
	constructor(
		prompt: AsyncIterable<SDKUserMessage>,
		readonly options: Options,
	) {
		void (async () => {
			for await (const m of prompt) this.order.push(`push:${String(m.message.content)}`);
		})();
	}
	async setModel(model?: string): Promise<void> {
		if (faults.model > 0) {
			faults.model--;
			throw new Error('setModel failed');
		}
		this.order.push(`model:${model ?? 'default'}`);
	}
	async applyFlagSettings(flags: Record<string, unknown>): Promise<void> {
		this.order.push(`flags:${JSON.stringify(flags)}`);
	}
	async setMaxThinkingTokens(): Promise<void> {}
	emit(m: unknown): void {
		this.buf.push(m as SDKMessage);
		this.wake?.();
	}
	interrupt(): Promise<void> {
		return Promise.resolve();
	}
	close(): void {}
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


const profileOf = (extra: Record<string, unknown> = {}): ChatProfile =>
	({
		id: 'clan',
		owner: 'clan',
		appendSystemPrompt: 'You host a clan.',
		mainTools: ['Agent'],
		agents: {
			ada: {description: 'Ada', prompt: 'You are Ada.', label: 'Ada', tone: 'teal', tier: 'standard'},
			bo: {description: 'Bo', prompt: 'You are Bo.', label: 'Bo', tone: 'green'},
		},
		...extra,
	}) as ChatProfile;

const setup = async (profile: ChatProfile, state: ClaudeState = {}, idleCloseMs = 60_000, fresh = true, resume?: string) => {
	const root = await mkdtemp(join(tmpdir(), 'claude-engine-profile-'));
	const dataDir = join(root, 'data', 'claude');
	const moduleDir = join(root, 'proj', 'modules', 'claude');
	await mkdir(moduleDir, {recursive: true});
	const agentDir = join(root, 'proj', '.claude', 'agents');
	await mkdir(agentDir, {recursive: true});
	await writeFile(join(agentDir, 'fixed.md'), '---\nname: fixed\ndescription: d\nmodel: light\n---\nWork.\n');
	const log = makeFakeLog();
	const vault = hostVault(fakeCredentials(), log);
	const opts: CredentialOpts = {env: {}, dataDir, vault, log};
	await storeSecret(opts, KEY, 'a');
	const chats: ChatQ[] = [];
	let classified = 0;
	let consoleLoads = 0;
	const writes: Partial<ClaudeState>[] = [];
	const query: ChatQueryFn = p => {
		const options = p.options ?? ({} as Options);
		if (options.persistSession === false) {
			classified++;
			return Object.assign((async function* () {})(), {close: () => {}}) as never;
		}
		const q = new ChatQ(p.prompt, options);
		chats.push(q);
		return q as never;
	};
	const engine = await createChatEngine(
		{fresh, model: 'claude-configured', tuning: {effort: 'low'}, profile, ...(resume && {resume})},
		{
			dataDir,
			moduleDir,
			env: {},
			log,
			vault,
			loadChatQuery: async () => query,
			loadConsoleSdk: async () => {
				consoleLoads++;
				throw new Error('must not load');
			},
			store: {read: async () => ({...state})},
			isMissingModule: () => false,
			shellTmp: () => join(root, 'shell'),
			sandboxProblem: () => 'unavailable',
			idleCloseMs: 60_000,
			...(idleCloseMs !== 60_000 && {idleCloseMs}),
		},
		{
			stateUpdate: async patch => {
				writes.push(patch);
			},
			warn: () => undefined,
			commandBridge: {} as never,
		},
	);
	const turn = async (text: string) => {
		engine.session.send(text);
		await settle();
		const q = chats.at(-1)!;
		q.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
		q.emit({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1'});
		await settle();
	};
	const agentCall = (tool_input: Record<string, unknown>, tool_name = 'Agent') =>
		(chats.at(-1)!.options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback)(
			{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/'} as never,
			't',
			{signal: new AbortController().signal},
		);
	return {engine, chats, turn, agentCall, classified: () => classified, consoleLoads: () => consoleLoads, writes, dataDir};
};

const decision = (out: unknown): string | undefined => (out as {hookSpecificOutput?: {permissionDecision?: string}}).hookSpecificOutput?.permissionDecision;

test('a profile chat defines only the profile personas, tool-less, and ignores the project agent files', async () => {
	const s = await setup(profileOf());
	await s.turn('hello');
	const agents = s.chats[0]!.options.agents!;
	assert.deepEqual(Object.keys(agents).sort(), ['ada', 'bo']);
	assert.deepEqual(agents.ada!.tools, []);
	assert.equal(agents.ada!.prompt, 'You are Ada.');
	assert.equal(agents.ada!.model, 'sonnet');
	assert.equal(agents.bo!.model, 'haiku');
	assert.equal(s.consoleLoads(), 0);
});

test('a profile chat never routes: no classifier, no route events, the router setting is ignored', async () => {
	const s = await setup(profileOf(), {chatRouter: 'on'});
	const events: string[] = [];
	s.engine.session.subscribe(e => events.push(e.type));
	await s.turn('design the cache layer');
	assert.equal(s.classified(), 0);
	assert.equal(events.includes('route'), false);
	assert.equal(events.includes('route-start'), false);
	assert.deepEqual(s.chats[0]!.order, ['push:design the cache layer']);
});

test('the main model follows mainTier, and the configured model is used without one', async () => {
	const tiered = await setup(profileOf({mainTier: 'strong'}));
	await tiered.turn('hi');
	assert.equal(tiered.chats[0]!.options.model, 'opus');
	const plain = await setup(profileOf());
	await plain.turn('hi');
	assert.equal(plain.chats[0]!.options.model, 'claude-configured');
});

test('the profile prompt is the only appended prompt and no MCP server is configured', async () => {
	const s = await setup(profileOf());
	await s.turn('hi');
	const o = s.chats[0]!.options;
	assert.deepEqual(o.systemPrompt, {type: 'preset', preset: 'claude_code', append: 'You host a clan.'});
	assert.deepEqual(o.mcpServers, {});
	assert.equal(o.strictMcpConfig, true);
});

test('a profile chat never writes lastSessionId and never resumes the saved one', async () => {
	const s = await setup(profileOf(), {lastSessionId: '11111111-aaaa-4bbb-8ccc-222222222222'});
	await s.turn('hi');
	assert.equal(s.writes.some(w => 'lastSessionId' in w), false);
	assert.equal(s.chats[0]!.options.resume, undefined);
	assert.equal(s.engine.session.sessionId, 'sess-1');
});

test('a profile chat opened without fresh still never resumes the saved session', async () => {
	const s = await setup(profileOf(), {lastSessionId: '11111111-aaaa-4bbb-8ccc-222222222222'}, 60_000, false);
	await s.turn('hi');
	assert.equal(s.chats[0]!.options.resume, undefined);
});

test('a profile chat opened with an explicit resume id resumes that session and still never writes lastSessionId', async () => {
	const id = '33333333-aaaa-4bbb-8ccc-444444444444';
	const s = await setup(profileOf(), {lastSessionId: '11111111-aaaa-4bbb-8ccc-222222222222'}, 60_000, false, id);
	await s.turn('hi');
	assert.equal(s.chats[0]!.options.resume, id);
	assert.equal(s.writes.some(w => 'lastSessionId' in w), false);
});

test('the idle close follows keepAliveMs, clamped to the contract maximum', async () => {
	const short = await setup(profileOf({keepAliveMs: 1_000}), {}, 5 * 60_000);
	await short.turn('hi');
	let closed = 0;
	short.chats[0]!.close = () => void closed++;
	await new Promise(r => setTimeout(r, 1_300));
	assert.equal(closed, 1);
	const long = await setup(profileOf({keepAliveMs: 1_800_000}), {}, 1_000);
	await long.turn('hi');
	let alive = 0;
	long.chats[0]!.close = () => void alive++;
	await new Promise(r => setTimeout(r, 1_300));
	assert.equal(alive, 0);
	long.engine.session.close();
});

test('the agent-call cap resets when the user sends a message, not on a turn end', async () => {
	const s = await setup(profileOf({turnAgentCalls: 1}));
	await s.turn('first');
	const call = {subagent_type: 'ada', prompt: 'x'};
	assert.equal(decision(await s.agentCall(call)), 'allow');
	assert.equal(decision(await s.agentCall(call)), 'deny');
	s.chats[0]!.emit({type: 'result', subtype: 'success', is_error: false, result: 'more', session_id: 'sess-1'});
	await settle();
	assert.equal(decision(await s.agentCall(call)), 'deny');
	await s.turn('second');
	assert.equal(decision(await s.agentCall(call)), 'allow');
});

test('the hook refuses agents outside the profile and rewrites an allowed call to a named foreground one', async () => {
	const s = await setup(profileOf());
	await s.turn('hi');
	assert.equal(decision(await s.agentCall({subagent_type: 'general-purpose', prompt: 'x'})), 'deny');
	const out = (await s.agentCall({subagent_type: 'bo', prompt: 'x', model: 'opus', run_in_background: true})) as {
		hookSpecificOutput: {updatedInput: Record<string, unknown>};
	};
	assert.deepEqual(out.hookSpecificOutput.updatedInput, {subagent_type: 'bo', prompt: 'x', name: 'bo', run_in_background: false});
});
