import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDecoder, encodeFrame, MAX_FRAME_BYTES, ProtocolError, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {parseTodos} from '../../src/deps/chat.js';

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;

test('a client frame round-trips through the encoder and a chunked decoder', () => {
	const frame: ClientFrame = {v: 1, type: 'send', text: 'héllo\nworld', command: true};
	const wire = Buffer.from(encodeFrame(frame));
	const dec = createDecoder('toRunner');
	const out = [...dec.push(wire.subarray(0, 7)), ...dec.push(wire.subarray(7))];
	assert.deepEqual(out, [frame]);
});

test('several frames in one chunk, empty lines ignored, unknown types dropped', () => {
	const dec = createDecoder('toRunner');
	const out = dec.push(line({v: 1, type: 'interrupt'}) + '\n' + line({v: 1, type: 'nope'}) + line({v: 1, type: 'status'}));
	assert.deepEqual(out.map(f => f.type), ['interrupt', 'status']);
});

test('a steer frame and a steer-failed event round-trip', () => {
	const steer: ClientFrame = {v: 1, type: 'steer', text: 'also this'};
	assert.deepEqual(createDecoder('toRunner').push(Buffer.from(encodeFrame(steer))), [steer]);
	const failed: RunnerFrame = {v: 1, type: 'event', event: {type: 'steer-failed', text: 'too late'}};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(failed))), [failed]);
	const result: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'result', ok: true, subtype: 'success', queuedTurns: 1}}};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(result))), [result]);
});

test('unknown fields are dropped from known frames', () => {
	const [f] = createDecoder('toRunner').push(line({v: 1, type: 'setMode', mode: 'plan', extra: 1}));
	assert.deepEqual(f, {v: 1, type: 'setMode', mode: 'plan'});
});

test('invalid frames throw and keep failing', () => {
	for (const bad of [
		'not json\n',
		'[]\n',
		line({type: 'interrupt'}),
		line({v: 2, type: 'interrupt'}),
		line({v: 1, type: 'setMode', mode: 'bypass'}),
		line({v: 1, type: 'send', text: 5}),
		line({v: 1, type: 'rpc', id: 'a', op: 'rm', args: {}}),
		line({v: 1, type: 'answer', id: 'a', decision: {kind: 'allow-all'}}),
	]) {
		const dec = createDecoder('toRunner');
		assert.throws(() => dec.push(bad), ProtocolError);
		assert.throws(() => dec.push(line({v: 1, type: 'status'})), ProtocolError);
	}
});

test('direction matters: a runner frame is unknown to the runner', () => {
	const out = createDecoder('toRunner').push(line({v: 1, type: 'bye', reason: 'x'}));
	assert.deepEqual(out, []);
	const [bye] = createDecoder('toClient').push(line({v: 1, type: 'bye', reason: 'x'}));
	assert.deepEqual(bye, {v: 1, type: 'bye', reason: 'x'});
});

test('an oversize frame fails with or without a newline; the encoder refuses it too', () => {
	assert.throws(() => createDecoder('toRunner').push(Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)), ProtocolError);
	const big = line({v: 1, type: 'send', text: 'x'.repeat(MAX_FRAME_BYTES)});
	assert.throws(() => createDecoder('toRunner').push(big), ProtocolError);
	assert.throws(() => encodeFrame({v: 1, type: 'send', text: 'x'.repeat(MAX_FRAME_BYTES)}), ProtocolError);
});

test('open.apiKeyOnly is a boolean or absent', () => {
	const dec = () => createDecoder('toRunner');
	const open = (extra: object) => line({v: 1, type: 'open', open: {fresh: true, ...extra}, tuning: {}, keep: false});
	assert.deepEqual((dec().push(open({apiKeyOnly: true}))[0] as {open: object}).open, {fresh: true, apiKeyOnly: true});
	assert.deepEqual((dec().push(open({apiKeyOnly: false}))[0] as {open: object}).open, {fresh: true, apiKeyOnly: false});
	assert.deepEqual((dec().push(open({}))[0] as {open: object}).open, {fresh: true});
	for (const bad of ['yes', 1, {}]) assert.throws(() => dec().push(open({apiKeyOnly: bad})), ProtocolError, JSON.stringify(bad));
});

