import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, mock, test} from 'node:test';
import type {CommandBridge, CommandRunRequest, CommandRunResult} from '../../../../src/api.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {PERMISSION_IDLE_MS} from '../../src/chat/permission.js';
import {RemoteChatSession, type RemoteOptions} from '../../src/chat/remote-session.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame, type Snapshot} from '../../src/runner/protocol.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SNAPSHOT: Snapshot = {
	state: 'idle', mode: 'default', needsNewSession: false, pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1,
};

let cleanup: Array<() => void> = [];
afterEach(() => {
	mock.timers.reset();
	for (const fn of cleanup.splice(0)) fn();
});

async function fakeRunner(raw?: string) {
	const dir = mkdtempSync(join(tmpdir(), 'remote-h-'));
	const socketPath = join(dir, 'runner.sock');
	const frames: ClientFrame[] = [];
	let conn: net.Socket | undefined;
	const server = net.createServer(s => {
		conn = s;
		const dec = createDecoder('toRunner');
		let greeted = false;
		s.on('data', d => {
			frames.push(...(dec.push(d) as ClientFrame[]));
			if (!greeted && frames.some(f => f.type === 'hello')) {
				greeted = true;
				s.write(raw ?? encodeFrame({v: 1, type: 'snapshot', ...SNAPSHOT} as RunnerFrame));
			}
		});
		s.on('error', () => {});
	});
	await new Promise<void>(r => server.listen(socketPath, r));
	cleanup.push(() => {
		conn?.destroy();
		server.close();
		rmSync(dir, {recursive: true, force: true});
	});
	const send = (f: {type: string; [k: string]: unknown}) => conn!.write(encodeFrame({v: 1, ...f} as unknown as RunnerFrame));
	const until = async (pred: () => boolean) => {
		for (let i = 0; i < 300 && !pred(); i++) await new Promise<void>(r => setTimeout(r, 10));
		assert.ok(pred(), 'condition not reached');
	};
	return {socketPath, frames, send, until, sendRaw: (t: string) => conn!.write(t), drop: () => conn?.destroy()};
}

// Real timers are mocked in some tests, so polling there must not use setTimeout.
const immediately = async (pred: () => boolean) => {
	for (let i = 0; i < 2000 && !pred(); i++) await new Promise(res => setImmediate(res));
	assert.ok(pred(), 'condition not reached');
};

const connect = (socketPath: string, extra: Partial<RemoteOptions> = {}) =>
	RemoteChatSession.connect({socketPath, cwd: '/x', stateUpdate: async () => {}, ...extra});

const okResult: CommandRunResult = {status: 'ok', output: '', truncated: false, ms: 1};
const confirming = (seen: Array<boolean | undefined>): CommandBridge => ({
	list: () => [],
	run: async (req: CommandRunRequest) => {
		seen.push(await req.confirm?.({line: req.line, command: 'x', caller: 'claude'}));
		return okResult;
	},
});

test('a bridgeRun whose id was never approved shows its own prompt and is not auto-confirmed', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeRun', id: 'never-asked', line: 'exit', timeoutMs: 1000});
	await r.until(() => s.pendingPermissions.length === 1);
	assert.deepEqual(seen, []);
	assert.equal(r.frames.some(f => f.type === 'bridgeConfirm'), false);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'deny'});
	await r.until(() => seen.length === 1);
	assert.deepEqual(seen, [false]);
});

test('a bridgeRun the runner approved runs without a second prompt, once', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeRun', id: 'ok1', line: 'exit', timeoutMs: 1000, approved: true});
	await r.until(() => seen.length === 1);
	assert.deepEqual(seen, [true]);
	assert.equal(s.pendingPermissions.length, 0);
	r.send({type: 'bridgeRun', id: 'ok1', line: 'exit', timeoutMs: 1000});
	await r.until(() => s.pendingPermissions.length === 1);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'deny'});
	await r.until(() => seen.length === 2);
	assert.deepEqual(seen, [true, false]);
});

test('a declined bridgeAsk gives no approval to a later run with the same id', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'exit', command: 'exit', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'deny'});
	await r.until(() => r.frames.some(f => f.type === 'bridgeConfirm'));
	r.send({type: 'bridgeRun', id: 'a1', line: 'exit', timeoutMs: 1000});
	await r.until(() => s.pendingPermissions.length === 1);
	assert.deepEqual(seen, []);
});

test('an approval is spent by its run: the same id asked again needs a new prompt', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'exit', command: 'exit', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'allow'});
	r.send({type: 'bridgeRun', id: 'a1', line: 'exit', timeoutMs: 1000});
	await r.until(() => seen.length === 1);
	assert.deepEqual(seen, [true]);
	await r.until(() => r.frames.some(f => f.type === 'bridgeResult'));
	r.send({type: 'bridgeRun', id: 'a1', line: 'exit', timeoutMs: 1000});
	await r.until(() => s.pendingPermissions.length === 1);
	assert.deepEqual(seen, [true]);
});

test('an approval for one id does not carry over to another id', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'exit', command: 'exit', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'allow'});
	await r.until(() => r.frames.some(f => f.type === 'bridgeConfirm'));
	r.send({type: 'bridgeRun', id: 'other', line: 'exit', timeoutMs: 1000});
	await r.until(() => s.pendingPermissions.length === 1);
	assert.deepEqual(seen, []);
});

