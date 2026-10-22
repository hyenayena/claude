import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'node:test';
import type {CommandInfo, Logger} from '../../../../src/api.js';
import type {ChatEvent} from '../../src/chat/events.js';
import type {EngineIo, EngineOpen} from '../../src/chat/engine.js';
import type {PermissionRequest} from '../../src/chat/permission.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runRunner, type RunnerEngine, type RunnerHandle, type RunnerOptions, type RunnerSession} from '../../src/runner/server.js';
import {queryStatus, requestStop} from '../../src/sessions/control.js';

const SID = '11111111-2222-3333-4444-555555555555';
const tick = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms));

const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
		await tick(5);
	}
};

class FakeSession {
	state: 'idle' | 'running' | 'closed' = 'idle';
	sessionId: string | undefined;
	model: string | undefined;
	mode: 'default' | 'acceptEdits' | 'plan' | 'auto' = 'default';
	needsNewSession = false;
	title: string | undefined;
	pendingPermissions: PermissionRequest[] = [];
	tasks = [];
	commands = [];
	rateLimit = undefined;
	costUsd = undefined;
	sent: string[] = [];
	interrupts = 0;
	closed = false;
	private cbs = new Set<(e: ChatEvent) => void>();
	subscribe = (cb: (e: ChatEvent) => void) => {
		this.cbs.add(cb);
		return () => void this.cbs.delete(cb);
	};
	emit = (e: ChatEvent): void => {
		for (const cb of [...this.cbs]) cb(e);
	};
	send = (text: string): void => {
		this.sent.push(text);
		this.state = 'running';
		this.emit({type: 'state', state: 'running'});
		this.emit({type: 'sent', text});
	};
	endTurn = (outcome: 'ok' | 'interrupted' | 'error' | 'limit'): void => {
		this.state = 'idle';
		this.emit({type: 'state', state: 'idle'});
		this.emit({type: 'turn-end', outcome});
	};
	interrupt = async (): Promise<void> => {
		this.interrupts++;
	};
	setMode = (mode: FakeSession['mode']): void => {
		this.mode = mode;
		this.emit({type: 'mode', mode});
	};
	answerPermission = (): boolean => true;
	reset = (): void => undefined;
	close = (): void => {
		this.closed = true;
		this.state = 'closed';
	};
	forget = (): void => undefined;
	setTitle = (t: string): void => {
		this.title = t;
	};
	stopTask = async (): Promise<void> => undefined;
	backgroundTasks = async (): Promise<boolean> => true;
	mcpStatus = async (): Promise<Array<{name: string; status: string}>> => [{name: 'm', status: 'connected'}];
	reconnectMcp = async (): Promise<void> => {
		throw new Error('no such server');
	};
	rewindFiles = async (): Promise<{canRewind: boolean}> => ({canRewind: false});
}

type Client = {
	socket: net.Socket;
	frames: RunnerFrame[];
	send: (f: Omit<ClientFrame, 'v'> & Record<string, unknown>) => void;
	closed: () => boolean;
	waitFor: <T extends RunnerFrame['type']>(type: T, from?: number) => Promise<Extract<RunnerFrame, {type: T}>>;
};

const connect = async (file: string): Promise<Client> => {
	const socket = net.createConnection(file);
	await new Promise<void>((resolve, reject) => {
		socket.once('connect', resolve);
		socket.once('error', reject);
	});
	const dec = createDecoder('toClient');
	const frames: RunnerFrame[] = [];
	let closed = false;
	socket.on('data', c => frames.push(...(dec.push(c) as RunnerFrame[])));
	socket.on('close', () => (closed = true));
	socket.on('error', () => undefined);
	return {
		socket,
		frames,
		closed: () => closed,
		send: f => void socket.write(encodeFrame({v: 1, ...f} as ClientFrame)),
		waitFor: async (type, from = 0) => {
			await until(() => frames.slice(from).some(f => f.type === type), `frame ${type}`);
			return frames.slice(from).find(f => f.type === type) as never;
		},
	};
};

