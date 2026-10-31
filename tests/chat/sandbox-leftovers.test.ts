import assert from 'node:assert/strict';
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {Logger} from '../../../../src/api.js';
import {createLeftoverSweeper, sweepPlaceholders, type LeftoverFs} from '../../src/chat/sandbox-leftovers.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-leftovers-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
let n = 0;
const fresh = (): string => {
	const dir = path.join(tmp, `case-${n++}`);
	mkdirSync(dir, {recursive: true});
	return dir;
};

const emptyFile = (p: string, mode = 0o644) => {
	writeFileSync(p, '');
	chmodSync(p, mode);
};

const fakeLog = () => {
	const records: Array<{msg: string; meta: unknown}> = [];
	const log: Logger = {
		error: () => {},
		warn: () => {},
		info: (msg: string, meta?: unknown) => void records.push({msg, meta}),
		debug: () => {},
		child: () => log,
		addRedactor: () => {},
	} as unknown as Logger;
	return {log, records};
};

test('each placeholder signature is removed', async () => {
	const repo = fresh();
	const dir = path.join(repo, 'sub', 'dir');
	mkdirSync(path.join(dir, '.claude', '.cc-writes'), {recursive: true});
	emptyFile(path.join(dir, '.mcp.json'));
	mkdirSync(path.join(repo, '.git'));
	emptyFile(path.join(repo, '.git', 'config.lock'), 0o444);
	const result = await sweepPlaceholders([dir, dir + '/']);
	assert.deepEqual(result, {removed: 4, kinds: ['cc-writes', 'mcp-json', 'config-lock']});
	assert.equal(existsSync(path.join(dir, '.claude')), false);
	assert.equal(existsSync(path.join(dir, '.mcp.json')), false);
	assert.equal(existsSync(path.join(repo, '.git', 'config.lock')), false);
	assert.equal(existsSync(path.join(repo, '.git')), true);
});

test('anything that does not match a signature exactly is kept', async () => {
	const repo = fresh();
	mkdirSync(path.join(repo, '.git'));
	writeFileSync(path.join(repo, '.mcp.json'), '{}');
	emptyFile(path.join(repo, '.git', 'config.lock'), 0o644);
	mkdirSync(path.join(repo, '.claude', '.cc-writes'), {recursive: true});
	writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}');
	assert.deepEqual(await sweepPlaceholders([repo]), {removed: 1, kinds: ['cc-writes']});
	assert.equal(existsSync(path.join(repo, '.claude', '.cc-writes')), false);
	assert.equal(existsSync(path.join(repo, '.claude', 'settings.json')), true);
	assert.equal(existsSync(path.join(repo, '.mcp.json')), true);
	assert.equal(existsSync(path.join(repo, '.git', 'config.lock')), true);

	const full = fresh();
	mkdirSync(path.join(full, '.git'));
	writeFileSync(path.join(full, '.git', 'config.lock'), 'x');
	chmodSync(path.join(full, '.git', 'config.lock'), 0o444);
	mkdirSync(path.join(full, '.claude', '.cc-writes'), {recursive: true});
	writeFileSync(path.join(full, '.claude', '.cc-writes', 'x'), '');
	assert.deepEqual(await sweepPlaceholders([full]), {removed: 0, kinds: []});
	assert.equal(existsSync(path.join(full, '.git', 'config.lock')), true);
	assert.equal(existsSync(path.join(full, '.claude', '.cc-writes', 'x')), true);

	const asFile = fresh();
	mkdirSync(path.join(asFile, '.claude'));
	emptyFile(path.join(asFile, '.claude', '.cc-writes'));
	assert.deepEqual(await sweepPlaceholders([asFile]), {removed: 0, kinds: []});
	assert.equal(existsSync(path.join(asFile, '.claude', '.cc-writes')), true);
});

test('symlinks are never followed or removed', async () => {
	const dir = fresh();
	const targets = fresh();
	emptyFile(path.join(targets, 'empty'));
	mkdirSync(path.join(targets, 'emptydir'));
	emptyFile(path.join(targets, 'lock'), 0o444);
	symlinkSync(path.join(targets, 'empty'), path.join(dir, '.mcp.json'));
	mkdirSync(path.join(dir, '.claude'));
	symlinkSync(path.join(targets, 'emptydir'), path.join(dir, '.claude', '.cc-writes'));
	mkdirSync(path.join(dir, '.git'));
	symlinkSync(path.join(targets, 'lock'), path.join(dir, '.git', 'config.lock'));
	assert.deepEqual(await sweepPlaceholders([dir]), {removed: 0, kinds: []});
	for (const p of [path.join(dir, '.mcp.json'), path.join(dir, '.claude', '.cc-writes'), path.join(dir, '.git', 'config.lock')]) {
		assert.equal(lstatSync(p).isSymbolicLink(), true, p);
	}
	for (const t of ['empty', 'emptydir', 'lock']) assert.equal(existsSync(path.join(targets, t)), true, t);
});

