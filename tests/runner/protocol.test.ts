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

test('a runner event with a permission request is validated and rebuilt', () => {
	const frame: RunnerFrame = {
		v: 1,
		type: 'event',
		event: {
			type: 'permission-requested',
			pending: 1,
			request: {
				kind: 'tool',
				id: 'p1',
				seq: 1,
				toolName: 'Bash',
				input: {command: 'ls'},
				cwd: '/app',
				highlights: [{level: 'warn', text: 'x'}],
				defaultToNo: false,
				always: {label: 'ls'},
				oversize: false,
			},
		},
	};
	const [back] = createDecoder('toClient').push(encodeFrame(frame));
	assert.deepEqual(back, frame);
	const broken = JSON.parse(JSON.stringify(frame)) as {event: {request: {toolName: string}}};
	broken.event.request.toolName = 'Rm';
	assert.throws(() => createDecoder('toClient').push(line(broken)), ProtocolError);
});

test('an account change event crosses the protocol; an unknown reason does not', () => {
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'account', account: 'spare', previous: 'work', reason: 'changed'}};
	const [back] = createDecoder('toClient').push(encodeFrame(frame));
	assert.deepEqual(back, frame);
	const broken = {v: 1, type: 'event', event: {type: 'account', account: 'spare', previous: 'work', reason: 'other'}};
	assert.throws(() => createDecoder('toClient').push(line(broken)), ProtocolError);
});

test('changed and pinned account events cross the protocol; the retired reasons do not', () => {
	for (const reason of ['changed', 'pinned'] as const) {
		const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'account', account: 'work', previous: 'spare', reason}};
		const [back] = createDecoder('toClient').push(encodeFrame(frame));
		assert.deepEqual(back, frame);
	}
	for (const reason of ['usage-limit', 'billing', 'restored', 'returned']) {
		const old = {v: 1, type: 'event', event: {type: 'account', account: 'work', previous: 'spare', reason}};
		assert.throws(() => createDecoder('toClient').push(line(old)), ProtocolError, reason);
	}
	const broken = {v: 1, type: 'event', event: {type: 'account', account: 'work', previous: 'spare', reason: 'returned'}};
	assert.throws(() => createDecoder('toClient').push(line(broken)), ProtocolError);
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

test('live status events cross the protocol; a bad state does not', () => {
	for (const event of [
		{kind: 'cli-state', state: 'running'},
		{kind: 'thinking-tokens', tokens: 1200},
		{kind: 'tool-input', name: 'Edit'},
		{kind: 'tool-input-delta', chars: 40},
	] as const) {
		const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event}};
		const [back] = createDecoder('toClient').push(encodeFrame(frame));
		assert.deepEqual(back, frame);
	}
	const broken = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'cli-state', state: 'asleep'}}};
	assert.throws(() => createDecoder('toClient').push(line(broken)), ProtocolError);
});