type Rig = {
	dir: string;
	session: FakeSession;
	opens: EngineOpen[];
	io: () => EngineIo;
	log: () => Logger;
	updates: unknown[];
	lockUpdates: unknown[];
	released: () => boolean;
	handle: RunnerHandle;
};

const dirs: string[] = [];
const handles: RunnerHandle[] = [];
afterEach(async () => {
	for (const h of handles.splice(0)) await h.stop('test').catch(() => undefined);
	for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const rig = async (extra: Partial<RunnerOptions> = {}, fail?: Error): Promise<Rig> => {
	const dir = mkdtempSync(path.join(tmpdir(), 'yr-'));
	dirs.push(dir);
	const session = new FakeSession();
	const opens: EngineOpen[] = [];
	let io: EngineIo | undefined;
	let log: Logger | undefined;
	const updates: unknown[] = [];
	const lockUpdates: unknown[] = [];
	let released = false;
	const handle = await runRunner({
		dir,
		store: {update: async p => void updates.push(p)},
		lock: {update: p => void lockUpdates.push(p), release: () => (released = true)},
		createEngine: async (open, i, l) => {
			opens.push(open);
			io = i;
			log = l;
			if (fail) throw fail;
			return {session: session as unknown as RunnerSession, applyLive: () => undefined, close: () => session.close(), flush: async () => undefined};
		},
		...extra,
	});
	handles.push(handle);
	return {dir, session, opens, io: () => io!, log: () => log!, updates, lockUpdates, released: () => released, handle};
};

const OPEN = {type: 'open', open: {fresh: true}, tuning: {}, keep: false} as const;

const attach = async (r: Rig, open: Record<string, unknown> = {}): Promise<Client> => {
	const c = await connect(r.handle.socketPath);
	c.send({type: 'hello', role: 'attach'});
	c.send({...OPEN, ...open});
	await c.waitFor('snapshot');
	return c;
};

test('attach and open build the engine, answer with a snapshot and stream events', async () => {
	const r = await rig();
	const c = await attach(r, {open: {fresh: false, model: 'opus', resume: SID}, mode: 'plan'});
	assert.deepEqual(r.opens, [{fresh: false, model: 'opus', tuning: {}, resume: SID}]);
	const snap = c.frames.find(f => f.type === 'snapshot') as Extract<RunnerFrame, {type: 'snapshot'}>;
	assert.equal(snap.mode, 'plan');
	assert.deepEqual(snap.queued, []);
	c.send({type: 'send', text: 'hi'});
	await until(() => c.frames.some(f => f.type === 'event' && f.event.type === 'sent'), 'sent event');
	assert.deepEqual(r.session.sent, ['hi']);
});

test('a second client gets bye and the first stays attached', async () => {
	const r = await rig();
	const a = await attach(r);
	const b = await connect(r.handle.socketPath);
	b.send({type: 'hello', role: 'attach'});
	const bye = await b.waitFor('bye');
	assert.equal(bye.reason, 'attached elsewhere');
	await until(b.closed, 'second client closed');
	a.send({type: 'setMode', mode: 'auto'});
	await until(() => r.session.mode === 'auto', 'first client still served');
});

test('a late attach to an open session gets the snapshot with the queue and the log ring', async () => {
	const r = await rig();
	const a = await attach(r, {keep: true});
	a.send({type: 'queue', lines: ['one', 'two']});
	r.session.send('work');
	a.socket.destroy();
	await until(() => r.session.state === 'running', 'running');
	await tick(30);
	r.log().info('while detached', {n: 1, secret: 'x'});
	const b = await connect(r.handle.socketPath);
	b.send({type: 'hello', role: 'attach'});
	const snap = await b.waitFor('snapshot');
	assert.deepEqual(snap.queued, ['one', 'two']);
	assert.equal(snap.state, 'running');
	const logs = b.frames.filter((f): f is Extract<RunnerFrame, {type: 'log'}> => f.type === 'log');
	assert.ok(logs.some(l => l.msg === 'runner detached'));
	assert.ok(logs.some(l => l.msg === 'while detached' && l.fields?.n === 1));
});

test('keep off: a detach during a turn interrupts and exits', async () => {
	const r = await rig();
	const c = await attach(r);
	r.session.send('long');
	c.socket.destroy();
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'detached');
	assert.equal(r.session.interrupts, 1);
	assert.ok(r.session.closed);
	assert.ok(r.released());
});

test('keep on: the queue is sent once after an ok turn, then the runner exits', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('first');
	c.send({type: 'queue', lines: ['a', 'b']});
	await tick(30);
	c.socket.destroy();
	await tick(30);
	assert.equal(r.session.interrupts, 0);
	r.session.endTurn('ok');
	await until(() => r.session.sent.length === 2, 'queue flushed');
	assert.equal(r.session.sent[1], 'a\n\nb');
	r.session.endTurn('ok');
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'idle');
	assert.equal(exit.turns, 2);
});

