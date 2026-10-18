import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, test} from 'node:test';
import {buildPreview} from '../../src/chat/preview.js';
import type {Scope} from '../../src/policy.js';

let base: string;
let root: string;
let outside: string;
let scope: Scope;

before(async () => {
	base = await realpath(await mkdtemp(path.join(tmpdir(), 'claude-preview-')));
	root = path.join(base, 'project');
	outside = path.join(base, 'outside');
	await mkdir(root);
	await mkdir(outside);
	await mkdir(path.join(root, '.yena'));
	scope = {roots: [root], denied: [path.join(root, '.yena')]};
});

after(async () => {
	await rm(base, {recursive: true, force: true});
});

const texts = (p: {rows: {text: string}[]} | undefined) => (p?.rows ?? []).map(r => r.text);

test('Edit shows real context and line numbers', async () => {
	await writeFile(path.join(root, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
	const p = await buildPreview('Edit', {file_path: 'a.txt', old_string: 'l5', new_string: 'FIVE'}, scope);
	assert.ok(p);
	const del = p.rows.find(r => r.kind === 'del');
	assert.deepEqual(del, {kind: 'del', text: 'l5', no: 5});
	assert.equal(p.approximate, false);
	assert.ok(texts(p).includes('l2'));
});

test('Edit warns on not found and non-unique', async () => {
	await writeFile(path.join(root, 'b.txt'), 'dup\nx\ndup\n');
	const missing = await buildPreview('Edit', {file_path: 'b.txt', old_string: 'zzz', new_string: 'y'}, scope);
	assert.equal(missing?.rows[0]?.text, 'old_string not found in the current file');
	assert.equal(missing?.approximate, true);
	const many = await buildPreview('Edit', {file_path: 'b.txt', old_string: 'dup', new_string: 'y'}, scope);
	assert.equal(many?.rows[0]?.text, 'matches 2 places; Edit will fail unless unique');
	const all = await buildPreview(
		'Edit',
		{file_path: 'b.txt', old_string: 'dup', new_string: 'y', replace_all: true},
		scope,
	);
	assert.equal(all?.rows[0]?.text, 'replace_all: 2 occurrences');
	assert.equal(all?.removed, 2);
});

test('Edit on a missing file shows only the proposed edit', async () => {
	const p = await buildPreview('Edit', {file_path: 'nope.txt', old_string: 'a', new_string: 'b'}, scope);
	assert.match(p?.rows[0]?.text ?? '', /does not exist/);
	assert.equal(p?.approximate, true);
});

test('Write: new file, overwrite diff', async () => {
	const fresh = await buildPreview('Write', {file_path: 'new.txt', content: 'hello\n'}, scope);
	assert.equal(fresh?.rows[0]?.kind, 'add');
	assert.equal(fresh?.added, 1);
	await writeFile(path.join(root, 'old.txt'), 'one\ntwo\n');
	const over = await buildPreview('Write', {file_path: 'old.txt', content: 'one\nthree\n'}, scope);
	assert.deepEqual(over?.rows.map(r => r.kind), ['ctx', 'del', 'add']);
	const same = await buildPreview('Write', {file_path: 'old.txt', content: 'one\ntwo\n'}, scope);
	assert.match(same?.rows[0]?.text ?? '', /identical/);
});

test('files over 256 KiB and NUL bytes give no detailed preview', async () => {
	await writeFile(path.join(root, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
	const big = await buildPreview('Write', {file_path: 'big.txt', content: 'new'}, scope);
	assert.equal(big?.rows[0]?.text, `overwrites existing file (${256 * 1024 + 1} bytes), no preview`);
	assert.equal(big?.approximate, true);
	await writeFile(path.join(root, 'bin.dat'), Buffer.from([65, 0, 66]));
	const bin = await buildPreview('Write', {file_path: 'bin.dat', content: 'new'}, scope);
	assert.match(bin?.rows[0]?.text ?? '', /overwrites existing file \(3 bytes\), no preview/);
	const edit = await buildPreview('Edit', {file_path: 'bin.dat', old_string: 'A', new_string: 'B'}, scope);
	assert.match(edit?.rows[0]?.text ?? '', /not readable/);
});

test('secret and denied paths are not read', async () => {
	await writeFile(path.join(root, '.env'), 'SECRET=sk-fake-value\n');
	await writeFile(path.join(root, '.yena', 'state.json'), 'SECRET=fake\n');
	for (const file of ['.env', '.yena/state.json']) {
		const p = await buildPreview('Edit', {file_path: file, old_string: 'SECRET', new_string: 'X'}, scope);
		assert.ok(!texts(p).some(t => t.includes('sk-fake') || t.includes('fake')));
		assert.match(p?.rows[0]?.text ?? '', /not readable/);
		const w = await buildPreview('Write', {file_path: file, content: 'x'}, scope);
		assert.equal(w?.rows[0]?.text, 'overwrites existing file, no preview');
	}
});

test('paths outside the scope and symlinks out are refused', async () => {
	await writeFile(path.join(outside, 'o.txt'), 'outside-secret\n');
	await symlink(path.join(outside, 'o.txt'), path.join(root, 'link.txt'));
	await symlink(outside, path.join(root, 'dirlink'));
	for (const file of [path.join(outside, 'o.txt'), 'link.txt', 'dirlink/o.txt', '../outside/o.txt']) {
		const p = await buildPreview('Edit', {file_path: file, old_string: 'outside', new_string: 'x'}, scope);
		assert.ok(!texts(p).some(t => t.includes('outside-secret')), file);
		const w = await buildPreview('Write', {file_path: file, content: 'x'}, scope);
		assert.equal(w?.rows[0]?.text, 'overwrites existing file, no preview', file);
	}
});

test('a symlink inside the scope is not followed (O_NOFOLLOW)', async () => {
	await writeFile(path.join(root, 'target.txt'), 'target-content\n');
	await symlink(path.join(root, 'target.txt'), path.join(root, 'inlink.txt'));
	const p = await buildPreview('Edit', {file_path: 'inlink.txt', old_string: 'target', new_string: 'x'}, scope);
	assert.ok(!texts(p).includes('target-content'));
});

test('directories give no preview and a FIFO does not hang', async () => {
	await mkdir(path.join(root, 'sub'));
	const dir = await buildPreview('Write', {file_path: 'sub', content: 'x'}, scope);
	assert.equal(dir?.rows[0]?.text, 'overwrites existing file, no preview');
	const fifo = path.join(root, 'pipe');
	try {
		execFileSync('mkfifo', [fifo]);
	} catch {
		return;
	}
	const start = Date.now();
	const p = await buildPreview('Write', {file_path: 'pipe', content: 'x'}, scope);
	assert.ok(Date.now() - start < 1000);
	assert.equal(p?.rows[0]?.text, 'overwrites existing file, no preview');
});

test('huge old_string and new_string are capped', async () => {
	const big = 'z'.repeat(300_000);
	const start = Date.now();
	const p = await buildPreview('Edit', {file_path: 'a.txt', old_string: big, new_string: `${big}!`}, scope);
	assert.ok(Date.now() - start < 1000);
	assert.equal(p?.approximate, true);
	assert.ok((p?.rows.length ?? 0) < 10);
});

test('malformed input yields undefined, never a throw', async () => {
	assert.equal(await buildPreview('Edit', {}, scope), undefined);
	assert.equal(await buildPreview('Write', {file_path: 5, content: 'x'}, scope), undefined);
	assert.equal(await buildPreview('Write', {file_path: 'a.txt'}, scope), undefined);
	assert.equal(await buildPreview('Edit', null as unknown as Record<string, unknown>, scope), undefined);
	assert.equal(await buildPreview('Bash' as 'Edit', {file_path: 'a.txt'}, scope), undefined);
	const nul = await buildPreview('Write', {file_path: 'a\0b', content: 'x'}, scope);
	assert.equal(nul?.rows[0]?.text, 'overwrites existing file, no preview');
});

test('an aborted signal stops reading', async () => {
	const ac = new AbortController();
	ac.abort();
	const p = await buildPreview('Edit', {file_path: 'a.txt', old_string: 'l5', new_string: 'x'}, scope, ac.signal);
	assert.match(p?.rows[0]?.text ?? '', /not readable/);
});
