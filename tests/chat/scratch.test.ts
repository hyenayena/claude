import assert from 'node:assert/strict';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {createScratch, SCRATCH_ORPHAN_MS, scratchParentOf, sweepScratch} from '../../src/chat/scratch.js';
import {noopLog} from '../../src/log.js';
import {procStart} from '../../src/sessions/proc.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-scratch-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const uid = process.getuid?.() ?? 0;
let n = 0;
const fresh = () => {
	const sessionTmp = path.join(tmp, `s${n++}`);
	mkdirSync(path.join(sessionTmp, 'scratch'), {recursive: true, mode: 0o700});
	return {sessionTmp, parent: scratchParentOf(sessionTmp)};
};
const seed = (parent: string, id: string, owner?: unknown) => {
	mkdirSync(path.join(parent, id), {mode: 0o700});
	writeFileSync(path.join(parent, `${id}.owner`), owner === undefined ? 'junk' : JSON.stringify({v: 1, ...(owner as object)}));
};
const deps = {alive: (pid: number) => pid === 4242, procStartOf: () => '77'};

describe('createScratch', () => {
	it('creates a private dir and an owner file', () => {
		const {sessionTmp, parent} = fresh();
		const s = createScratch({sessionTmp, uid, log: noopLog, randomId: () => 'abcdef01'});
		assert.equal(s?.dir, path.join(parent, 'abcdef01'));
		assert.equal(lstatSync(s!.dir).mode & 0o777, 0o700);
		const owner = JSON.parse(readFileSync(`${s!.dir}.owner`, 'utf8')) as {v: number; pid: number; procStart: string};
		assert.equal(owner.pid, process.pid);
		assert.equal(owner.procStart, procStart(process.pid));
	});

	it('retries on a taken id', () => {
		const {sessionTmp} = fresh();
		const ids = ['aaaaaaaa', 'aaaaaaaa', 'bbbbbbbb'];
		const first = createScratch({sessionTmp, uid, log: noopLog, randomId: () => ids.shift()!});
		const second = createScratch({sessionTmp, uid, log: noopLog, randomId: () => ids.shift() ?? 'bbbbbbbb'});
		assert.ok(first && second);
		assert.notEqual(first.dir, second.dir);
	});

	it('removes both entries, idempotently', () => {
		const {sessionTmp} = fresh();
		const s = createScratch({sessionTmp, uid, log: noopLog})!;
		writeFileSync(path.join(s.dir, 'f'), 'x');
		s.remove();
		assert.equal(existsSync(s.dir), false);
		assert.equal(existsSync(`${s.dir}.owner`), false);
		s.remove();
	});

	it('returns undefined when the scratch parent is a symlink', () => {
		const {sessionTmp, parent} = fresh();
		const target = path.join(tmp, 'elsewhere');
		mkdirSync(target, {mode: 0o700});
		rmSync(parent, {recursive: true});
		symlinkSync(target, parent);
		assert.equal(createScratch({sessionTmp, uid, log: noopLog}), undefined);
		assert.deepEqual(sweepScratch(parent), 0);
	});
});

describe('sweepScratch', () => {
	it('removes dead owners and procStart mismatches, keeps live ones and our own', () => {
		const {parent} = fresh();
		seed(parent, '00000001', {pid: 999999, procStart: '77'});
		seed(parent, '00000002', {pid: 4242, procStart: '1'});
		seed(parent, '00000003', {pid: 4242, procStart: '77'});
		seed(parent, '00000004', {pid: process.pid, procStart: procStart(process.pid)});
		const removed = sweepScratch(parent, {alive: (pid: number) => pid === 4242 || pid === process.pid, procStartOf: (pid: number) => (pid === process.pid ? procStart(pid) : '77')});
		assert.equal(removed, 2);
		assert.deepEqual([1, 2, 3, 4].map(i => existsSync(path.join(parent, `0000000${i}`))), [false, false, true, true]);
		assert.equal(existsSync(path.join(parent, '00000001.owner')), false);
	});

	it('keeps a live owner when the start time cannot be read now', () => {
		const {parent} = fresh();
		seed(parent, '00000007', {pid: 4242, procStart: '77'});
		assert.equal(sweepScratch(parent, {alive: () => true, procStartOf: () => undefined}), 0);
		assert.equal(existsSync(path.join(parent, '00000007')), true);
	});

	it('keeps an ownerless dir while young and removes it after an hour', () => {
		const {parent} = fresh();
		seed(parent, '00000005');
		rmSync(path.join(parent, '00000005.owner'));
		assert.equal(sweepScratch(parent, deps), 0);
		assert.equal(sweepScratch(parent, {...deps, now: () => Date.now() + SCRATCH_ORPHAN_MS + 60_000}), 1);
		assert.equal(existsSync(path.join(parent, '00000005')), false);
	});

	it('unlinks a symlink entry and leaves its target alone', () => {
		const {parent} = fresh();
		const target = path.join(tmp, `target${n++}`);
		mkdirSync(target);
		writeFileSync(path.join(target, 'keep'), 'x');
		symlinkSync(target, path.join(parent, '00000006'));
		writeFileSync(path.join(parent, '00000006.owner'), JSON.stringify({v: 1, pid: 999999, procStart: '1'}));
		assert.equal(sweepScratch(parent, deps), 1);
		assert.equal(existsSync(path.join(parent, '00000006')), false);
		assert.equal(existsSync(path.join(target, 'keep')), true);
	});

	it('leaves foreign names alone', () => {
		const {parent} = fresh();
		mkdirSync(path.join(parent, 'notes'));
		writeFileSync(path.join(parent, 'README'), 'x');
		const old = new Date(Date.now() - 10 * SCRATCH_ORPHAN_MS);
		utimesSync(path.join(parent, 'notes'), old, old);
		assert.equal(sweepScratch(parent, deps), 0);
		assert.equal(existsSync(path.join(parent, 'notes')), true);
		assert.equal(existsSync(path.join(parent, 'README')), true);
	});
});