test('keep on: after a failed turn the queue is kept, nothing is sent and the runner waits', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('first');
	c.send({type: 'queue', lines: ['kept']});
	await tick(30);
	c.socket.destroy();
	await tick(30);
	r.session.endTurn('limit');
	await tick(80);
	assert.deepEqual(r.session.sent, ['first']);
	let finished = false;
	void r.handle.done.then(() => (finished = true));
	await tick(30);
	assert.equal(finished, false);
	const again = await connect(r.handle.socketPath);
	again.send({type: 'hello', role: 'attach'});
	const snap = await again.waitFor('snapshot');
	assert.deepEqual(snap.queued, ['kept']);
});

test('keep on: a detach while idle with an empty queue exits right away', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.socket.destroy();
	assert.equal((await r.handle.done).reason, 'idle');
});

test('setKeep changes what a later detach does', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('x');
	c.send({type: 'setKeep', keep: false});
	await tick(30);
	c.socket.destroy();
	assert.equal((await r.handle.done).reason, 'detached');
});

test('the console bridge answers "yena is closed" while detached', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('x');
	c.socket.destroy();
	await tick(40);
	const res = await r.io().commandBridge!.run({line: 'help', caller: 'claude'});
	assert.equal(res.status, 'off');
	assert.equal(res.reason, 'yena is closed');
	assert.deepEqual(r.io().commandBridge!.list(), []);
});

const CMDS: CommandInfo[] = [
	{name: 'help', description: 'h', policy: 'safe', subcommands: []},
	{name: 'exit', description: 'e', policy: 'confirm', subcommands: []},
];

test('the bridge forwards a safe command and a confirmed one with bridgeAsk first', async () => {
	const r = await rig();
	const c = await attach(r);
	c.send({type: 'commands', list: CMDS});
	await tick(30);
	const bridge = r.io().commandBridge!;
	assert.deepEqual(bridge.list().map(x => x.name), ['help', 'exit']);

	const safe = bridge.run({line: 'help', caller: 'claude', confirm: async () => true, timeoutMs: 5000});
	const run1 = (await c.waitFor('bridgeRun')) as Extract<RunnerFrame, {type: 'bridgeRun'}>;
	assert.equal(run1.timeoutMs, 5000);
	assert.equal(c.frames.some(f => f.type === 'bridgeAsk'), false);
	c.send({type: 'bridgeResult', id: run1.id, result: {status: 'ok', output: 'done', truncated: false, ms: 1}});
	assert.equal((await safe).output, 'done');

	const before = c.frames.length;
	const risky = bridge.run({line: 'exit', caller: 'claude', confirm: async () => true});
	const ask = await c.waitFor('bridgeAsk', before);
	assert.deepEqual(ask.request, {line: 'exit', command: 'exit', caller: 'claude'});
	c.send({type: 'bridgeConfirm', id: ask.id, ok: true});
	const run2 = await c.waitFor('bridgeRun', before);
	assert.equal(run2.id, ask.id);
	c.send({type: 'bridgeResult', id: run2.id, result: {status: 'ok', output: 'bye', truncated: false, ms: 1}});
	assert.equal((await risky).output, 'bye');
});