test('a .git file (worktree) stops the repo search without lock handling', async () => {
	const outer = fresh();
	mkdirSync(path.join(outer, '.git'));
	emptyFile(path.join(outer, '.git', 'config.lock'), 0o444);
	const worktree = path.join(outer, 'wt');
	mkdirSync(worktree);
	writeFileSync(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/wt\n');
	assert.deepEqual(await sweepPlaceholders([worktree]), {removed: 0, kinds: []});
	assert.equal(existsSync(path.join(outer, '.git', 'config.lock')), true);
});

test('a missing dir is ignored', async () => {
	assert.deepEqual(await sweepPlaceholders([path.join(tmp, 'missing', 'dir')]), {removed: 0, kinds: []});
});

test('failed removals do not throw and are not counted', async () => {
	const dir = fresh();
	mkdirSync(path.join(dir, '.claude', '.cc-writes'), {recursive: true});
	emptyFile(path.join(dir, '.mcp.json'));
	const fail = (code: string) => async () => {
		throw Object.assign(new Error(code), {code});
	};
	const failing: LeftoverFs = {lstat: fsp.lstat, readdir: fsp.readdir, rmdir: fail('EBUSY'), unlink: fail('EACCES')} as LeftoverFs;
	assert.deepEqual(await sweepPlaceholders([dir], failing), {removed: 0, kinds: []});
	const unlinkOnly: LeftoverFs = {...failing, unlink: fsp.unlink} as LeftoverFs;
	assert.deepEqual(await sweepPlaceholders([dir], unlinkOnly), {removed: 1, kinds: ['mcp-json']});
	assert.equal(existsSync(path.join(dir, '.claude', '.cc-writes')), true);
});

test('the sweeper waits until no Bash call is in flight and sweeps every pending cwd', async () => {
	const a = fresh();
	const b = fresh();
	mkdirSync(path.join(a, '.claude', '.cc-writes'), {recursive: true});
	mkdirSync(path.join(b, '.claude', '.cc-writes'), {recursive: true});
	const {log, records} = fakeLog();
	const sweeper = createLeftoverSweeper({dirs: () => [], log});
	sweeper.begin('a');
	sweeper.begin('b');
	await sweeper.end('a', a);
	assert.equal(existsSync(path.join(a, '.claude', '.cc-writes')), true);
	assert.equal(records.length, 0);
	await sweeper.end('b', b);
	assert.equal(existsSync(path.join(a, '.claude')), false);
	assert.equal(existsSync(path.join(b, '.claude')), false);
	assert.deepEqual(records, [{msg: 'sandbox leftovers removed', meta: {removed: 4, kinds: ['cc-writes']}}]);
	await sweeper.end('b', b);
	assert.equal(records.length, 1, 'nothing removed, nothing logged');
});

test('an unknown id sweeps and never makes the count negative', async () => {
	const dir = fresh();
	const {log} = fakeLog();
	const sweeper = createLeftoverSweeper({dirs: () => [dir], log});
	await sweeper.end('unknown');
	await sweeper.end('unknown');
	sweeper.begin('x');
	mkdirSync(path.join(dir, '.claude', '.cc-writes'), {recursive: true});
	await sweeper.end('other');
	assert.equal(existsSync(path.join(dir, '.claude', '.cc-writes')), true, 'x is still in flight');
	await sweeper.end('x');
	assert.equal(existsSync(path.join(dir, '.claude')), false);
});

test('a call that never ended is dropped once stale', async () => {
	const dir = fresh();
	let clock = 0;
	const {log} = fakeLog();
	const sweeper = createLeftoverSweeper({dirs: () => [dir], log, now: () => clock, staleMs: 1000});
	sweeper.begin('lost');
	clock = 500;
	sweeper.begin('y');
	mkdirSync(path.join(dir, '.claude', '.cc-writes'), {recursive: true});
	clock = 1200;
	await sweeper.end('y');
	assert.equal(existsSync(path.join(dir, '.claude')), false);
});

test('the start sweep uses the dirs getter and extra dirs', async () => {
	const dir = fresh();
	const extra = fresh();
	emptyFile(path.join(dir, '.mcp.json'));
	emptyFile(path.join(extra, '.mcp.json'));
	const {log, records} = fakeLog();
	await createLeftoverSweeper({dirs: () => [dir], log}).sweep([extra]);
	assert.deepEqual(records, [{msg: 'sandbox leftovers removed', meta: {removed: 2, kinds: ['mcp-json']}}]);
});

test('the sweeper never throws when the filesystem fails', async () => {
	const boom = async () => {
		throw new Error('EIO');
	};
	const broken: LeftoverFs = {lstat: boom, readdir: boom, rmdir: boom, unlink: boom} as LeftoverFs;
	const {log, records} = fakeLog();
	const sweeper = createLeftoverSweeper({dirs: () => [tmp], log, fs: broken});
	await sweeper.sweep();
	sweeper.begin('a');
	await sweeper.end('a', tmp);
	assert.equal(records.length, 0);
});

test('a cwd outside the configured dirs is swept once and then forgotten', async () => {
	const outside = fresh();
	mkdirSync(path.join(outside, '.claude', '.cc-writes'), {recursive: true});
	const {log} = fakeLog();
	const sweeper = createLeftoverSweeper({dirs: () => [], log});
	sweeper.begin('a');
	await sweeper.end('a', outside);
	assert.equal(existsSync(path.join(outside, '.claude')), false);
	mkdirSync(path.join(outside, '.claude', '.cc-writes'), {recursive: true});
	await sweeper.end('unknown');
	assert.equal(existsSync(path.join(outside, '.claude', '.cc-writes')), true);
});
