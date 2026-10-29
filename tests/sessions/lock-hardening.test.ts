import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, test} from 'node:test';
import {ensurePrivateDir, ensureSessionDir} from '../../src/chat/shell-tmp.js';
import {acquireLock, inspectLock, lockPath, parseLock, readHolder} from '../../src/sessions/lock.js';
import {procStart} from '../../src/sessions/proc.js';

const made: string[] = [];
const dir = () => {
	const d = mkdtempSync(join(tmpdir(), 'lock-hard-'));
	made.push(d);
	return d;
};
after(() => {
	for (const d of made) rmSync(d, {recursive: true, force: true});
});

const SID = '11111111-aaaa-4bbb-8ccc-222222222222';
const valid = () => ({v: 1, pid: process.pid, procStart: procStart(process.pid)!, kind: 'chat', where: 'local', startedAt: 1});

test('two real processes racing for the lock: exactly one wins', async () => {
	const d = dir();
	const lockModule = fileURLToPath(new URL('../../src/sessions/lock.ts', import.meta.url));
	const script = `
const {acquireLock} = await import(${JSON.stringify(lockModule)});
const r = acquireLock({dir: process.argv[1], kind: 'ask', where: 'local'});
process.stdout.write(r.ok ? 'won\\n' : 'lost\\n');
if (r.ok) await new Promise(res => setTimeout(res, 600));
`;
	const run = () =>
		new Promise<string>((resolve, reject) => {
			const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, d], {stdio: ['ignore', 'pipe', 'inherit']});
			let out = '';
			child.stdout.on('data', c => (out += c));
			child.on('error', reject);
			child.on('close', () => resolve(out.trim()));
		});
	const results = await Promise.all([run(), run(), run()]);
	assert.equal(results.filter(r => r === 'won').length, 1, JSON.stringify(results));
	assert.equal(results.filter(r => r === 'lost').length, 2, JSON.stringify(results));
});

test('the lock file is created with mode 0600', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	assert.equal(statSync(lockPath(d)).mode & 0o777, 0o600);
	a.lock.release();
});

test('an oversize lock file is stale and replaced', () => {
	const d = dir();
	writeFileSync(lockPath(d), JSON.stringify({...valid(), pad: 'x'.repeat(8000)}));
	assert.ok(readHolder(d).stale === undefined);
	assert.equal(inspectLock(d).state, 'stale');
	assert.ok(acquireLock({dir: d, kind: 'ask', where: 'local'}).ok);
});

test('a live holder with a matching start time blocks, with and without a session id', () => {
	const d = dir();
	writeFileSync(lockPath(d), JSON.stringify({...valid(), sessionId: SID, socket: '/x/runner.sock'}));
	const r = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(!r.ok && r.holder?.sessionId === SID);
	assert.equal(readFileSync(lockPath(d), 'utf8').includes(SID), true);
});

test('an unparseable fresh file blocks as unknown and is not deleted', () => {
	const d = dir();
	writeFileSync(lockPath(d), '');
	const r = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(!r.ok && r.unknown === true);
	assert.ok(existsSync(lockPath(d)));
	assert.deepEqual(readHolder(d), {unknown: true});
});

test('a stale lock is only removed when it is the file that was judged stale', () => {
	const d = dir();
	const stale = {...valid(), pid: 2 ** 22 + 7, procStart: '1'};
	writeFileSync(lockPath(d), JSON.stringify(stale));
	let first = true;
	const r = acquireLock({
		dir: d,
		kind: 'ask',
		where: 'local',
		alive: pid => {
			if (first && pid === stale.pid) {
				first = false;
				writeFileSync(lockPath(d), JSON.stringify({...valid(), startedAt: 77}));
				return false;
			}
			return pid === process.pid;
		},
	});
	assert.ok(!r.ok);
	assert.equal(JSON.parse(readFileSync(lockPath(d), 'utf8')).startedAt, 77);
});

test('update does nothing once the lock was replaced, and release leaves the new lock alone', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	writeFileSync(lockPath(d), JSON.stringify({...valid(), startedAt: 42}));
	a.lock.update({sessionId: SID});
	assert.equal(JSON.parse(readFileSync(lockPath(d), 'utf8')).sessionId, undefined);
	a.lock.release();
	assert.equal(JSON.parse(readFileSync(lockPath(d), 'utf8')).startedAt, 42);
});

test('update after release does not recreate the file', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	a.lock.release();
	a.lock.update({sessionId: SID});
	assert.equal(existsSync(lockPath(d)), false);
});

test('release does not follow a lock that was swapped for a symlink', () => {
	const d = dir();
	const a = acquireLock({dir: d, kind: 'chat', where: 'local'});
	assert.ok(a.ok);
	const target = join(d, 'elsewhere');
	writeFileSync(target, 'keep');
	rmSync(lockPath(d));
	symlinkSync(target, lockPath(d));
	a.lock.release();
	assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('a lock that is a directory is refused', () => {
	const d = dir();
	mkdirSync(lockPath(d));
	assert.throws(() => acquireLock({dir: d, kind: 'chat', where: 'local'}), /not a regular file|EISDIR/);
});

test('a symlinked session directory is refused by ensurePrivateDir', () => {
	const base = dir();
	const real = join(base, 'real');
	mkdirSync(real, {mode: 0o700});
	const link = join(base, 'link');
	symlinkSync(real, link);
	assert.throws(() => ensurePrivateDir(link, process.getuid!(), 'Session directory'), /not a directory/);
});

test('ensurePrivateDir refuses a directory open to others or owned by someone else', () => {
	const base = dir();
	const open = join(base, 'open');
	mkdirSync(open, {mode: 0o755});
	chmodSync(open, 0o755);
	assert.throws(() => ensurePrivateDir(open, process.getuid!(), 'Session directory'), /accessible to others/);
	const mine = join(base, 'mine');
	mkdirSync(mine, {mode: 0o700});
	assert.throws(() => ensurePrivateDir(mine, process.getuid!() + 1, 'Session directory'), /owned by another user/);
	const file = join(base, 'file');
	writeFileSync(file, '');
	assert.throws(() => ensurePrivateDir(file, process.getuid!(), 'Session directory'), /not a directory/);
});

test('ensureSessionDir refuses a symlink in place of the session directory', () => {
	const base = dir();
	const root = ensureSessionDir({base});
	rmSync(root, {recursive: true});
	const decoy = join(base, 'decoy');
	mkdirSync(decoy, {mode: 0o700});
	symlinkSync(decoy, root);
	assert.throws(() => ensureSessionDir({base}), /not a directory/);
});

test('parseLock rejects malformed fields and drops unknown ones', () => {
	assert.equal(parseLock(JSON.stringify({...valid(), pid: -1})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), pid: 1.5})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), procStart: '12ab'})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), kind: 'other'})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), where: 'cloud'})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), sessionId: '../../etc'})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), socket: 'a'.repeat(513)})), undefined);
	assert.equal(parseLock(JSON.stringify({...valid(), socket: 'a\0b'})), undefined);
	assert.equal(parseLock('[]'), undefined);
	assert.equal(parseLock('null'), undefined);
	const ok = parseLock(JSON.stringify({...valid(), extra: 1}));
	assert.ok(ok);
	assert.equal('extra' in ok, false);
});