test('a declined confirmation never reaches bridgeRun, a detach settles pending calls', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({type: 'commands', list: CMDS});
	await tick(30);
	const bridge = r.io().commandBridge!;
	const declined = bridge.run({line: 'exit', caller: 'claude', confirm: async () => true});
	const ask = await c.waitFor('bridgeAsk');
	c.send({type: 'bridgeConfirm', id: ask.id, ok: false});
	assert.equal((await declined).status, 'declined');
	assert.equal(c.frames.some(f => f.type === 'bridgeRun'), false);

	r.session.send('busy');
	const pending = bridge.run({line: 'help', caller: 'claude'});
	await c.waitFor('bridgeRun');
	c.socket.destroy();
	const res = await pending;
	assert.equal(res.status, 'off');
});

test('an aborted bridge call sends bridgeAbort', async () => {
	const r = await rig();
	const c = await attach(r);
	const ac = new AbortController();
	const p = r.io().commandBridge!.run({line: 'help', caller: 'claude', signal: ac.signal});
	const run = await c.waitFor('bridgeRun');
	ac.abort();
	assert.equal((await p).status, 'aborted');
	const abort = await c.waitFor('bridgeAbort');
	assert.equal(abort.id, run.id);
});

test('state updates go to the attached client and to the store when detached', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	await r.io().stateUpdate({lastSessionId: SID, chatModel: 'opus'});
	const upd = await c.waitFor('stateUpdate');
	assert.deepEqual(upd.patch, {lastSessionId: SID});
	assert.deepEqual(r.updates, []);
	r.session.send('x');
	c.socket.destroy();
	await tick(40);
	await r.io().stateUpdate({lastModel: 'm'});
	assert.deepEqual(r.updates, [{lastModel: 'm'}]);
});

test('logs reach the client as frames, credentials are redacted, the ring keeps 200', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.log().addRedactor(s => s.replaceAll('SECRET', '[x]'));
	r.log().warn('leak SECRET', {value: 'a SECRET b', err: new Error('boom SECRET'), nested: {a: 1}});
	await until(() => c.frames.some(f => f.type === 'log' && f.msg.startsWith('leak')), 'leak log');
	const got = c.frames.find((f): f is Extract<RunnerFrame, {type: 'log'}> => f.type === 'log' && f.msg.startsWith('leak'))!;
	assert.equal(got.msg, 'leak [x]');
	assert.equal(got.fields?.value, 'a [x] b');
	assert.equal(got.fields?.err, 'Error: boom [x]');
	assert.equal('nested' in (got.fields ?? {}), false);

	r.session.send('x');
	c.socket.destroy();
	await tick(40);
	for (let i = 0; i < 250; i++) r.log().debug(`m${i}`);
	const d = await connect(r.handle.socketPath);
	d.send({type: 'hello', role: 'attach'});
	await d.waitFor('snapshot');
	await until(() => d.frames.filter(f => f.type === 'log' && /^m\d+$/.test(f.msg)).length >= 200, 'ring');
	const msgs = d.frames.filter((f): f is Extract<RunnerFrame, {type: 'log'}> => f.type === 'log' && /^m\d+$/.test(f.msg)).map(f => f.msg);
	assert.equal(msgs.length, 200);
	assert.equal(msgs.at(-1), 'm249');
});

test('without an attach the runner exits after the limit', async () => {
	const r = await rig({noAttachMs: 60});
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'no-attach');
	assert.ok(r.released());
});

test('opening cancels the no-attach limit', async () => {
	const r = await rig({noAttachMs: 80});
	const c = await attach(r, {keep: true});
	await tick(160);
	assert.equal(c.closed(), false);
});

test('a failing engine reports the reason to the client and exits', async () => {
	const r = await rig({}, new Error('No credentials available'));
	const c = await connect(r.handle.socketPath);
	c.send({type: 'hello', role: 'attach'});
	c.send(OPEN);
	const bye = await c.waitFor('bye');
	assert.equal(bye.reason, 'No credentials available');
	assert.equal((await r.handle.done).reason, 'open-failed');
});

