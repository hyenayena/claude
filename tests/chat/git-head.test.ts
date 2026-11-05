import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {parseHead, readGitBranch} from '../../src/chat/git-head.js';

const HASH = 'a'.repeat(40);

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'git-head-'));
}

test('parseHead: a branch, a detached hash, anything else', () => {
	assert.equal(parseHead('ref: refs/heads/feature/x\n'), 'feature/x');
	assert.equal(parseHead(`${HASH}\n`), 'aaaaaaa');
	assert.equal(parseHead('ref: refs/tags/v1\n'), undefined);
	assert.equal(parseHead('garbage'), undefined);
	assert.equal(parseHead(''), undefined);
});

test('a branch is read from .git/HEAD of the directory and of a parent', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, '.git'));
		writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/develop\n');
		mkdirSync(join(root, 'a', 'b'), {recursive: true});
		assert.equal(await readGitBranch(root), 'develop');
		assert.equal(await readGitBranch(join(root, 'a', 'b')), 'develop');
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('a detached head gives 7 characters', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, '.git'));
		writeFileSync(join(root, '.git', 'HEAD'), HASH);
		assert.equal(await readGitBranch(root), 'aaaaaaa');
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('a worktree .git file points to the git dir, relative or absolute', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, 'real', 'wt'), {recursive: true});
		writeFileSync(join(root, 'real', 'wt', 'HEAD'), 'ref: refs/heads/wt-branch\n');
		mkdirSync(join(root, 'w1'));
		writeFileSync(join(root, 'w1', '.git'), 'gitdir: ../real/wt\n');
		mkdirSync(join(root, 'w2'));
		writeFileSync(join(root, 'w2', '.git'), `gitdir: ${join(root, 'real', 'wt')}\n`);
		assert.equal(await readGitBranch(join(root, 'w1')), 'wt-branch');
		assert.equal(await readGitBranch(join(root, 'w2')), 'wt-branch');
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('missing, oversized and garbage files give no branch', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, 'none'));
		mkdirSync(join(root, 'big', '.git'), {recursive: true});
		writeFileSync(join(root, 'big', '.git', 'HEAD'), `ref: refs/heads/${'x'.repeat(10_000)}\n`);
		mkdirSync(join(root, 'junk', '.git'), {recursive: true});
		writeFileSync(join(root, 'junk', '.git', 'HEAD'), '\u0000\u0001 not a head');
		mkdirSync(join(root, 'bigfile'));
		writeFileSync(join(root, 'bigfile', '.git'), `gitdir: ${'y'.repeat(10_000)}`);
		assert.equal(await readGitBranch(join(root, 'big')), undefined);
		assert.equal(await readGitBranch(join(root, 'junk')), undefined);
		assert.equal(await readGitBranch(join(root, 'bigfile')), undefined);
		assert.equal(await readGitBranch(join(root, 'does-not-exist')), undefined);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('a symlinked HEAD or .git is not followed, and a loop ends without a branch', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, 'real'));
		writeFileSync(join(root, 'real', 'HEAD'), 'ref: refs/heads/secret\n');
		mkdirSync(join(root, 'a', '.git'), {recursive: true});
		symlinkSync(join(root, 'real', 'HEAD'), join(root, 'a', '.git', 'HEAD'));
		assert.equal(await readGitBranch(join(root, 'a')), undefined);
		mkdirSync(join(root, 'b'));
		symlinkSync(join(root, 'b', '.git'), join(root, 'b', '.git'));
		assert.equal(await readGitBranch(join(root, 'b')), undefined);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});

test('only a bounded number of parents is walked', async () => {
	const root = tmp();
	try {
		mkdirSync(join(root, '.git'));
		writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/far\n');
		const near = join(root, ...Array.from({length: 10}, () => 'd'));
		const far = join(root, ...Array.from({length: 30}, () => 'd'));
		mkdirSync(far, {recursive: true});
		assert.equal(await readGitBranch(near), 'far');
		assert.equal(await readGitBranch(far), undefined);
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});
