import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {pidAlive} from '../../src/sessions/proc.js';
import {queryStatus, requestStop} from '../../src/sessions/control.js';
import {readHolder} from '../../src/sessions/lock.js';
import {RUNNER_ENTRY_TAIL} from '../../src/sessions/stop.js';
import {createDecoder, encodeFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runnerSocketPath, spawnRunner} from '../../src/runner/spawn.js';

const moduleDir = fileURLToPath(new URL('../..', import.meta.url));

const sandbox = () => {
	const base = mkdtempSync(path.join(tmpdir(), 'yrs-'));
	const dir = path.join(base, 'session');
	return {
		base,
		dir,
		env: {...process.env, YENA_DATA: path.join(base, 'data'), YENA_HOME: base, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: ''},
		done: () => rmSync(base, {recursive: true, force: true}),
	};
};

const waitGone = async (pid: number): Promise<void> => {
	for (let i = 0; i < 100 && pidAlive(pid); i++) await new Promise(r => setTimeout(r, 50));
	assert.equal(pidAlive(pid), false, 'runner process exited');
};

test('the real entry starts, reports status and stops over the control socket', async () => {
	const sb = sandbox();
	mkdirSync(sb.dir, {mode: 0o700});
	let pid = 0;
	try {
		const started = await spawnRunner({moduleDir, sessionDir: sb.dir, env: sb.env, timeoutMs: 20_000});
		pid = started.pid;
		assert.equal(started.socketPath, runnerSocketPath(sb.dir));
		const holder = readHolder(sb.dir).holder;
		assert.equal(holder?.where, 'runner');
		assert.equal(holder?.kind, 'chat');
		assert.equal(holder?.socket, started.socketPath);
		const st = await queryStatus(sb.dir, 3000);
		assert.equal(st.where, 'runner');
		assert.equal(st.attached, false);
		await requestStop(sb.dir, 3000);
		await waitGone(pid);
		assert.equal(readHolder(sb.dir).holder, undefined);
	} finally {
		if (pid && pidAlive(pid)) process.kill(pid, 'SIGKILL');
		sb.done();
	}
});

test('an open without credentials is refused with a bye and the runner leaves', async () => {
	const sb = sandbox();
	mkdirSync(sb.dir, {mode: 0o700});
	let pid = 0;
	try {
		const started = await spawnRunner({moduleDir, sessionDir: sb.dir, env: sb.env, timeoutMs: 20_000});
		pid = started.pid;
		const socket = net.createConnection(started.socketPath);
		const dec = createDecoder('toClient');
		const frames: RunnerFrame[] = [];
		socket.on('data', c => frames.push(...(dec.push(c) as RunnerFrame[])));
		socket.on('error', () => undefined);
		await new Promise<void>(r => socket.once('connect', () => r()));
		socket.write(encodeFrame({v: 1, type: 'hello', role: 'attach'}));
		socket.write(encodeFrame({v: 1, type: 'open', open: {fresh: true}, tuning: {}, keep: false}));
		for (let i = 0; i < 200 && !frames.some(f => f.type === 'bye'); i++) await new Promise(r => setTimeout(r, 50));
		assert.ok(frames.some(f => f.type === 'bye'));
		await waitGone(pid);
		socket.destroy();
	} finally {
		if (pid && pidAlive(pid)) process.kill(pid, 'SIGKILL');
		sb.done();
	}
});

test('the spawn is refused when the entry is missing, and the runner entry matches the stop identity tail', async () => {
	assert.ok(path.join('src', 'runner', 'main.ts').endsWith(RUNNER_ENTRY_TAIL));
	const sb = sandbox();
	try {
		await assert.rejects(spawnRunner({moduleDir: path.join(sb.base, 'nope'), sessionDir: sb.dir, env: sb.env}), /Could not start the background chat/);
	} finally {
		sb.done();
	}
});
