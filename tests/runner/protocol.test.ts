import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDecoder, encodeFrame, MAX_FRAME_BYTES, ProtocolError, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';

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

test('an account switch event crosses the protocol; an unknown reason does not', () => {
	const frame: RunnerFrame = {v: 1, type: 'event', event: {type: 'account', account: 'spare', previous: 'work', reason: 'usage-limit'}};
	const [back] = createDecoder('toClient').push(encodeFrame(frame));
	assert.deepEqual(back, frame);
	const broken = {v: 1, type: 'event', event: {type: 'account', account: 'spare', previous: 'work', reason: 'other'}};
	assert.throws(() => createDecoder('toClient').push(line(broken)), ProtocolError);
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
