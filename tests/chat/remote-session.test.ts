import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, mock, test} from 'node:test';
import type {CommandBridge, CommandRunRequest, CommandRunResult} from '../../../../src/api.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {RemoteChatSession, type RemoteOptions} from '../../src/chat/remote-session.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame, type Snapshot} from '../../src/runner/protocol.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SNAPSHOT: Snapshot = {
	state: 'idle',
	sessionId: '11111111-aaaa-4bbb-8ccc-222222222222',
	model: 'claude-test',
	mode: 'default',
	needsNewSession: false,
	title: 'Hello',
	pendingPermissions: [],
	tasks: [],
	commands: [],
	queued: ['q1'],
	startedAt: 1000,
};

const toolReq = (id: string) => ({
	kind: 'tool' as const, id, seq: 1, toolName: 'Bash' as const, input: {command: 'ls'}, cwd: '/x',
	highlights: [], defaultToNo: false, always: false as const, oversize: false,
});

let cleanup: Array<() => void> = [];
afterEach(() => {
	mock.timers.reset();
	for (const fn of cleanup) fn();
	cleanup = [];
});

async function fakeRunner(snapshot: Snapshot | 'bye' = SNAPSHOT) {
	const dir = mkdtempSync(join(tmpdir(), 'remote-'));
	const socketPath = join(dir, 'runner.sock');
	const frames: ClientFrame[] = [];
	let conn: net.Socket | undefined;
	const waiters: Array<() => void> = [];
	const server = net.createServer(s => {
		conn = s;
		const dec = createDecoder('toRunner');
		s.on('data', d => {
			frames.push(...(dec.push(d) as ClientFrame[]));
			for (const w of waiters.splice(0)) w();
		});
		s.on('error', () => {});
	});
	await new Promise<void>(r => server.listen(socketPath, r));
	cleanup.push(() => {
		conn?.destroy();
		server.close();
	});
	const send = (f: {type: string; [k: string]: unknown}) => conn!.write(encodeFrame({v: 1, ...f} as unknown as RunnerFrame));
	const until = async (pred: () => boolean) => {
		for (let i = 0; i < 200 && !pred(); i++) await new Promise<void>(r => (waiters.push(r), setTimeout(r, 10)));
		assert.ok(pred(), 'condition not reached');
	};
	server.on('connection', () => {
		void until(() => frames.some(f => f.type === 'hello')).then(() => {
			if (snapshot === 'bye') send({type: 'bye', reason: 'attached elsewhere'});
			else send({type: 'snapshot', ...snapshot});
		});
	});
	return {socketPath, frames, send, until, drop: () => conn?.destroy()};
}

const connect = (socketPath: string, extra: Partial<RemoteOptions> = {}) =>
	RemoteChatSession.connect({socketPath, cwd: '/x', stateUpdate: async () => {}, ...extra});

test('connect mirrors the snapshot', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	assert.equal(s.sessionId, SNAPSHOT.sessionId);
	assert.equal(s.title, 'Hello');
	assert.deepEqual(s.queued, ['q1']);
	assert.equal(s.startedAt, 1000);
	assert.equal(s.reattached, true);
	assert.equal(s.detachesOnClose, true);
});

test('a fresh runner gets hello then open', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath, {open: {open: {fresh: true}, tuning: {}, keep: true}});
	cleanup.push(() => s.close());
	assert.equal(s.reattached, false);
	assert.deepEqual(r.frames.map(f => f.type), ['hello', 'open']);
});

test('bye before the snapshot rejects with the reason', async () => {
	const r = await fakeRunner('bye');
	await assert.rejects(connect(r.socketPath), {message: 'attached elsewhere'});
});

test('events update the mirror and reach subscribers', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	const seen: ChatEvent[] = [];
	s.subscribe(e => seen.push(e));
	r.send({type: 'event', event: {type: 'state', state: 'running'}});
	r.send({type: 'event', event: {type: 'title', title: 'New'}});
	r.send({type: 'event', event: {type: 'ui', event: {kind: 'task', id: 't1', status: 'running', description: 'job', background: true}}});
	await r.until(() => s.tasks.length === 1 && s.title === 'New');
	assert.equal(s.state, 'running');
	assert.deepEqual(seen.map(e => e.type), ['state', 'title', 'ui']);
	assert.equal(s.tasks[0]?.description, 'job');
});