test('a tool-result with a patch round-trips; a bad or oversized patch is rejected', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}], created: true as const};
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-result', toolUseId: 't', isError: false, text: 'ok', patch}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
	const older: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-result', toolUseId: 't', isError: false, text: 'ok'}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(older)), [older]);
	const bad = (p: unknown) => line({v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-result', toolUseId: 't', isError: false, text: 'ok', patch: p}}});
	for (const p of [
		'x',
		{hunks: 'x'},
		{hunks: [{oldStart: -1, newStart: 1, lines: []}]},
		{hunks: [{oldStart: 1, newStart: 1.5, lines: []}]},
		{hunks: [{oldStart: 1, newStart: 1, lines: [1]}]},
		{hunks: [{oldStart: 1, newStart: 1, lines: ['x'.repeat(20_001)]}]},
		{hunks: Array.from({length: 201}, () => ({oldStart: 1, newStart: 1, lines: []}))},
		{hunks: [0, 1, 2].map(() => ({oldStart: 1, newStart: 1, lines: Array.from({length: 700}, () => '+')}))},
		{hunks: [], created: false},
	]) {
		assert.throws(() => createDecoder('toClient').push(bad(p)), ProtocolError, JSON.stringify(p).slice(0, 80));
	}
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

test('an agent-message round-trips with every item type; malformed or oversized items are rejected', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]};
	const frame: RunnerFrame = {
		v: 1,
		type: 'event',
		event: {
			type: 'ui',
			event: {
				kind: 'agent-message',
				agentId: 'agent-1',
				model: 'claude-haiku-4-5',
				items: [
					{type: 'text', text: 'hi'},
					{type: 'thinking', text: 'hmm'},
					{type: 'tool-use', toolUseId: 't1', name: 'Read', input: {file_path: '/x'}},
					{type: 'tool-result', toolUseId: 't1', isError: false, text: 'ok', patch},
				],
			},
		},
	};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
	const plain: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'agent-message', agentId: 'a', items: []}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(plain)), [plain]);
	const withTask: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'agent-message', agentId: 'a', taskId: 'task-1', items: []}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(withTask)), [withTask]);
	const bad = (event: unknown) => line({v: 1, type: 'event', event: {type: 'ui', event}});
	const ok = {kind: 'agent-message', agentId: 'a', items: [{type: 'text', text: 'x'}]};
	for (const event of [
		{...ok, taskId: 7},
		{...ok, taskId: ''},
		{...ok, taskId: 't'.repeat(257)},
		{...ok, agentId: 7},
		{...ok, agentId: 'a'.repeat(257)},
		{...ok, model: 'm'.repeat(257)},
		{...ok, items: 'x'},
		{...ok, items: Array.from({length: 65}, () => ({type: 'text', text: 'x'}))},
		{...ok, items: [{type: 'image', text: 'x'}]},
		{...ok, items: [{type: 'text', text: 3}]},
		{...ok, items: [null]},
		{...ok, items: [{type: 'tool-use', toolUseId: 't'.repeat(257), name: 'Read', input: {}}]},
		{...ok, items: [{type: 'tool-use', toolUseId: 't', name: 'n'.repeat(257), input: {}}]},
		{...ok, items: [{type: 'tool-result', toolUseId: 't', isError: 'no', text: 'x'}]},
		{...ok, items: [{type: 'tool-result', toolUseId: 't', isError: false, text: 'x', patch: {hunks: 'x'}}]},
	]) {
		assert.throws(() => createDecoder('toClient').push(bad(event)), ProtocolError, JSON.stringify(event).slice(0, 80));
	}
});

test('an agent-activity event from an older runner is still read', () => {
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'agent-activity', toolUseId: 'a', name: 'Read', input: {file_path: '/x'}}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
});