test('a console prompt that nobody answers is cancelled after the idle limit', async () => {
	const r = await fakeRunner();
	const seen: Array<boolean | undefined> = [];
	const s = await connect(r.socketPath, {commandBridge: confirming(seen)});
	cleanup.push(() => s.close());
	const events: ChatEvent[] = [];
	s.subscribe(e => events.push(e));
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'exit', command: 'exit', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	mock.timers.enable({apis: ['setTimeout']});
	// the timer was armed with real time before mocking, so a fresh prompt is needed under the mock clock
	r.send({type: 'bridgeAsk', id: 'a2', request: {line: 'exit', command: 'exit', caller: 'claude'}});
	await immediately(() => s.pendingPermissions.length === 2);
	mock.timers.tick(PERMISSION_IDLE_MS + 1);
	assert.equal(s.pendingPermissions.length, 1, 'the prompt armed under the mock clock is gone');
	await immediately(() => r.frames.some(f => f.type === 'bridgeConfirm'));
	const confirm = r.frames.filter((f): f is Extract<ClientFrame, {type: 'bridgeConfirm'}> => f.type === 'bridgeConfirm').find(f => f.id === 'a2');
	assert.deepEqual(confirm, {v: 1, type: 'bridgeConfirm', id: 'a2', ok: false});
	assert.ok(events.some(e => e.type === 'permission-resolved'));
});

test('a remote permission is never answered by the mirror on its own', async () => {
	const r = await fakeRunner(
		encodeFrame({
			v: 1, type: 'snapshot', ...SNAPSHOT,
			pendingPermissions: [{kind: 'tool', id: 'p1', seq: 1, toolName: 'Bash', input: {command: 'ls'}, cwd: '/x', highlights: [], defaultToNo: false, always: false, oversize: false}],
		} as unknown as RunnerFrame),
	);
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	mock.timers.enable({apis: ['setTimeout']});
	mock.timers.tick(PERMISSION_IDLE_MS * 2);
	await new Promise(res => setImmediate(res));
	assert.equal(s.pendingPermissions.length, 1);
	assert.equal(r.frames.some(f => f.type === 'answer'), false);
});

test('answers with the wrong shape for the pending request are refused locally', async () => {
	const r = await fakeRunner(
		encodeFrame({
			v: 1, type: 'snapshot', ...SNAPSHOT,
			pendingPermissions: [{kind: 'tool', id: 'p1', seq: 1, toolName: 'Bash', input: {command: 'ls'}, cwd: '/x', highlights: [], defaultToNo: false, always: false, oversize: false}],
		} as unknown as RunnerFrame),
	);
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	assert.equal(s.answerPermission('p1', {kind: 'answers', answers: {}} as never), false);
	assert.equal(s.answerPermission('unknown', {kind: 'allow'}), false);
	assert.equal(s.pendingPermissions.length, 1);
});

test('end() asks the runner to close, then leaves; close() alone sends nothing', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	s.end();
	await r.until(() => r.frames.some(f => f.type === 'close'));
	assert.equal(s.state, 'closed');
	assert.deepEqual(r.frames.map(f => f.type), ['hello', 'close']);
});

test('detachedWhileRunning records whether a turn was running at close', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	s.send('go');
	s.close();
	assert.equal(s.detachedWhileRunning, true);
	const r2 = await fakeRunner();
	const idle = await connect(r2.socketPath);
	idle.close();
	assert.equal(idle.detachedWhileRunning, false);
});

test('a bye after the snapshot closes the mirror once and reports the reason', async () => {
	const r = await fakeRunner();
	const lost: string[] = [];
	const s = await connect(r.socketPath, {onLost: x => lost.push(x)});
	r.send({type: 'bye', reason: 'stopped'});
	await r.until(() => s.state === 'closed');
	r.send({type: 'bye', reason: 'again'});
	await new Promise(res => setTimeout(res, 20));
	assert.deepEqual(lost, ['The background chat ended: stopped']);
});

test('invalid data after the snapshot closes the mirror and does not throw', async () => {
	const r = await fakeRunner();
	const lost: string[] = [];
	const s = await connect(r.socketPath, {onLost: x => lost.push(x), log: makeFakeLog()});
	r.sendRaw('{"v":1,"type":"log","level":"trace","msg":"x"}\n');
	await r.until(() => s.state === 'closed');
	assert.deepEqual(lost, ['The background chat sent invalid data.']);
});

test('an invalid first frame rejects the connect and an oversize one is refused', async () => {
	const bad = await fakeRunner('{"v":1,"type":"snapshot","state":"zombie"}\n');
	await assert.rejects(connect(bad.socketPath), /Could not read the background chat/);
	const big = await fakeRunner(`${'x'.repeat(1024 * 1024 + 10)}`);
	await assert.rejects(connect(big.socketPath), /Could not read the background chat/);
});

test('runner log frames reach the log only through the runner scope', async () => {
	const r = await fakeRunner();
	const log = makeFakeLog();
	const s = await connect(r.socketPath, {log});
	cleanup.push(() => s.close());
	r.send({type: 'log', level: 'info', msg: 'hello', fields: {a: 'b'}});
	await r.until(() => log.records.some(x => x.msg === 'hello'));
	assert.equal(log.records.find(x => x.msg === 'hello')?.scope, 'runner');
});

test('closing the mirror cancels running console commands and pending prompts', async () => {
	const r = await fakeRunner();
	let aborted = false;
	const bridge: CommandBridge = {
		list: () => [],
		run: req =>
			new Promise<CommandRunResult>(res =>
				req.signal?.addEventListener('abort', () => {
					aborted = true;
					res(okResult);
				}),
			),
	};
	const s = await connect(r.socketPath, {commandBridge: bridge});
	r.send({type: 'bridgeRun', id: 'h1', line: 'hang', timeoutMs: 1000});
	await new Promise(res => setTimeout(res, 30));
	s.close();
	assert.equal(aborted, true);
});