test('send, interrupt and setMode become frames; send flips the state at once', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	s.send('hi');
	assert.equal(s.state, 'running');
	assert.throws(() => s.send('again'), /already running/);
	s.setMode('plan');
	assert.equal(s.mode, 'plan');
	await s.interrupt();
	s.setQueued(['a']);
	await r.until(() => r.frames.some(f => f.type === 'queue'));
	const types = r.frames.map(f => f.type);
	assert.deepEqual(types.slice(1), ['send', 'setMode', 'interrupt', 'queue']);
});

test('answerPermission is optimistic and the runner echo is not emitted twice', async () => {
	const r = await fakeRunner({...SNAPSHOT, pendingPermissions: [toolReq('p1')]});
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	const seen: ChatEvent[] = [];
	s.subscribe(e => seen.push(e));
	assert.equal(s.pendingPermissions.length, 1);
	assert.equal(s.answerPermission('p1', {kind: 'allow'}), true);
	assert.equal(s.pendingPermissions.length, 0);
	assert.equal(s.answerPermission('p1', {kind: 'allow'}), false);
	await r.until(() => r.frames.some(f => f.type === 'answer'));
	r.send({type: 'event', event: {type: 'permission-resolved', id: 'p1', pending: 0}});
	r.send({type: 'event', event: {type: 'mode', mode: 'auto'}});
	await r.until(() => s.mode === 'auto');
	assert.deepEqual(seen.map(e => e.type), ['permission-resolved', 'mode']);
});

test('rpc resolves from rpcResult and times out otherwise', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath, {rpcTimeoutMs: 10_000});
	cleanup.push(() => s.close());
	const status = s.mcpStatus();
	await r.until(() => r.frames.some(f => f.type === 'rpc'));
	const rpc = r.frames.find(f => f.type === 'rpc') as Extract<ClientFrame, {type: 'rpc'}>;
	r.send({type: 'rpcResult', id: rpc.id, ok: true, value: [{name: 'a', status: 'connected'}]});
	assert.deepEqual(await status, [{name: 'a', status: 'connected'}]);

	mock.timers.enable({apis: ['setTimeout']});
	const slow = s.reconnectMcp('a');
	const failed = assert.rejects(slow, /did not answer in time/);
	mock.timers.tick(10_000);
	await failed;
});

test('socket loss closes the mirror once with a notice', async () => {
	const r = await fakeRunner();
	const lost: string[] = [];
	const s = await connect(r.socketPath, {onLost: x => lost.push(x), log: makeFakeLog()});
	const seen: ChatEvent[] = [];
	s.subscribe(e => seen.push(e));
	r.send({type: 'event', event: {type: 'state', state: 'running'}});
	await r.until(() => s.state === 'running');
	r.drop();
	await r.until(() => s.state === 'closed');
	assert.deepEqual(lost, ['Lost the connection to the background chat.']);
	assert.deepEqual(seen.map(e => e.type).slice(-2), ['turn-end', 'state']);
});

test('close detaches without sending close or stop', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	s.close();
	assert.equal(s.state, 'closed');
	await new Promise(res => setTimeout(res, 30));
	assert.deepEqual(r.frames.map(f => f.type), ['hello']);
});

test('bridgeRun runs the real bridge and answers; bridgeAbort aborts it', async () => {
	const r = await fakeRunner();
	const requests: CommandRunRequest[] = [];
	const bridge: CommandBridge = {
		list: () => [],
		run: req => {
			requests.push(req);
			if (req.line === 'hang') {
				return new Promise<CommandRunResult>(res => req.signal?.addEventListener('abort', () => res({status: 'aborted', output: '', truncated: false, ms: 1})));
			}
			return Promise.resolve({status: 'ok', output: 'done', truncated: false, ms: 2});
		},
	};
	const s = await connect(r.socketPath, {commandBridge: bridge});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeRun', id: 'b1', line: 'echo hi', timeoutMs: 5000});
	await r.until(() => r.frames.some(f => f.type === 'bridgeResult'));
	const res = r.frames.find(f => f.type === 'bridgeResult') as Extract<ClientFrame, {type: 'bridgeResult'}>;
	assert.equal(res.id, 'b1');
	assert.equal(res.result.output, 'done');
	assert.equal(requests[0]?.caller, 'claude');
	r.send({type: 'bridgeRun', id: 'b2', line: 'hang', timeoutMs: 5000});
	await r.until(() => requests.length === 2);
	r.send({type: 'bridgeAbort', id: 'b2'});
	await r.until(() => r.frames.filter(f => f.type === 'bridgeResult').length === 2);
});