test('task events carry the subagent origin fields; bad values are rejected', () => {
	const frame: RunnerFrame = {
		v: 1,
		type: 'event',
		event: {
			type: 'ui',
			event: {kind: 'task', id: 'a2', status: 'running', toolUseId: 'tu', taskType: 'local_agent', subagentType: 'Explore', prompt: 'find it', parentTaskId: 'a1', depth: 1},
		},
	};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
	const bad = (extra: object) => line({v: 1, type: 'event', event: {type: 'ui', event: {kind: 'task', id: 'a2', status: 'running', ...extra}}});
	for (const extra of [{prompt: 'p'.repeat(16 * 1024 + 1)}, {parentTaskId: ''}, {depth: 1.5}, {subagentType: 's'.repeat(257)}, {prompt: 1}]) {
		assert.throws(() => createDecoder('toClient').push(bad(extra)), ProtocolError, JSON.stringify(extra).slice(0, 60));
	}
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

test('route-start and route events cross with every field; bad enums are rejected', () => {
	const start: RunnerFrame = {v: 1, type: 'event', event: {type: 'route-start'}};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(start))), [start]);
	const full: RunnerFrame = {
		v: 1,
		type: 'event',
		event: {type: 'route', route: {outcome: 'rated', main: 'strong', rated: 'standard', newTask: true, held: true}, previous: 'max', source: 'message'},
	};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(full))), [full]);
	const failed: RunnerFrame = {v: 1, type: 'event', event: {type: 'route', route: {outcome: 'kept', failed: true}, source: 'message'}};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(failed))), [failed]);
	const pinned: RunnerFrame = {v: 1, type: 'event', event: {type: 'route', route: {outcome: 'pinned', main: 'max', pinned: 'max'}, source: 'command'}};
	assert.deepEqual(createDecoder('toClient').push(Buffer.from(encodeFrame(pinned))), [pinned]);
	const ev = (route: unknown, extra: Record<string, unknown> = {}) => line({v: 1, type: 'event', event: {type: 'route', route, source: 'message', ...extra}});
	for (const bad of [
		ev({outcome: 'maybe'}),
		ev({outcome: 'rated', main: 'huge'}),
		ev({outcome: 'rated', rated: 'MAX'}),
		ev({outcome: 'pinned', pinned: 1}),
		ev({outcome: 'rated', held: 'yes'}),
		ev({outcome: 'kept', failed: 'true'}),
		ev({outcome: 'rated'}, {previous: 'huge'}),
		ev({outcome: 'rated'}, {source: 'robot'}),
		ev('rated'),
	]) {
		assert.throws(() => createDecoder('toClient').push(bad), ProtocolError, bad);
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

test('preview rows carry oldNo, newNo and count; old frames with only no are still accepted', () => {
	const base = {kind: 'tool', id: 'p1', seq: 1, toolName: 'Edit', input: {}, cwd: '/app', highlights: [], defaultToNo: false, always: false, oversize: false};
	const withRows = (rows: unknown[]) => ({
		v: 1,
		type: 'event',
		event: {type: 'permission-requested', pending: 1, request: {...base, preview: {rows, added: 1, removed: 1, truncated: false, approximate: false}}},
	});
	const rows = [
		{kind: 'gap', text: '... 3 unchanged lines', count: 3},
		{kind: 'del', text: 'a', no: 4, oldNo: 4},
		{kind: 'add', text: 'b', no: 4, newNo: 4},
		{kind: 'ctx', text: 'c', no: 5, oldNo: 5, newNo: 5},
	];
	const [back] = createDecoder('toClient').push(line(withRows(rows)));
	assert.deepEqual((back as {event: {request: {preview: {rows: unknown[]}}}}).event.request.preview.rows, rows);
	const old = [{kind: 'del', text: 'a', no: 4}];
	const [older] = createDecoder('toClient').push(line(withRows(old)));
	assert.deepEqual((older as {event: {request: {preview: {rows: unknown[]}}}}).event.request.preview.rows, old);
	assert.throws(() => createDecoder('toClient').push(line(withRows([{kind: 'add', text: 'x', newNo: 'one'}]))), ProtocolError);
	assert.throws(() => createDecoder('toClient').push(line(withRows([{kind: 'gap', text: '', count: 'x'}]))), ProtocolError);
});

test('tool timing fields round-trip, frames without them stay valid, bad values are rejected', () => {
	const use: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-use', toolUseId: 't', name: 'Bash', input: {}, at: 1_700_000_000_000}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(use)), [use]);
	const result: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-result', toolUseId: 't', isError: false, text: 'ok', durationMs: 1500}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(result)), [result]);
	const older: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'tool-use', toolUseId: 't', name: 'Bash', input: {}}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(older)), [older]);
	const frame = (event: unknown) => line({v: 1, type: 'event', event: {type: 'ui', event}});
	const useWith = (at: unknown) => frame({kind: 'tool-use', toolUseId: 't', name: 'Bash', input: {}, at});
	const resultWith = (durationMs: unknown) => frame({kind: 'tool-result', toolUseId: 't', isError: false, text: 'ok', durationMs});
	for (const at of ['1', -1, {}, true]) {
		assert.throws(() => createDecoder('toClient').push(useWith(at)), ProtocolError, String(at));
	}
	for (const ms of ['1', -1, 604_800_001, {}, [1]]) {
		assert.throws(() => createDecoder('toClient').push(resultWith(ms)), ProtocolError, String(ms));
	}
	assert.deepEqual(createDecoder('toClient').push(resultWith(604_800_000)).length, 1);
	assert.deepEqual(createDecoder('toClient').push(resultWith(0)).length, 1);
});

test('thinking-text duration round-trips, older frames stay valid, bad values are rejected', () => {
	const withMs: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'thinking-text', text: 'hmm', durationMs: 12_000}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(withMs)), [withMs]);
	const older: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'thinking-text', text: 'hmm'}}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(older)), [older]);
	const frame = (durationMs: unknown) => line({v: 1, type: 'event', event: {type: 'ui', event: {kind: 'thinking-text', text: 'hmm', durationMs}}});
	for (const ms of ['1', -1, 86_400_001, {}, [1]]) assert.throws(() => createDecoder('toClient').push(frame(ms)), ProtocolError, String(ms));
	assert.equal(createDecoder('toClient').push(frame(86_400_000)).length, 1);
});

const summary = {durationMs: 61_000, tools: 3, files: [{path: '/p/a.ts', added: 4, removed: 1, created: true as const}], filesTotal: 1, added: 4, removed: 1, outputTokens: 900};
const toClient = (o: unknown) => createDecoder('toClient').push(Buffer.from(line({v: 1, ...(o as object)})));

test('turn-end summary, context event and snapshot context round-trip; old frames still parse', () => {
	const end: RunnerFrame = {v: 1, type: 'event', event: {type: 'turn-end', outcome: 'ok', summary}};
	assert.deepEqual(toClient(end), [end]);
	const ctx: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'context', used: 5000, limit: 160_000}}};
	assert.deepEqual(toClient(ctx), [ctx]);
	const bare: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'context', used: 1}}};
	assert.deepEqual(toClient(bare), [bare]);
	const old: RunnerFrame = {v: 1, type: 'event', event: {type: 'turn-end', outcome: 'ok'}};
	assert.deepEqual(toClient(old), [old]);
});

