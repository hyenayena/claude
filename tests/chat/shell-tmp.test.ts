import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ensureShellTmp, shellTmpRoot} from '../../src/chat/shell-tmp.js';

const uid = process.getuid?.() ?? 0;
const base = () => mkdtempSync(join(tmpdir(), 'shell-tmp-'));

test('creates a private directory and accepts it again', () => {
	const b = base();
	const dir = ensureShellTmp({base: b, uid});
	assert.equal(dir, shellTmpRoot(uid, b));
	assert.equal(statSync(dir).mode & 0o077, 0);
	assert.equal(ensureShellTmp({base: b, uid}), dir);
});

test('rejects a directory open to others', () => {
	const b = base();
	const dir = shellTmpRoot(uid, b);
	mkdirSync(dir);
	chmodSync(dir, 0o755);
	assert.throws(() => ensureShellTmp({base: b, uid}), /accessible to others/);
});

test('rejects a symlink', () => {
	const b = base();
	const target = join(b, 'target');
	mkdirSync(target, {mode: 0o700});
	symlinkSync(target, shellTmpRoot(uid, b));
	assert.throws(() => ensureShellTmp({base: b, uid}), /not a directory/);
});

test('rejects another owner', () => {
	const b = base();
	assert.throws(() => ensureShellTmp({base: b, uid: uid + 1}).toString(), /other user/);
});
