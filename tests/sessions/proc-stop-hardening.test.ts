import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {controlSocketPath, parseStatus, queryStatus, requestStop, serveControl, type ControlStatus} from '../../src/sessions/control.js';
import {lockPath, type LockInfo} from '../../src/sessions/lock.js';
import {procCmdline, procStart} from '../../src/sessions/proc.js';
import {stopHolder} from '../../src/sessions/stop.js';

const made: string[] = [];
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), 'proc-stop-'));
	made.push(d);
	return d;
};
after(() => {
	for (const d of made) rmSync(d, {recursive: true, force: true});
});

const status: ControlStatus = {kind: 'chat', where: 'runner', state: 'idle', startedAt: 1, pending: 0, queued: 0, attached: false};

test('procStart parses field 22 even when the command name has spaces and parentheses', () => {
	const root = dir();
	mkdirSync(join(root, '77'));
	const tail = ['S', ...Array.from({length: 18}, (_, i) => String(i)), '123456'].join(' ');
	writeFileSync(join(root, '77', 'stat'), `77 (we) ird )name) ${tail} 0 0\n`);
	assert.equal(procStart(77, root), '123456');
	writeFileSync(join(root, '77', 'stat'), '77 (short) S 1\n');
	assert.equal(procStart(77, root), undefined);
	assert.equal(procStart(78, root), undefined);
	assert.equal(procStart(-1, root), undefined);
	assert.equal(procStart(1.5, root), undefined);
});

test('procCmdline splits on NUL and refuses bad pids', () => {
	const root = dir();
	mkdirSync(join(root, '9'));
	writeFileSync(join(root, '9', 'cmdline'), 'node\0--import\0tsx\0/a/src/runner/main.ts\0');
	assert.deepEqual(procCmdline(9, root), ['node', '--import', 'tsx', '/a/src/runner/main.ts']);
	assert.equal(procCmdline(10, root), undefined);
	assert.equal(procCmdline(0, root), undefined);
});

const lockWith = (where: 'local' | 'runner', pid = process.pid, start = procStart(process.pid)!) => {
	const d = dir();
	const holder: LockInfo = {v: 1, pid, procStart: start, kind: 'chat', where, startedAt: 1};
	writeFileSync(lockPath(d), JSON.stringify(holder));
	return {d, holder};
};
const fast = {socketWaitMs: 20, termWaitMs: 20, pollMs: 5};

test('no signal when the pid is dead, even for a runner lock', async () => {
	const {d, holder} = lockWith('runner');
	const sent: string[] = [];
	await stopHolder(d, holder, {...fast, stopRequest: async () => {}, alive: () => false, cmdlineOf: () => ['x/src/runner/main.ts'], kill: (_p, s) => void sent.push(s)});
	assert.deepEqual(sent, []);
});

test('the runner identity is re-checked before SIGKILL', async () => {
	const {d, holder} = lockWith('runner');
	const sent: string[] = [];
	let calls = 0;
	const r = await stopHolder(d, holder, {
		...fast,
		stopRequest: async () => {
			throw new Error('down');
		},
		cmdlineOf: () => (calls++ < 1 ? ['node', '/app/src/runner/main.ts'] : ['node', 'unrelated.js']),
		kill: (_p, s) => void sent.push(s),
	});
	assert.deepEqual(sent, ['SIGTERM']);
	assert.equal(r.ok, false);
});

test('a command line that merely contains the tail inside an argument does not qualify', async () => {
	const {d, holder} = lockWith('runner');
	const sent: string[] = [];
	await stopHolder(d, holder, {...fast, stopRequest: async () => {}, cmdlineOf: () => ['node', '-e', 'src/runner/main.ts --flag'], kill: (_p, s) => void sent.push(s)});
	assert.deepEqual(sent, []);
});

test('a chat running in another yena is never signalled even if the socket is silent', async () => {
	const {d, holder} = lockWith('local');
	const sent: string[] = [];
	const r = await stopHolder(d, holder, {
		...fast,
		stopRequest: async () => {
			throw new Error('down');
		},
		cmdlineOf: () => ['node', '/app/src/runner/main.ts'],
		kill: (_p, s) => void sent.push(s),
	});
	assert.deepEqual(sent, []);
	assert.deepEqual(r, {via: 'socket', ok: false});
});

test('the client fails fast when nothing listens or the socket is closed', async () => {
	const d = dir();
	await assert.rejects(() => queryStatus(d, 200));
	const dead = net.createServer();
	await new Promise<void>(r => dead.listen(controlSocketPath(d), r));
	dead.close();
	await assert.rejects(() => requestStop(d, 200));
});

test('the control server answers bad versions and unknown ops without calling the handlers', async () => {
	const d = dir();
	let calls = 0;
	const server = await serveControl({dir: d, handlers: {status: () => (calls++, status), stop: () => void calls++}});
	const ask = (payload: string) =>
		new Promise<string>(resolve => {
			const s = net.createConnection(controlSocketPath(d), () => s.write(payload));
			let out = '';
			s.on('data', c => (out += c));
			s.on('close', () => resolve(out));
			s.on('error', () => resolve(out));
		});
	assert.match(await ask('{"v":2,"op":"stop"}\n'), /invalid request/);
	assert.match(await ask('{"v":1,"op":"rm"}\n'), /unknown op/);
	assert.match(await ask('[]\n'), /invalid request/);
	assert.equal(calls, 0);
	await server.close();
});

test('a throwing status handler gives a failed answer and the server stays up', async () => {
	const d = dir();
	let fail = true;
	const server = await serveControl({
		dir: d,
		handlers: {
			status: () => {
				if (fail) throw new Error('boom');
				return status;
			},
			stop: () => {},
		},
	});
	await assert.rejects(() => queryStatus(d), /invalid status/);
	fail = false;
	assert.equal((await queryStatus(d)).state, 'idle');
	await server.close();
});

test('a throwing stop handler does not crash the server', async () => {
	const d = dir();
	const server = await serveControl({
		dir: d,
		handlers: {
			status: () => status,
			stop: () => {
				throw new Error('boom');
			},
		},
	});
	await requestStop(d);
	await new Promise(r => setTimeout(r, 20));
	assert.equal((await queryStatus(d)).kind, 'chat');
	await server.close();
});

test('parseStatus validates and caps its input', () => {
	assert.ok(parseStatus(status));
	assert.equal(parseStatus({...status, state: 'paused'}), undefined);
	assert.equal(parseStatus({...status, pending: -1}), undefined);
	assert.equal(parseStatus({...status, pending: 1.5}), undefined);
	assert.equal(parseStatus({...status, attached: 'yes'}), undefined);
	assert.equal(parseStatus({...status, sessionId8: 'xyz'}), undefined);
	assert.equal(parseStatus(null), undefined);
	assert.equal(parseStatus({...status, title: 'x'.repeat(500)})?.title?.length, 200);
	assert.equal('extra' in (parseStatus({...status, extra: 1}) ?? {}), false);
});