test('bridgeAsk shows the local prompt and answers with bridgeConfirm; the pre-approval covers the run', async () => {
	const r = await fakeRunner();
	let confirmed: boolean | undefined;
	const bridge: CommandBridge = {
		list: () => [],
		run: async req => {
			confirmed = await req.confirm?.({line: req.line, command: 'x', caller: 'claude'});
			return {status: 'ok', output: '', truncated: false, ms: 1};
		},
	};
	const s = await connect(r.socketPath, {commandBridge: bridge});
	cleanup.push(() => s.close());
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'x go', command: 'x', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	const req = s.pendingPermissions[0]!;
	assert.equal(req.kind === 'tool' && req.toolName, 'Command');
	assert.equal(s.answerPermission(req.id, {kind: 'allow'}), true);
	await r.until(() => r.frames.some(f => f.type === 'bridgeConfirm'));
	assert.deepEqual(r.frames.find(f => f.type === 'bridgeConfirm'), {v: 1, type: 'bridgeConfirm', id: 'a1', ok: true});
	r.send({type: 'bridgeRun', id: 'a1', line: 'x go', timeoutMs: 1000});
	await r.until(() => confirmed !== undefined);
	assert.equal(confirmed, true);
	assert.equal(s.pendingPermissions.length, 0);
});

test('without a bridge a console run answers off; a declined ask answers false', async () => {
	const r = await fakeRunner();
	const s = await connect(r.socketPath);
	cleanup.push(() => s.close());
	r.send({type: 'bridgeRun', id: 'b1', line: 'x', timeoutMs: 1000});
	await r.until(() => r.frames.some(f => f.type === 'bridgeResult'));
	assert.equal((r.frames.find(f => f.type === 'bridgeResult') as Extract<ClientFrame, {type: 'bridgeResult'}>).result.status, 'off');
	r.send({type: 'bridgeAsk', id: 'a1', request: {line: 'x', command: 'x', caller: 'claude'}});
	await r.until(() => s.pendingPermissions.length === 1);
	s.answerPermission(s.pendingPermissions[0]!.id, {kind: 'deny'});
	await r.until(() => r.frames.some(f => f.type === 'bridgeConfirm'));
	assert.equal((r.frames.find(f => f.type === 'bridgeConfirm') as Extract<ClientFrame, {type: 'bridgeConfirm'}>).ok, false);
});

test('stateUpdate frames are written through and runner logs go to the runner scope', async () => {
	const r = await fakeRunner();
	const patches: unknown[] = [];
	const log = makeFakeLog();
	const s = await connect(r.socketPath, {stateUpdate: async p => void patches.push(p), log});
	cleanup.push(() => s.close());
	r.send({type: 'stateUpdate', patch: {lastModel: 'm'}});
	r.send({type: 'log', level: 'warn', msg: 'send failed', fields: {code: 3}});
	await r.until(() => patches.length === 1 && log.records.some(x => x.scope === 'runner'));
	assert.deepEqual(patches, [{lastModel: 'm'}]);
	assert.deepEqual(log.records.find(x => x.scope === 'runner'), {level: 'warn', scope: 'runner', msg: 'send failed', fields: {code: 3}});
});

test('commands are sent after refresh and only when they changed', async () => {
	const r = await fakeRunner();
	const bridge: CommandBridge = {list: () => [{name: 'help', description: 'd', policy: 'safe', subcommands: []}], run: async () => ({status: 'ok', output: '', truncated: false, ms: 0})};
	const s = await connect(r.socketPath, {commandBridge: bridge});
	cleanup.push(() => s.close());
	s.refreshCommands();
	s.refreshCommands();
	await r.until(() => r.frames.some(f => f.type === 'commands'));
	assert.equal(r.frames.filter(f => f.type === 'commands').length, 1);
});
