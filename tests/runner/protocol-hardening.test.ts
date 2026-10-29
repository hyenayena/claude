import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDecoder, encodeFrame, MAX_FRAME_BYTES, ProtocolError, validateFrame, type ClientFrame} from '../../src/runner/protocol.js';

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const SNAP = {
	v: 1, type: 'snapshot', state: 'idle', mode: 'default', needsNewSession: false,
	pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1,
};

test('a multi-byte character split across chunks is decoded intact', () => {
	const wire = Buffer.from(encodeFrame({v: 1, type: 'send', text: '日本語 😀'} as ClientFrame));
	const cut = wire.indexOf(Buffer.from('本')) + 1;
	const dec = createDecoder('toRunner');
	const out = [...dec.push(wire.subarray(0, cut)), ...dec.push(wire.subarray(cut))];
	assert.deepEqual(out, [{v: 1, type: 'send', text: '日本語 😀'}]);
});

test('an oversize frame built up over many chunks fails without a newline', () => {
	const dec = createDecoder('toRunner');
	const chunk = Buffer.alloc(256 * 1024, 0x61);
	assert.throws(() => {
		for (let i = 0; i < 6; i++) dec.push(chunk);
	}, ProtocolError);
});

test('a frame of exactly the limit passes and one byte more fails', () => {
	const overhead = Buffer.byteLength(JSON.stringify({v: 1, type: 'send', text: ''}));
	const text = 'x'.repeat(MAX_FRAME_BYTES - overhead);
	const ok = createDecoder('toRunner').push(line({v: 1, type: 'send', text}));
	assert.equal(ok.length, 1);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'send', text: `${text}x`})), ProtocolError);
});

test('wrong or missing version fails in both directions, also for unknown types', () => {
	for (const dir of ['toRunner', 'toClient'] as const) {
		for (const bad of [{type: 'nope'}, {v: '1', type: 'nope'}, {v: 0, type: 'status'}, {v: 1}, {v: 1, type: 5}]) {
			assert.throws(() => createDecoder(dir).push(line(bad)), ProtocolError, JSON.stringify(bad));
		}
	}
});

test('types that exist on Object.prototype are unknown, not handlers', () => {
	for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
		assert.equal(validateFrame({v: 1, type}, 'toRunner'), null);
		assert.equal(validateFrame({v: 1, type}, 'toClient'), null);
	}
});

test('a client cannot send runner-only frames and a runner cannot send client-only ones', () => {
	assert.deepEqual(createDecoder('toRunner').push(line({v: 1, type: 'bridgeRun', id: 'a', line: 'exit', timeoutMs: 1})), []);
	assert.deepEqual(createDecoder('toRunner').push(line({v: 1, type: 'bridgeAsk', id: 'a', request: {}})), []);
	assert.deepEqual(createDecoder('toClient').push(line({v: 1, type: 'open', open: {fresh: true}, tuning: {}, keep: true})), []);
	assert.deepEqual(createDecoder('toClient').push(line({v: 1, type: 'bridgeConfirm', id: 'a', ok: true})), []);
	assert.deepEqual(createDecoder('toClient').push(line({v: 1, type: 'stop'})), []);
});

test('unknown fields are stripped from snapshots, bridge frames and status replies', () => {
	const [snap] = createDecoder('toClient').push(line({...SNAP, extra: 1, queued: ['a']}));
	assert.deepEqual(snap, {...SNAP, queued: ['a']});
	const [run] = createDecoder('toClient').push(line({v: 1, type: 'bridgeRun', id: 'a', line: 'help', timeoutMs: 5, sneaky: true}));
	assert.deepEqual(run, {v: 1, type: 'bridgeRun', id: 'a', line: 'help', timeoutMs: 5});
	const [approved] = createDecoder('toClient').push(line({v: 1, type: 'bridgeRun', id: 'a', line: 'exit', timeoutMs: 5, approved: true}));
	assert.deepEqual(approved, {v: 1, type: 'bridgeRun', id: 'a', line: 'exit', timeoutMs: 5, approved: true});
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bridgeRun', id: 'a', line: 'exit', timeoutMs: 5, approved: 'yes'})), ProtocolError);
	const [conf] = createDecoder('toRunner').push(line({v: 1, type: 'bridgeConfirm', id: 'a', ok: true, also: 1}));
	assert.deepEqual(conf, {v: 1, type: 'bridgeConfirm', id: 'a', ok: true});
});

test('invalid snapshots are rejected', () => {
	for (const bad of [
		{...SNAP, state: 'zombie'},
		{...SNAP, mode: 'bypassPermissions'},
		{...SNAP, queued: Array.from({length: 17}, () => 'x')},
		{...SNAP, queued: [5]},
		{...SNAP, startedAt: 'now'},
		{...SNAP, pendingPermissions: Array.from({length: 101}, () => ({}))},
		{...SNAP, tasks: 'none'},
	]) {
		assert.throws(() => createDecoder('toClient').push(line(bad)), ProtocolError, JSON.stringify(bad).slice(0, 80));
	}
});

test('bridge and answer frames reject empty or oversize ids and over-long lines', () => {
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bridgeRun', id: '', line: 'x', timeoutMs: 1})), ProtocolError);
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bridgeAbort', id: 'x'.repeat(257)})), ProtocolError);
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bridgeRun', id: 'a', line: 'x'.repeat(4097), timeoutMs: 1})), ProtocolError);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'bridgeConfirm', id: 'a', ok: 'yes'})), ProtocolError);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'bridgeResult', id: 'a', result: {status: 'maybe'}})), ProtocolError);
});

test('a log frame keeps only primitive fields, caps them, and cannot pollute prototypes', () => {
	const wire = `{"v":1,"type":"log","level":"warn","msg":"m","fields":{"__proto__":"x","a":"${'y'.repeat(2000)}","n":1,"o":{"deep":1},"arr":[1]}}\n`;
	const [f] = createDecoder('toClient').push(wire) as Array<{fields: Record<string, unknown>}>;
	assert.equal((f!.fields.a as string).length, 1024);
	assert.equal(f!.fields.n, 1);
	assert.equal('o' in f!.fields, false);
	assert.equal('arr' in f!.fields, false);
	assert.equal(Object.getPrototypeOf(f!.fields), Object.prototype);
	assert.equal(({} as Record<string, unknown>).deep, undefined);
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'log', level: 'trace', msg: 'm'})), ProtocolError);
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'log', level: 'info', msg: 'x'.repeat(4097)})), ProtocolError);
});

test('a bye reason is capped at 1 KiB and must be a string', () => {
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bye', reason: 'x'.repeat(1025)})), ProtocolError);
	assert.throws(() => createDecoder('toClient').push(line({v: 1, type: 'bye', reason: {a: 1}})), ProtocolError);
});

test('hello only accepts the two roles', () => {
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'hello', role: 'admin'})), ProtocolError);
	assert.deepEqual(createDecoder('toRunner').push(line({v: 1, type: 'hello', role: 'control'})), [{v: 1, type: 'hello', role: 'control'}]);
});

test('queue and send enforce their limits', () => {
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'queue', lines: Array.from({length: 17}, () => 'x')})), ProtocolError);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'queue', lines: [1]})), ProtocolError);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'open', open: {fresh: 'yes'}, tuning: {}, keep: true})), ProtocolError);
	assert.throws(() => createDecoder('toRunner').push(line({v: 1, type: 'open', open: {fresh: true}, tuning: {}})), ProtocolError);
});