test('the control socket reports status and stop closes the chat', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.sessionId = SID;
	r.session.title = 'My chat';
	r.session.send('x');
	c.send({type: 'queue', lines: ['q']});
	await tick(30);
	const st = await queryStatus(r.dir);
	assert.deepEqual(
		{...st, startedAt: 0},
		{kind: 'chat', where: 'runner', state: 'running', title: 'My chat', sessionId8: '11111111', startedAt: 0, pending: 0, queued: 1, attached: true},
	);
	await requestStop(r.dir);
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'stopped');
	assert.ok(r.session.closed);
	assert.ok(r.released());
	await c.waitFor('bye');
});

test('hello control answers status over the runner socket and stop ends the runner', async () => {
	const r = await rig();
	const c = await connect(r.handle.socketPath);
	c.send({type: 'hello', role: 'control'});
	c.send({type: 'status'});
	const reply = await c.waitFor('statusReply');
	assert.equal(reply.status.attached, false);
	assert.equal(reply.status.state, 'idle');
	const s = await connect(r.handle.socketPath);
	s.send({type: 'hello', role: 'control'});
	s.send({type: 'stop'});
	assert.equal((await r.handle.done).reason, 'stopped');
});

test('the lock follows the session id', async () => {
	const r = await rig();
	await attach(r);
	r.session.sessionId = SID;
	r.session.emit({type: 'state', state: 'idle'});
	assert.deepEqual(r.lockUpdates, [{sessionId: SID}]);
});

test('rpc results and errors come back by id', async () => {
	const r = await rig();
	const c = await attach(r);
	c.send({type: 'rpc', id: 'a', op: 'mcpStatus', args: {}});
	c.send({type: 'rpc', id: 'b', op: 'reconnectMcp', args: {name: 'x'}});
	await until(() => c.frames.filter(f => f.type === 'rpcResult').length === 2, 'rpc results');
	const res = c.frames.filter((f): f is Extract<RunnerFrame, {type: 'rpcResult'}> => f.type === 'rpcResult');
	assert.deepEqual(res.find(x => x.id === 'a'), {v: 1, type: 'rpcResult', id: 'a', ok: true, value: [{name: 'm', status: 'connected'}]});
	assert.deepEqual(res.find(x => x.id === 'b'), {v: 1, type: 'rpcResult', id: 'b', ok: false, error: 'no such server'});
});

test('garbage on the socket closes the connection without harming the session', async () => {
	const r = await rig();
	const a = await attach(r);
	const bad = net.createConnection(r.handle.socketPath);
	bad.on('error', () => undefined);
	await new Promise<void>(res => bad.once('connect', res));
	bad.write('not json\n');
	await new Promise<void>(res => bad.once('close', () => res()));
	a.send({type: 'setMode', mode: 'auto'});
	await until(() => r.session.mode === 'auto', 'still served');
});

const pendingTool = (id: string): PermissionRequest => ({
	kind: 'tool', id, seq: 1, toolName: 'Bash', input: {command: 'ls'}, cwd: '/x',
	highlights: [], defaultToNo: false, always: false, oversize: false,
} as PermissionRequest);

test('keep on: a pending permission is never answered while detached, the runner waits and the reattach gets it again', async () => {
	const r = await rig();
	let answered = 0;
	r.session.answerPermission = () => (answered++, true);
	const c = await attach(r, {keep: true});
	r.session.send('x');
	r.session.pendingPermissions.push(pendingTool('p1'));
	r.session.emit({type: 'permission-requested', request: r.session.pendingPermissions[0]!, pending: 1});
	c.socket.destroy();
	await tick(60);
	r.session.endTurn('ok');
	await tick(60);
	assert.equal(answered, 0);
	let finished = false;
	void r.handle.done.then(() => (finished = true));
	await tick(40);
	assert.equal(finished, false, 'the runner waits for the user');
	assert.equal((await queryStatus(r.dir)).state, 'idle');
	const again = await connect(r.handle.socketPath);
	again.send({type: 'hello', role: 'attach'});
	const snap = await again.waitFor('snapshot');
	assert.deepEqual(snap.pendingPermissions.map(p => p.id), ['p1']);
	assert.equal(answered, 0);
});