test('invalid summary and context values fail the frame', () => {
	const bad = (event: unknown) => assert.throws(() => toClient({type: 'event', event}), ProtocolError);
	bad({type: 'turn-end', outcome: 'ok', summary: {...summary, tools: -1}});
	bad({type: 'turn-end', outcome: 'ok', summary: {...summary, durationMs: 'x'}});
	bad({type: 'turn-end', outcome: 'ok', summary: {...summary, files: Array.from({length: 201}, () => summary.files[0])}});
	bad({type: 'turn-end', outcome: 'ok', summary: {...summary, files: [{path: 'x'.repeat(1025), added: 0, removed: 0}]}});
	bad({type: 'turn-end', outcome: 'ok', summary: {...summary, outputTokens: 2e9}});
	bad({type: 'ui', event: {kind: 'context', used: 2e8}});
	bad({type: 'ui', event: {kind: 'context', used: 1, limit: -5}});
	bad({type: 'ui', event: {kind: 'context'}});
});

test('an event with a ui kind this client does not know is dropped, not failed', () => {
	const dec = createDecoder('toClient');
	const out = dec.push(Buffer.from(line({v: 1, type: 'event', event: {type: 'ui', event: {kind: 'from-the-future', x: 1}}}) + line({v: 1, type: 'event', event: {type: 'state', state: 'idle'}})));
	assert.deepEqual(out.map(f => f.type), ['event']);
	assert.throws(() => toClient({type: 'event', event: {type: 'ui', event: {kind: ''}}}), ProtocolError);
	assert.throws(() => toClient({type: 'event', event: {type: 'ui', event: {}}}), ProtocolError);
});

test('a turn-end summary at the caps (200 long escaped paths, largest numbers) fits one frame and parses', () => {
	const files = Array.from({length: 200}, (_, i) => ({path: `/${String(i).padStart(4, '0')}${'ä"\\'.repeat(340)}`.slice(0, 1024), added: 1_000_000_000, removed: 1_000_000_000}));
	const full = {durationMs: 604_800_000, tools: 1_000_000_000, files, filesTotal: 1_000_000_000, added: 1_000_000_000, removed: 1_000_000_000, outputTokens: 1_000_000_000};
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'turn-end', outcome: 'error', error: 'e'.repeat(20_000), summary: full}};
	assert.deepEqual(createDecoder('toClient').push(encodeFrame(frame)), [frame]);
});

const SNAPSHOT_BODY = {state: 'idle', mode: 'default', needsNewSession: false, pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1};
const planItems = [{id: '1', content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress'}, {content: 'Docs', status: 'pending'}];

test('plan event and snapshot plan round-trip; both are optional', () => {
	const ev: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'plan', items: planItems as never}}};
	assert.deepEqual(toClient(ev), [ev]);
	const empty: RunnerFrame = {v: 1, type: 'event', event: {type: 'ui', event: {kind: 'plan', items: []}}};
	assert.deepEqual(toClient(empty), [empty]);
	const snap = {...SNAPSHOT_BODY, plan: planItems};
	assert.deepEqual((toClient({type: 'snapshot', ...snap})[0] as {plan?: unknown}).plan, planItems);
	assert.equal((toClient({type: 'snapshot', ...SNAPSHOT_BODY})[0] as {plan?: unknown}).plan, undefined);
});

test('plan values over the caps or of a bad shape fail the frame', () => {
	const bad = (items: unknown) => assert.throws(() => toClient({type: 'event', event: {type: 'ui', event: {kind: 'plan', items}}}), ProtocolError);
	const one = (patch: object) => [{content: 'x', status: 'pending', ...patch}];
	bad('nope');
	bad(Array.from({length: 51}, () => ({content: 'x', status: 'pending'})));
	bad(one({status: 'done'}));
	bad(one({content: 'x'.repeat(401)}));
	bad(one({content: 5}));
	bad(one({activeForm: 'x'.repeat(401)}));
	bad(one({id: 'x'.repeat(33)}));
	bad([null]);
	assert.throws(() => toClient({type: 'snapshot', ...SNAPSHOT_BODY, plan: one({status: 'bogus'})}), ProtocolError);
	assert.equal(toClient({type: 'event', event: {type: 'ui', event: {kind: 'plan', items: Array.from({length: 50}, () => ({content: 'x'.repeat(400), status: 'pending'}))}}}).length, 1);
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
