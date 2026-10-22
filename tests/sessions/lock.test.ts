import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {acquireLock, lockPath, readHolder} from '../../src/sessions/lock.js';
import {procStart} from '../../src/sessions/proc.js';
import {ensureSessionDir} from '../../src/chat/shell-tmp.js';

const dir = () => mkdtempSync(join(tmpdir(), 'session-lock-'));
const SID = '11111111-aaaa-4bbb-8ccc-222222222222';

test('procStart reads field 22 of this process', () => {
	assert.match(procStart(process.pid) ?? '', /^\d+$/);
	assert.equal(procStart(0), undefined);
});

test('a second acquire sees the holder, release lets the next one in', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	const b = acquireLock({dir: d, kind: 'ask', where: 'local'});
	assert.ok(!b.ok && b.holder?.kind === 'chat');
	assert.equal(readFileSync(lockPath(d)).length > 0, true);
	a.lock.release();
	a.lock.release();
	assert.equal(existsSync(lockPath(d)), false);
	assert.ok(acquireLock({dir: d, kind: 'ask', where: 'local'}).ok);
});

test('a dead holder is stale and replaced', () => {
	const d = dir();
	writeFileSync(lockPath(d), JSON.stringify({v: 1, pid: 2 ** 22 + 5, procStart: '1', kind: 'chat', where: 'runner', startedAt: 1}));
	assert.deepEqual(readHolder(d).holder, undefined);
	assert.ok(acquireLock({dir: d, kind: 'chat', where: 'local'}).ok);
});

test('a reused pid with another start time is stale', () => {
	const d = dir();
	writeFileSync(
		lockPath(d),
		JSON.stringify({v: 1, pid: process.pid, procStart: '1', kind: 'chat', where: 'local', startedAt: 1}),
	);
	assert.ok(readHolder(d).stale);
	assert.ok(acquireLock({dir: d, kind: 'ask', where: 'local'}).ok);
});

test('garbage is stale at once when it is JSON of the wrong shape, and after 5 s when it is not JSON', () => {
	const d = dir();
	writeFileSync(lockPath(d), '{"v":2}');
	assert.ok(acquireLock({dir: d, kind: 'ask', where: 'local'}).ok);

	const e = dir();
	writeFileSync(lockPath(e), 'not json');
	assert.ok(!acquireLock({dir: e, kind: 'ask', where: 'local'}).ok);
	const old = new Date(Date.now() - 10_000);
	utimesSync(lockPath(e), old, old);
	assert.ok(acquireLock({dir: e, kind: 'ask', where: 'local'}).ok);
});

test('a lock replaced by another holder is not deleted by the old release', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	const other = {v: 1, pid: process.pid, procStart: procStart(process.pid), kind: 'ask', where: 'local', startedAt: 42};
	writeFileSync(lockPath(d), JSON.stringify(other));
	a.lock.release();
	assert.equal(JSON.parse(readFileSync(lockPath(d), 'utf8')).startedAt, 42);
});

test('update rewrites the session id and keeps ownership', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	a.lock.update({sessionId: SID});
	assert.equal(JSON.parse(readFileSync(lockPath(d), 'utf8')).sessionId, SID);
	assert.equal(readHolder(d).holder?.sessionId, SID);
	a.lock.release();
	assert.equal(existsSync(lockPath(d)), false);
});

test('a symlinked lock is refused and its target untouched', () => {
	const d = dir();
	const target = join(d, 'target');
	writeFileSync(target, 'keep');
	symlinkSync(target, lockPath(d));
	assert.throws(() => acquireLock({dir: d, kind: 'chat', where: 'local'}), /symbolic link/);
	assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('ensureSessionDir makes a private directory below the shell tmp root', () => {
	const base = mkdtempSync(join(tmpdir(), 'session-dir-'));
	const d = ensureSessionDir({base});
	assert.match(d, /yena-claude-\d+\/session$/);
	assert.equal(ensureSessionDir({base}), d);
});
