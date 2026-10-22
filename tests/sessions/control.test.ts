import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, statSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {controlSocketPath, queryStatus, requestStop, serveControl, type ControlStatus} from '../../src/sessions/control.js';

const dir = () => mkdtempSync(join(tmpdir(), 'session-ctl-'));
const status: ControlStatus = {kind: 'chat', where: 'runner', state: 'running', title: 'T', sessionId8: 'abcdef01', startedAt: 5, pending: 1, queued: 2, attached: false};

test('status and stop over the socket, mode 0600, gone right after close', async () => {
	const d = dir();
	let stops = 0;
	const server = await serveControl({dir: d, handlers: {status: () => status, stop: () => void stops++}});
	assert.equal(statSync(controlSocketPath(d)).mode & 0o777, 0o600);
	assert.deepEqual(await queryStatus(d), status);
	await requestStop(d);
	await new Promise(r => setTimeout(r, 20));
	assert.equal(stops, 1);
	const closing = server.close();
	assert.equal(existsSync(controlSocketPath(d)), false);
	await closing;
});

test('a leftover socket is replaced, a regular file in its place is refused', async () => {
	const d = dir();
	const first = await serveControl({dir: d, handlers: {status: () => status, stop: () => {}}});
	// not closed: simulates a crashed holder that left its socket file behind
	const second = await serveControl({dir: d, handlers: {status: () => ({...status, state: 'idle'}), stop: () => {}}});
	assert.equal((await queryStatus(d)).state, 'idle');
	await second.close();
	await first.close();
	const e = dir();
	writeFileSync(controlSocketPath(e), 'x');
	await assert.rejects(() => serveControl({dir: e, handlers: {status: () => status, stop: () => {}}}), /not a socket/);
});

test('the client times out on a silent server and rejects invalid answers', async () => {
	const d = dir();
	const silent = net.createServer(() => {});
	await new Promise<void>(r => silent.listen(controlSocketPath(d), r));
	await assert.rejects(() => queryStatus(d, 50), /did not answer/);
	silent.close();

	const e = dir();
	const bad = net.createServer(s => s.on('data', () => s.end('{"v":1,"ok":true,"status":{"kind":"x"}}\n')));
	await new Promise<void>(r => bad.listen(controlSocketPath(e), r));
	await assert.rejects(() => queryStatus(e), /invalid status/);
	bad.close();
});

test('the server survives garbage and oversize requests', async () => {
	const d = dir();
	const server = await serveControl({dir: d, handlers: {status: () => status, stop: () => {}}});
	for (const payload of ['garbage\n', 'x'.repeat(10_000)]) {
		await new Promise<void>(resolve => {
			const s = net.createConnection(controlSocketPath(d), () => s.write(payload));
			s.resume();
			s.on('close', () => resolve());
			s.on('error', () => resolve());
		});
	}
	assert.equal((await queryStatus(d)).kind, 'chat');
	await server.close();
});