test('open, applyLive and stateUpdate frames keep only known fields', () => {
	const dec = createDecoder('toRunner');
	const [open, patch] = dec.push(
		line({v: 1, type: 'open', open: {fresh: true, model: 'opus', x: 1}, tuning: {effort: 'high', bogus: true}, keep: false}) +
			line({v: 1, type: 'applyLive', patch: {model: null, fastMode: true}}),
	);
	assert.deepEqual(open, {v: 1, type: 'open', open: {fresh: true, model: 'opus'}, tuning: {effort: 'high'}, keep: false});
	assert.deepEqual(patch, {v: 1, type: 'applyLive', patch: {model: null, fastMode: true}});
	const [upd] = createDecoder('toClient').push(line({v: 1, type: 'stateUpdate', patch: {lastSessionId: 's', chatModel: 'x'}}));
	assert.deepEqual(upd, {v: 1, type: 'stateUpdate', patch: {lastSessionId: 's'}});
});

test('a commands frame keeps nested subcommands up to three levels and rejects deeper ones', () => {
	const leaf = {name: 'c', aliases: [], usage: 'x a b c', description: 'c', policy: 'deny'};
	const nested = {name: 'a', aliases: ['A'], usage: 'x a', description: 'a', policy: 'confirm', subcommands: [{name: 'b', aliases: [], usage: 'x a b', description: 'b', policy: 'safe', subcommands: [leaf]}]};
	const frame: ClientFrame = {v: 1, type: 'commands', list: [{name: 'x', description: 'x', policy: 'safe', subcommands: [nested]}]} as ClientFrame;
	assert.deepEqual(createDecoder('toRunner').push(Buffer.from(encodeFrame(frame))), [frame]);
	const tooDeep = {...leaf, subcommands: [{...leaf, name: 'd'}]};
	const deeper = {v: 1, type: 'commands', list: [{name: 'x', description: 'x', policy: 'safe', subcommands: [{...nested, subcommands: [{...nested.subcommands[0], subcommands: [tooDeep]}]}]}]};
	assert.throws(() => createDecoder('toRunner').push(line(deeper)), ProtocolError);
	const badPolicy = {v: 1, type: 'commands', list: [{name: 'x', description: 'x', policy: 'safe', subcommands: [{...nested, subcommands: [{...leaf, policy: 'yes'}]}]}]};
	assert.throws(() => createDecoder('toRunner').push(line(badPolicy)), ProtocolError);
});

test('snapshot tasks keep their tool use id and subagent type', () => {
	const task = {id: 't1', status: 'running', description: 'd', background: false, startedAt: 1, taskType: 'local_agent', toolUseId: 'tu', subagentType: 'Explore'};
	const snap = {v: 1, type: 'snapshot', state: 'idle', mode: 'default', needsNewSession: false, pendingPermissions: [], tasks: [task], commands: [], queued: [], startedAt: 1};
	const [back] = createDecoder('toClient').push(line(snap)) as unknown as [{tasks: unknown[]}];
	assert.deepEqual(back.tasks, [task]);
	assert.throws(() => createDecoder('toClient').push(line({...snap, tasks: [{...task, toolUseId: 'x'.repeat(257)}]})), ProtocolError);
});

test('a setTier frame crosses for a tier or auto; anything else is rejected', () => {
	for (const tier of ['light', 'standard', 'strong', 'max', 'auto'] as const) {
		const frame: ClientFrame = {v: 1, type: 'setTier', tier};
		assert.deepEqual(createDecoder('toRunner').push(Buffer.from(encodeFrame(frame))), [frame]);
	}
	for (const tier of ['MAX', 'huge', 3, undefined]) {
		assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'setTier', tier})), ProtocolError, String(tier));
	}
});

test('a snapshot carries the route, validated the same way', () => {
	const snap = {v: 1, type: 'snapshot', state: 'idle', mode: 'default', needsNewSession: false, pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1};
	const route = {outcome: 'pinned', main: 'max', pinned: 'max'};
	const [back] = createDecoder('toClient').push(line({...snap, route})) as unknown as [{route: unknown}];
	assert.deepEqual(back.route, route);
	const [none] = createDecoder('toClient').push(line(snap)) as unknown as [{route?: unknown}];
	assert.equal(none.route, undefined);
	assert.throws(() => createDecoder('toClient').push(line({...snap, route: {outcome: 'rated', main: 'giant'}})), ProtocolError);
});

