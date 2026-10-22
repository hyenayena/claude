import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {lockPath, type LockInfo} from '../../src/sessions/lock.js';
import {procStart} from '../../src/sessions/proc.js';
import {stopHolder} from '../../src/sessions/stop.js';

const setup = (where: 'local' | 'runner') => {
	const dir = mkdtempSync(join(tmpdir(), 'session-stop-'));
	const holder: LockInfo = {v: 1, pid: process.pid, procStart: procStart(process.pid)!, kind: 'chat', where, startedAt: 1};
	writeFileSync(lockPath(dir), JSON.stringify(holder));
	return {dir, holder};
};
const fast = {socketWaitMs: 30, termWaitMs: 30, pollMs: 10};

test('a holder that releases after the stop request counts as stopped via the socket', async () => {
	const {dir, holder} = setup('runner');
	const r = await stopHolder(dir, holder, {...fast, stopRequest: async () => writeFileSync(lockPath(dir), '{"v":2}')});
	assert.deepEqual(r, {via: 'socket', ok: true});
});

test('a local chat is never signalled', async () => {
	const {dir, holder} = setup('local');
	const sent: string[] = [];
	const r = await stopHolder(dir, holder, {...fast, stopRequest: async () => {}, kill: (_p, s) => void sent.push(s)});
	assert.deepEqual(r, {via: 'socket', ok: false});
	assert.deepEqual(sent, []);
});

test('a runner gets SIGTERM then SIGKILL, only while the identity still matches', async () => {
	const {dir, holder} = setup('runner');
	const sent: string[] = [];
	const r = await stopHolder(dir, holder, {
		...fast,
		stopRequest: async () => {
			throw new Error('down');
		},
		cmdlineOf: () => ['node', '/app/modules/claude/src/runner/main.ts'],
		kill: (_p, s) => void sent.push(s),
	});
	assert.deepEqual(sent, ['SIGTERM', 'SIGKILL']);
	assert.equal(r.ok, false);
});

test('no signal when the process is not a runner or its start time changed', async () => {
	for (const over of [{cmdlineOf: () => ['node', 'other.js']}, {procStartOf: () => '999'}]) {
		const {dir, holder} = setup('runner');
		const sent: string[] = [];
		await stopHolder(dir, holder, {...fast, ...over, stopRequest: async () => {}, kill: (_p, s) => void sent.push(s)});
		assert.deepEqual(sent, []);
	}
});