test('keep on: a running turn with a pending permission reports waiting-permission', async () => {
	const r = await rig();
	await attach(r, {keep: true});
	r.session.send('x');
	r.session.pendingPermissions.push(pendingTool('p1'));
	const st = await queryStatus(r.dir);
	assert.equal(st.state, 'waiting-permission');
	assert.equal(st.pending, 1);
});

test('keep off: a detach with a pending permission shuts the chat down instead of waiting', async () => {
	const r = await rig();
	const c = await attach(r);
	r.session.send('x');
	r.session.pendingPermissions.push(pendingTool('p1'));
	c.socket.destroy();
	assert.equal((await r.handle.done).reason, 'detached');
	assert.ok(r.session.closed);
});

test('a queue kept after a failed turn is abandoned after the linger and the lock is released', async () => {
	const r = await rig({lingerMs: 80});
	const c = await attach(r, {keep: true});
	r.session.send('first');
	c.send({type: 'queue', lines: ['kept']});
	await tick(30);
	c.socket.destroy();
	await tick(30);
	r.session.endTurn('error');
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'abandoned');
	assert.ok(r.session.closed);
	assert.ok(r.released());
	assert.deepEqual(r.session.sent, ['first']);
});

test('attaching again cancels the linger', async () => {
	const r = await rig({lingerMs: 120});
	const c = await attach(r, {keep: true});
	r.session.send('first');
	c.send({type: 'queue', lines: ['kept']});
	await tick(30);
	c.socket.destroy();
	await tick(30);
	r.session.endTurn('limit');
	await tick(30);
	const again = await connect(r.handle.socketPath);
	again.send({type: 'hello', role: 'attach'});
	await again.waitFor('snapshot');
	await tick(250);
	assert.equal(again.closed(), false);
	assert.equal(r.released(), false);
});

test('close from the attached client makes an idle runner exit and release the lock', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({type: 'close'});
	const exit = await r.handle.done;
	assert.equal(exit.reason, 'closed');
	assert.ok(r.session.closed);
	assert.ok(r.released());
	await c.waitFor('bye');
});

test('close also ends a running turn and the socket files are gone', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('x');
	c.send({type: 'close'});
	assert.equal((await r.handle.done).reason, 'closed');
	assert.equal(r.session.interrupts, 1);
	await assert.rejects(() => connect(r.handle.socketPath));
});

test('a control connection cannot send, answer, confirm or close', async () => {
	const r = await rig();
	const a = await attach(r, {keep: true});
	a.send({type: 'commands', list: CMDS});
	await tick(30);
	const ctl = await connect(r.handle.socketPath);
	ctl.send({type: 'hello', role: 'control'});
	ctl.send({type: 'send', text: 'evil'});
	ctl.send({type: 'answer', id: 'p1', decision: {kind: 'allow'}});
	ctl.send({type: 'close'});
	ctl.send({type: 'setMode', mode: 'auto'});
	ctl.send({type: 'queue', lines: ['x']});
	const pending = r.io().commandBridge!.run({line: 'exit', caller: 'claude', confirm: async () => true, timeoutMs: 100});
	const ask = await a.waitFor('bridgeAsk');
	ctl.send({type: 'bridgeConfirm', id: ask.id, ok: true});
	await tick(80);
	assert.equal(a.frames.some(f => f.type === 'bridgeRun'), false, 'a control client cannot approve');
	a.send({type: 'bridgeConfirm', id: ask.id, ok: false});
	assert.equal((await pending).status, 'declined');
	assert.deepEqual(r.session.sent, []);
	assert.equal(r.session.mode, 'default');
	assert.equal(r.session.closed, false);
	assert.equal(r.session.interrupts, 0);
});

