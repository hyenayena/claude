import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {ChatSession, type RouteResult} from '../../src/chat/chat-session.js';
import type {ChatEvent} from '../../src/deps/chat.js';
import type {CacheInfo} from '../../src/chat/router.js';
import type {ChatQueryFn} from '../../src/types.js';
import {makeFakeLog} from '../helpers/fake-log.js';

class FakeQuery {
	readonly order: string[] = [];
	readonly sent: SDKUserMessage[] = [];
	interrupts = 0;
	setModelImpl: () => Promise<void> = () => Promise.resolve();
	private buf: SDKMessage[] = [];
	private wake: (() => void) | undefined;
	private ended = false;

	constructor(prompt: AsyncIterable<SDKUserMessage>) {
		void (async () => {
			for await (const m of prompt) {
				this.sent.push(m);
				this.order.push(`push:${String(m.message.content)}`);
			}
		})();
	}
	async setModel(model?: string): Promise<void> {
		this.order.push(`model:${model ?? 'default'}`);
		await this.setModelImpl();
		this.order.push('model-done');
	}
	async applyFlagSettings(flags: Record<string, unknown>): Promise<void> {
		this.order.push(`flags:${JSON.stringify(flags)}`);
	}
	interrupt(): Promise<void> {
		this.interrupts++;
		this.order.push('interrupt');
		return Promise.resolve();
	}
	emit(msg: unknown): void {
		this.buf.push(msg as SDKMessage);
		this.wake?.();
	}
	close(): void {
		this.ended = true;
		this.wake?.();
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
		for (;;) {
			const m = this.buf.shift();
			if (m) {
				yield m;
				continue;
			}
			if (this.ended) return;
			await new Promise<void>(r => {
				this.wake = r;
			});
		}
	}
}

type RouteFn = NonNullable<ConstructorParameters<typeof ChatSession>[0]['route']>;

const setup = (route?: RouteFn, extra: {routeGuardMs?: number; onReset?: () => void} = {}) => {
	const queries: FakeQuery[] = [];
	const query: ChatQueryFn = p => {
		const q = new FakeQuery(p.prompt);
		queries.push(q);
		return q as never;
	};
	const session = new ChatSession({
		query,
		buildOptions: () => ({}) as Options,
		redact: s => s,
		log: makeFakeLog(),
		...(route && {route}),
		...extra,
	});
	const events: ChatEvent[] = [];
	session.subscribe(e => events.push(e));
	return {session, queries, events};
};

const tick = () => new Promise<void>(r => setImmediate(r));
const settle = async () => {
	for (let i = 0; i < 5; i++) await tick();
};
const deferred = <T>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>(r => {
		resolve = r;
	});
	return {promise, resolve};
};

test('the routed model is set and awaited before the message is pushed', async () => {
	const gate = deferred<void>();
	const {session, queries, events} = setup(async ({started}) => {
		started();
		return {apply: {model: 'opus', effort: 'high'}, info: {outcome: 'rated', main: 'strong', rated: 'strong'}, previous: 'standard'};
	});
	session.send('hello');
	const q = queries[0]!;
	q.setModelImpl = () => gate.promise;
	await settle();
	assert.deepEqual(q.order, ['model:opus']);
	gate.resolve();
	await settle();
	assert.deepEqual(q.order, ['model:opus', 'model-done', 'flags:{"effortLevel":"high"}', 'push:hello']);
	const kinds = events.map(e => e.type);
	assert.ok(kinds.indexOf('sent') < kinds.indexOf('route-start') && kinds.indexOf('route-start') < kinds.indexOf('route'));
	const route = events.find(e => e.type === 'route');
	assert.deepEqual(route, {type: 'route', route: {outcome: 'rated', main: 'strong', rated: 'strong'}, previous: 'standard', source: 'message'});
	assert.deepEqual(session.route, {outcome: 'rated', main: 'strong', rated: 'strong'});
});

