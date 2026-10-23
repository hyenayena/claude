import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, test} from 'node:test';
import {controlSocketPath, queryStatus, requestStop, type ControlStatus} from '../../src/sessions/control.js';
import {readHolder} from '../../src/sessions/lock.js';
import {createTurnLock} from '../../src/sessions/turn-lock.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const dirs: string[] = [];
after(() => {
	for (const d of dirs) rmSync(d, {recursive: true, force: true});
});
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), 'turn-lock-'));
	dirs.push(d);
	return d;
};
const SID = '11111111-2222-4333-8444-555555555555';
const status = (startedAt: number): ControlStatus => ({kind: 'chat', where: 'local', state: 'running', startedAt, pending: 0, queued: 0, attached: true});
const until = async (cond: () => boolean | Promise<boolean>) => {
	for (let i = 0; i < 100; i++) {
		if (await cond()) return;
		await new Promise(r => setTimeout(r, 10));
	}
	assert.fail('condition not met');
};

test('the lock and the control socket exist only between acquire and release', async () => {
	const d = dir();
	let stops = 0;
	const lock = createTurnLock({dir: d, kind: 'chat', where: 'local', sessionId: () => SID, status, stop: () => void stops++, busy: () => 'busy', log: makeFakeLog()});
	assert.equal(readHolder(d).holder, undefined);
	lock.acquire();
	assert.ok(lock.held);
	const holder = readHolder(d).holder;
	assert.equal(holder?.pid, process.pid);
	assert.equal(holder?.sessionId, SID);
	await until(() => existsSync(controlSocketPath(d)));
	assert.equal((await queryStatus(d, 1000)).state, 'running');
	await requestStop(d, 1000);
	await until(() => stops === 1);
	lock.release();
	assert.ok(!lock.held);
	assert.equal(readHolder(d).holder, undefined);
	await until(() => !existsSync(controlSocketPath(d)));
	lock.release();
});

test('another holder refuses the turn with the busy message, and frees it when done', () => {
	const d = dir();
	const opts = {dir: d, kind: 'chat' as const, where: 'local' as const, status, stop: () => {}, log: makeFakeLog()};
	const a = createTurnLock({...opts, busy: () => 'a busy'});
	const b = createTurnLock({...opts, busy: h => `working since ${h?.startedAt ? 'then' : '?'}`});
	a.acquire();
	assert.throws(() => b.acquire(), /working since then/);
	assert.ok(!b.held);
	a.release();
	b.acquire();
	assert.ok(b.held);
	b.release();
});

test('without a session directory it only tracks itself', () => {
	const lock = createTurnLock({dir: undefined, kind: 'chat', where: 'local', status, stop: () => {}, busy: () => 'busy', log: makeFakeLog()});
	lock.acquire();
	assert.ok(lock.held);
	lock.release();
	assert.ok(!lock.held);
});
