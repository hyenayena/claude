import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {HookCallback, Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {createChatEngine} from '../../src/chat/engine.js';
import type {ChatEvent} from '../../src/deps/chat.js';
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

const setup = async (initial: ClaudeState, agents: Record<string, string> = {}) => {
	const root = await mkdtemp(join(tmpdir(), 'claude-engine-route-'));
	const dataDir = join(root, 'data', 'claude');
	const moduleDir = join(root, 'proj', 'modules', 'claude');
	await mkdir(moduleDir, {recursive: true});
	const agentDir = join(root, 'proj', '.claude', 'agents');
	await mkdir(agentDir, {recursive: true});
	for (const [file, head] of Object.entries(agents)) await writeFile(join(agentDir, file), `---\n${head}\n---\nWork.\n`);
	const log = makeFakeLog();
	const vault = hostVault(fakeCredentials(), log);
	const opts: CredentialOpts = {env: {}, dataDir, vault, log};
	await storeSecret(opts, KEY, 'a');
	let state: ClaudeState = {...initial};
	let reads = 0;
	const chats: ChatQ[] = [];
	const classified: {options: Options; prompt: string}[] = [];
	let verdict = '{"continues":false,"rating":"strong"}';
	const query: ChatQueryFn = p => {
		const options = p.options ?? ({} as Options);
		if (options.persistSession === false) {
			const call = {options, prompt: ''};
			classified.push(call);
			const gen = (async function* () {
				for await (const m of p.prompt) {
					call.prompt = String(m.message.content);
					break;
				}
				yield {type: 'result', subtype: 'success', result: verdict, usage: {input_tokens: 50, output_tokens: 5}} as unknown as SDKMessage;
			})();
			return Object.assign(gen, {close: () => {}}) as never;
		}
		const q = new ChatQ(p.prompt, options);
		chats.push(q);
		return q as never;
	};
	const engine = await createChatEngine(
		{fresh: true, model: 'claude-configured', tuning: {effort: 'low'}},
		{
			dataDir,
			moduleDir,
			env: {},
			log,
			vault,
			loadChatQuery: async () => query,
			store: {
				read: async () => {
					reads++;
					await faults.gate;
					return {...state};
				},
			},
			isMissingModule: () => false,
			shellTmp: () => join(root, 'shell'),
			sandboxProblem: () => 'unavailable',
			idleCloseMs: 60_000,
		},
		{stateUpdate: async () => undefined, warn: () => undefined},
	);
	const events: ChatEvent[] = [];
	engine.session.subscribe(e => events.push(e));
	const turn = async (text: string) => {
		engine.session.send(text);
		await settle();
		const q = chats.at(-1)!;
		q.emit({type: 'system', subtype: 'init', session_id: 'sess-1', model: 'm', apiKeySource: 'env'});
		q.emit({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1'});
		await settle();
	};
	const hook = (): HookCallback => (chats.at(-1)!.options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback);
	const agentCall = (tool_input: Record<string, unknown>) =>
		hook()({hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/'} as never, 't', {
			signal: new AbortController().signal,
		});
	return {
		engine,
		chats,
		classified,
		events,
		turn,
		agentCall,
		log,
		setState: (s: ClaudeState) => {
			state = s;
		},
		setVerdict: (v: string) => {
			verdict = v;
		},
		reads: () => reads,
	};
};

const routes = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, {type: 'route'}> => e.type === 'route');

test('router off: no classifier and no model change; only tier-syntax agents are defined and rewritten', async () => {
	const s = await setup(
		{},
		{
			'fixed.md': 'name: fixed\ndescription: d\nmodel: light',
			'ranged.md': 'name: ranged\ndescription: d\nmodel: light/STRONG',
			'concrete.md': 'name: concrete\ndescription: d\nmodel: opus',
			'plain.md': 'name: plain\ndescription: d',
		},
	);
	await s.turn('hello');
	assert.equal(s.classified.length, 0);
	const q = s.chats[0]!;
	assert.deepEqual(Object.keys(q.options.agents ?? {}).sort(), ['fixed', 'ranged']);
	assert.equal(q.options.agents!.ranged!.model, 'opus');
	assert.equal(q.options.agents!.fixed!.model, 'haiku');
	assert.equal(q.options.model, 'claude-configured');
	assert.deepEqual(q.order, ['push:hello']);
	assert.equal(s.events.some(e => e.type === 'route-start'), false);
	assert.deepEqual(routes(s.events).map(e => e.route), [{outcome: 'off'}]);
	const ranged = (await s.agentCall({subagent_type: 'ranged', prompt: 'x'})) as {hookSpecificOutput: {updatedInput: Record<string, unknown>}};
	assert.equal(ranged.hookSpecificOutput.updatedInput.model, 'opus');
	for (const type of ['concrete', 'plain', 'general-purpose']) assert.deepEqual(await s.agentCall({subagent_type: type, prompt: 'x'}), {continue: true}, type);
});

test('no tier-syntax agents and the router off: no agents option at all', async () => {
	const s = await setup({}, {'concrete.md': 'name: concrete\ndescription: d\nmodel: opus'});
	await s.turn('hello');
	assert.equal('agents' in s.chats[0]!.options, false);
});

test('router on: fixed-tier agents become definitions, the classifier rates and the model is set before the push', async () => {
	const s = await setup({chatRouter: 'on', tierStrongModel: 'opus', tierStrongEffort: 'high'}, {'fixed.md': 'name: fixed\ndescription: d\nmodel: light'});
	await s.turn('design the cache layer');
	const q = s.chats[0]!;
	assert.deepEqual(Object.keys(q.options.agents ?? {}), ['fixed']);
	assert.equal(q.options.agents!.fixed!.model, 'haiku');
	assert.equal(s.classified.length, 1);
	assert.equal(s.classified[0]!.options.model, 'haiku');
	assert.match(s.classified[0]!.prompt, /design the cache layer/);
	assert.deepEqual(q.order, ['model:opus', 'flags:{"effortLevel":"high"}', 'push:design the cache layer']);
	assert.ok(s.events.some(e => e.type === 'route-start'));
	assert.deepEqual(routes(s.events).at(-1)!.route, {outcome: 'rated', main: 'strong', rated: 'strong', newTask: true});
	const routed = (await s.agentCall({subagent_type: 'general-purpose', prompt: 'x'})) as {hookSpecificOutput: {updatedInput: Record<string, unknown>}};
	assert.deepEqual(routed.hookSpecificOutput.updatedInput, {subagent_type: 'general-purpose', prompt: 'x', model: 'opus', effort: 'high'});
	const record = s.log.records.find(r => r.msg === 'route');
	assert.deepEqual(
		{outcome: record?.fields.outcome, tier: record?.fields.tier, inTokens: record?.fields.inTokens, outTokens: record?.fields.outTokens},
		{outcome: 'rated', tier: 'strong', inTokens: 50, outTokens: 5},
	);
	assert.ok(!serialized(s.log).includes('design the cache layer'), 'no message text in the log');
});

test('a failed rating keeps the tier and says so', async () => {
	const s = await setup({chatRouter: 'on'});
	s.setVerdict('no idea');
	await s.turn('x');
	assert.deepEqual(routes(s.events).at(-1)!.route, {outcome: 'kept', failed: true});
	assert.deepEqual(s.chats[0]!.order, ['push:x']);
});

test('classifier off: no rating, the main chat routed only when pinned, ranged agents at their default', async () => {
	const s = await setup({chatRouter: 'on', chatClassifier: 'off'}, {'ranged.md': 'name: ranged\ndescription: d\nmodel: standard/STRONG'});
	await s.turn('one');
	assert.equal(s.classified.length, 0);
	assert.deepEqual(s.chats[0]!.order, ['push:one']);
	const high = (await s.agentCall({subagent_type: 'ranged', prompt: 'x'})) as {hookSpecificOutput: {updatedInput: Record<string, unknown>}};
	assert.equal(high.hookSpecificOutput.updatedInput.model, 'opus');
	assert.deepEqual(await s.agentCall({subagent_type: 'general-purpose', prompt: 'x'}), {continue: true});
	s.engine.setTier('light');
	await settle();
	assert.ok(s.chats[0]!.order.includes('model:haiku'));
	assert.deepEqual(routes(s.events).at(-1), {type: 'route', route: {outcome: 'pinned', main: 'light', pinned: 'light'}, source: 'command'});
	const clamped = (await s.agentCall({subagent_type: 'ranged', prompt: 'x'})) as {hookSpecificOutput: {updatedInput: Record<string, unknown>}};
	assert.equal(clamped.hookSpecificOutput.updatedInput.model, 'sonnet');
	await s.turn('two');
	assert.equal(s.classified.length, 0);
	assert.deepEqual(routes(s.events).at(-1)!.route, {outcome: 'pinned', main: 'light', pinned: 'light'});
	s.engine.setTier('auto');
	await s.turn('three');
	assert.ok(s.chats[0]!.order.includes('model:claude-configured'), 'back to the configured model');
});

test('a pin skips the classifier while it is on', async () => {
	const s = await setup({chatRouter: 'on'});
	s.engine.setTier('max');
	await s.turn('anything');
	assert.equal(s.classified.length, 0);
	assert.deepEqual(routes(s.events).at(-1)!.route, {outcome: 'pinned', main: 'max', pinned: 'max'});
	assert.equal(s.chats[0]!.options.model, 'opus', 'the pin reaches the spawn');
	assert.ok(s.log.records.some(r => r.msg === 'tier set' && r.fields.tier === 'max'));
});

test('applyLive drops model and effort while the router governs; the store is read again at every send', async () => {
	const s = await setup({chatRouter: 'on'});
	await s.turn('first');
	const q = s.chats[0]!;
	const before = q.order.length;
	s.engine.applyLive({model: 'sonnet', effort: 'max', fastMode: true});
	await settle();
	assert.deepEqual(q.order.slice(before), ['flags:{"fastMode":true}']);
	const reads = s.reads();
	s.setState({});
	await s.turn('second');
	assert.ok(s.reads() > reads);
	assert.equal(s.classified.length, 1, 'no rating once the router is off');
	assert.ok(q.order.includes('model:sonnet'), 'back to the live model');
	assert.ok(q.order.includes('flags:{"effortLevel":"max"}'));
	assert.deepEqual(routes(s.events).at(-1)!.route, {outcome: 'off'});
	const after = q.order.length;
	s.engine.applyLive({model: 'haiku'});
	await settle();
	assert.deepEqual(q.order.slice(after), ['model:haiku']);
});

test('a failed model switch is retried at the next message instead of being taken for done', async () => {
	const s = await setup({chatRouter: 'on'});
	s.setVerdict('{"continues":false,"rating":"strong"}');
	await s.turn('first');
	const q = s.chats[0]!;
	assert.ok(q.order.includes('model:opus'));
	s.setVerdict('{"continues":false,"rating":"light"}');
	faults.model = 1;
	const before = q.order.length;
	await s.turn('second, cold cache but the switch fails');
	faults.model = 0;
	assert.ok(!q.order.slice(before).includes('model:haiku'), 'the switch did fail');
	await s.turn('third, same rating');
	assert.ok(q.order.slice(before).includes('model:haiku'), 'the chat is still on the old model');
});

test('an interrupt while the router is turned off leaves the chat on the model the engine believes it left', async () => {
	const s = await setup({chatRouter: 'on'});
	await s.turn('first');
	const q = s.chats[0]!;
	assert.ok(q.order.includes('model:opus'));
	s.setState({});
	let release!: () => void;
	faults.gate = new Promise<void>(r => {
		release = r;
	});
	s.engine.session.send('second');
	await settle();
	const interrupting = s.engine.session.interrupt();
	await settle();
	release();
	faults.gate = undefined;
	await interrupting;
	q.emit({type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'sess-1'});
	await settle();
	assert.equal(s.engine.session.state, 'idle');
	await s.turn('third');
	assert.ok(q.order.includes('model:claude-configured'), 'the live model went back to the configured one');
});

test('a pin set while a message is being rated wins over the rating', async () => {
	const s = await setup({chatRouter: 'on'});
	s.setVerdict('{"continues":false,"rating":"light"}');
	s.engine.session.send('quick one');
	s.engine.setTier('max');
	await settle();
	const q = s.chats[0]!;
	assert.deepEqual(routes(s.events).filter(e => e.source === 'message').at(-1)!.route, {outcome: 'pinned', main: 'max', pinned: 'max'});
	assert.ok(!q.order.includes('model:haiku'), 'the rated tier is not applied');
	assert.ok(q.order.includes('model:opus'));
	assert.ok(q.order.indexOf('model:opus') < q.order.indexOf('push:quick one'));
});