test('the route callback gets the text and the cache state', async () => {
	let seen: {text: string; cache: CacheInfo} | undefined;
	const {session, queries} = setup(async ({text, cache}) => {
		seen = {text, cache};
		return undefined;
	});
	session.send('hi');
	await settle();
	assert.deepEqual(seen, {text: 'hi', cache: {sessionKnown: false}});
	queries[0]!.emit({type: 'system', subtype: 'init', session_id: 's1', model: 'm'});
	queries[0]!.emit({type: 'assistant', parent_tool_use_id: null, message: {id: 'a1', role: 'assistant', content: [], usage: {input_tokens: 5, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 1}}});
	queries[0]!.emit({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1'});
	await settle();
	session.send('again');
	await settle();
	assert.equal(seen?.cache.sessionKnown, true);
	assert.equal(seen?.cache.lastContext, 115);
	assert.equal(typeof seen?.cache.lastMainAt, 'number');
});

test('a route that hangs past the guard still pushes the message, without applying', async () => {
	let aborted = false;
	const {session, queries, events} = setup(
		({signal}) =>
			new Promise<RouteResult>(() => {
				signal.addEventListener('abort', () => {
					aborted = true;
				});
			}),
		{routeGuardMs: 20},
	);
	session.send('slow');
	await new Promise(r => setTimeout(r, 60));
	assert.deepEqual(queries[0]!.order, ['push:slow']);
	assert.ok(aborted, 'the route is aborted at the guard');
	assert.deepEqual(events.find(e => e.type === 'route'), {type: 'route', route: {outcome: 'off'}, source: 'message'});
});

test('no info from the route still sends a route event with outcome off', async () => {
	const {session, queries, events} = setup(async () => undefined);
	session.send('x');
	await settle();
	assert.deepEqual(queries[0]!.order, ['push:x']);
	assert.equal(events.some(e => e.type === 'route-start'), false, 'route-start only when the callback starts rating');
	assert.deepEqual(events.find(e => e.type === 'route'), {type: 'route', route: {outcome: 'off'}, source: 'message'});
});

test('an interrupt during routing pushes the message without applying, then interrupts', async () => {
	const {session, queries} = setup(
		({signal}) =>
			new Promise<RouteResult>(resolve => {
				signal.addEventListener('abort', () => resolve({apply: {model: 'opus'}, info: {outcome: 'rated', rated: 'max', main: 'max'}}));
			}),
	);
	session.send('go');
	await settle();
	await session.interrupt();
	await settle();
	assert.deepEqual(queries[0]!.sent.map(m => m.message.content), ['go']);
	assert.equal(queries[0]!.interrupts, 1);
	assert.equal(queries[0]!.order.some(o => o.startsWith('model:')), false);
});

test('a steer during routing goes after the main message', async () => {
	const gate = deferred<RouteResult | undefined>();
	const {session, queries, events} = setup(() => gate.promise);
	session.send('main');
	await settle();
	session.steer('extra');
	assert.equal(events.filter(e => e.type === 'sent').length, 2);
	gate.resolve(undefined);
	await settle();
	assert.deepEqual(queries[0]!.order, ['push:main', 'push:extra']);
	assert.equal(queries[0]!.sent[1]!.priority, 'next');
});

test('closing during routing pushes nothing', async () => {
	const gate = deferred<RouteResult | undefined>();
	const {session, queries} = setup(() => gate.promise);
	session.send('main');
	await settle();
	session.close();
	gate.resolve({apply: {model: 'opus'}, info: {outcome: 'rated', rated: 'max'}});
	await settle();
	assert.deepEqual(queries[0]!.order, []);
});

test('slash commands are never routed', async () => {
	let calls = 0;
	const {session, queries} = setup(async () => {
		calls++;
		return undefined;
	});
	session.send('/compact');
	await settle();
	assert.equal(calls, 0);
	assert.deepEqual(queries[0]!.order, ['push:/compact']);
});

test('applyRoute applies live and emits a command route; reset clears it', async () => {
	let resets = 0;
	const {session, queries, events} = setup(async () => undefined, {
		onReset: () => {
			resets++;
		},
	});
	session.send('x');
	await settle();
	queries[0]!.emit({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1'});
	await settle();
	session.applyRoute({model: 'opus', effort: 'high'}, {outcome: 'pinned', main: 'max', pinned: 'max'}, 'standard');
	await settle();
	assert.ok(queries[0]!.order.includes('model:opus'));
	assert.ok(queries[0]!.order.includes('flags:{"effortLevel":"high"}'));
	assert.deepEqual(events.at(-1), {type: 'route', route: {outcome: 'pinned', main: 'max', pinned: 'max'}, previous: 'standard', source: 'command'});
	assert.equal(session.route?.pinned, 'max');
	session.reset();
	assert.equal(session.route, undefined);
	assert.equal(resets, 1);
});

test('without a route callback the order is unchanged', async () => {
	const {session, queries, events} = setup();
	session.send('plain');
	await settle();
	assert.deepEqual(queries[0]!.order, ['push:plain']);
	assert.equal(events.some(e => e.type === 'route' || e.type === 'route-start'), false);
});

test('a route cut by the guard keeps the earlier tier instead of clearing it', async () => {
	let n = 0;
	const {session, queries, events} = setup(
		() => (++n === 1 ? Promise.resolve({info: {outcome: 'rated', main: 'strong', rated: 'standard', held: true}}) : new Promise<RouteResult>(() => {})),
		{routeGuardMs: 20},
	);
	session.send('one');
	await settle();
	queries[0]!.emit({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1'});
	await settle();
	session.send('two');
	await new Promise(r => setTimeout(r, 60));
	assert.deepEqual(events.filter(e => e.type === 'route').at(-1), {type: 'route', route: {outcome: 'kept', main: 'strong', rated: 'standard'}, source: 'message'});
	assert.deepEqual(session.route, {outcome: 'kept', main: 'strong', rated: 'standard'});
});

test('settled reports whether the switch was applied', async () => {
	const seen: boolean[] = [];
	const {session, queries} = setup(async () => ({apply: {model: 'opus'}, info: {outcome: 'rated', main: 'strong', rated: 'strong'}, settled: ok => void seen.push(ok)}));
	session.send('one');
	queries[0]!.setModelImpl = () => Promise.reject(new Error('no'));
	await settle();
	assert.deepEqual(seen, [false]);
	assert.deepEqual(queries[0]!.order.filter(o => o.startsWith('push:')), ['push:one']);
	queries[0]!.emit({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1'});
	await settle();
	queries[0]!.setModelImpl = () => Promise.resolve();
	session.send('two');
	await settle();
	assert.deepEqual(seen, [false, true]);
	const pinned: boolean[] = [];
	session.applyRoute({model: 'haiku'}, {outcome: 'pinned', main: 'light', pinned: 'light'}, undefined, ok => void pinned.push(ok));
	await settle();
	assert.deepEqual(pinned, [true]);
});