test('frames before hello are ignored and a hello twice does not change the role', async () => {
	const r = await rig();
	const c = await connect(r.handle.socketPath);
	c.send({type: 'close'});
	c.send({type: 'status'});
	await tick(50);
	assert.equal(c.frames.length, 0);
	c.send({type: 'hello', role: 'control'});
	c.send({type: 'hello', role: 'attach'});
	c.send({type: 'status'});
	const reply = await c.waitFor('statusReply');
	assert.equal(reply.status.attached, false);
	let finished = false;
	void r.handle.done.then(() => (finished = true));
	await tick(30);
	assert.equal(finished, false);
});

test('a second open frame is ignored and the engine is built once', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({...OPEN, open: {fresh: false, model: 'other'}});
	await tick(50);
	assert.equal(r.opens.length, 1);
});

test('bridge answers for unknown ids are ignored', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({type: 'bridgeResult', id: 'nope', result: {status: 'ok', output: 'x', truncated: false, ms: 1}});
	c.send({type: 'bridgeConfirm', id: 'nope', ok: true});
	await tick(30);
	const res = r.io().commandBridge!.run({line: 'help', caller: 'claude', timeoutMs: 100});
	const run = await c.waitFor('bridgeRun');
	c.send({type: 'bridgeResult', id: run.id, result: {status: 'ok', output: 'real', truncated: false, ms: 1}});
	assert.equal((await res).output, 'real');
});

test('a confirm for a safe run id does not matter; only an ask in flight is resolved', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({type: 'commands', list: CMDS});
	await tick(30);
	const res = r.io().commandBridge!.run({line: 'help', caller: 'claude', confirm: async () => true});
	const run = await c.waitFor('bridgeRun');
	assert.equal(c.frames.some(f => f.type === 'bridgeAsk'), false);
	c.send({type: 'bridgeConfirm', id: run.id, ok: false});
	c.send({type: 'bridgeResult', id: run.id, result: {status: 'ok', output: 'ok', truncated: false, ms: 1}});
	assert.equal((await res).status, 'ok');
});

test('an unknown command with a confirm callback is not pre-approved by the runner', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	c.send({type: 'commands', list: CMDS});
	await tick(30);
	const res = r.io().commandBridge!.run({line: 'mystery', caller: 'claude', confirm: async () => true, timeoutMs: 100});
	const run = await c.waitFor('bridgeRun');
	assert.equal(c.frames.some(f => f.type === 'bridgeAsk'), false, 'no ask is sent, so the client has no approval for this id');
	c.send({type: 'bridgeResult', id: run.id, result: {status: 'unknown', output: '', truncated: false, ms: 1}});
	assert.equal((await res).status, 'unknown');
});

test('attach without open and a detach shuts the runner down as detached', async () => {
	const r = await rig();
	const c = await connect(r.handle.socketPath);
	c.send({type: 'hello', role: 'attach'});
	await tick(30);
	c.socket.destroy();
	assert.equal((await r.handle.done).reason, 'detached');
	assert.ok(r.released());
});

test('stop while a client is attached says bye to it and releases everything', async () => {
	const r = await rig();
	const c = await attach(r, {keep: true});
	const exit = await r.handle.stop('stopped');
	assert.equal(exit.reason, 'stopped');
	assert.equal((await c.waitFor('bye')).reason, 'stopped');
	assert.ok(r.released());
});

test('the runner adds no process-level listeners during its life or after it ends', async () => {
	const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'uncaughtException', 'unhandledRejection', 'exit', 'beforeExit', 'warning'] as const;
	const counts = () => events.map(e => process.listenerCount(e));
	const before = counts();
	const r = await rig();
	const c = await attach(r, {keep: true});
	r.session.send('x');
	assert.deepEqual(counts(), before);
	c.socket.destroy();
	await tick(40);
	await r.handle.stop();
	assert.deepEqual(counts(), before);
});