const toClient = (o: unknown) => createDecoder('toClient').push(Buffer.from(line({v: 1, ...(o as object)})));

test('a turn-end summary at the caps (200 long escaped paths, largest numbers) fits one frame and parses', () => {
	const files = Array.from({length: 200}, (_, i) => ({path: `/${String(i).padStart(4, '0')}${'ä"\\'.repeat(340)}`.slice(0, 1024), added: 1_000_000_000, removed: 1_000_000_000}));
	const full = {durationMs: 604_800_000, tools: 1_000_000_000, files, filesTotal: 1_000_000_000, added: 1_000_000_000, removed: 1_000_000_000, outputTokens: 1_000_000_000};
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'turn-end', outcome: 'error', error: 'e'.repeat(20_000), summary: full}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
});

const SNAPSHOT_BODY = {state: 'idle', mode: 'default', needsNewSession: false, pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1};
const planItems = [{id: '1', content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress'}, {content: 'Docs', status: 'pending'}];

test('the snapshot plan round-trips and is optional', () => {
	const snap = {...SNAPSHOT_BODY, plan: planItems};
	assert.deepEqual((toClient({type: 'snapshot', ...snap})[0] as {plan?: unknown}).plan, planItems);
	assert.equal((toClient({type: 'snapshot', ...SNAPSHOT_BODY})[0] as {plan?: unknown}).plan, undefined);
	const ctx = {...SNAPSHOT_BODY, context: {used: 5000, limit: 160_000}};
	assert.deepEqual((toClient({type: 'snapshot', ...ctx})[0] as {context?: unknown}).context, ctx.context);
	assert.throws(() => toClient({type: 'snapshot', ...SNAPSHOT_BODY, context: {used: 2e8}}), ProtocolError);
});

test('a bad snapshot plan fails the frame', () => {
	assert.throws(() => toClient({type: 'snapshot', ...SNAPSHOT_BODY, plan: [{content: 'x', status: 'bogus'}]}), ProtocolError);
});

test('an event frame runs chat\'s reader: an unknown ui kind drops the frame, a ContractError becomes a ProtocolError', () => {
	const dec = createDecoder('toClient');
	const out = dec.push(Buffer.from(line({v: 1, type: 'event', event: {type: 'ui', event: {kind: 'from-the-future', x: 1}}}) + line({v: 1, type: 'event', event: {type: 'state', state: 'idle'}})));
	assert.deepEqual(out.map(f => f.type), ['event']);
	assert.throws(() => toClient({type: 'event', event: {type: 'ui', event: {kind: ''}}}), {name: 'ProtocolError', message: 'Invalid frame: ui event kind'});
	assert.throws(() => toClient({type: 'event', event: {type: 'turn-end', outcome: 'bogus'}}), {name: 'ProtocolError', message: 'Invalid frame: outcome is not valid'});
	const answer = (decision: unknown) => createDecoder('toRunner').push(line({v: 1, type: 'answer', id: 'a', decision}));
	assert.deepEqual(answer({kind: 'allow'}), [{v: 1, type: 'answer', id: 'a', decision: {kind: 'allow'}}]);
	assert.throws(() => answer({kind: 'allow-all'}), {name: 'ProtocolError', message: 'Invalid frame: decision kind'});
});

test('whatever the model puts in plan items, the clipped plan is a frame the client accepts', () => {
	const hostile = ['\u{1F600}'.repeat(900), '漢'.repeat(900), '"\\'.repeat(900), '\u001b[31m\u0007\u0000'.repeat(300) + 'x', 'é'.repeat(900), '‍'.repeat(900) + 'y'];
	const todos = Array.from({length: 80}, (_, n) => ({content: hostile[n % hostile.length], activeForm: hostile[(n + 1) % hostile.length], status: 'in_progress'}));
	const items = parseTodos({todos});
	assert.ok(items.length > 20 && items.length <= 50);
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'plan', items}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
	const snap = {v: 1, type: 'snapshot', ...SNAPSHOT_BODY, plan: items};
	assert.equal(createDecoder('toClient').push(Buffer.from(line(snap))).length, 1);
});
