import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {makeFakeLog} from './helpers/fake-log.js';
import {
	describeCredential,
	inspectFileMode,
	makeRedactor,
	registerLogRedaction,
	removeStored,
	requireCredential,
	resolveCredential,
	storeApiKey,
} from '../src/credentials.js';

const KEY = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const KEY2 = 'sk-ant-api03-OTHERVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const tmp = () => mkdtemp(join(tmpdir(), 'claude-cred-'));

test('precedence: env key > env oauth > stored > legacy', async () => {
	const dir = await tmp();
	await writeFile(join(dir, '.token'), 'legacy-TESTVALUE');
	let c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source}, {kind: 'oauth', source: 'legacy-file'});
	await storeApiKey(dir, KEY2);
	c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source, v: c?.value}, {kind: 'api-key', source: 'stored', v: KEY2});
	c = await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source}, {kind: 'oauth', source: 'env'});
	c = await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source, v: c?.value}, {kind: 'api-key', source: 'env', v: KEY});
});

test('empty values are skipped and none gives undefined', async () => {
	const dir = await tmp();
	await writeFile(join(dir, '.token'), ' \n\r ');
	assert.equal(await resolveCredential({env: {ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: ''}, dataDir: dir}), undefined);
});

test('legacy parse strips internal whitespace and CRs', async () => {
	const dir = await tmp();
	await writeFile(join(dir, '.token'), 'ab cd\r\nef\n');
	assert.equal((await resolveCredential({env: {}, dataDir: dir}))?.value, 'abcdef');
});

test('corrupt or invalid stored file is skipped', async () => {
	const dir = await tmp();
	await writeFile(join(dir, 'credentials.json'), '{bad');
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
	await writeFile(join(dir, 'credentials.json'), JSON.stringify({kind: 'api-key', value: 'short'}));
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
});

test('requireCredential error text', async () => {
	const dir = await tmp();
	await assert.rejects(requireCredential({env: {}, dataDir: dir}), {
		message:
			'No credentials found. Set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
	});
});

test('credential never leaks through stringification', async () => {
	const c = await resolveCredential({env: {ANTHROPIC_API_KEY: KEY}, dataDir: await tmp()});
	assert.ok(c);
	for (const s of [JSON.stringify(c), inspect(c), `${c}`, JSON.stringify({c}), inspect({c}, {depth: 5})]) {
		assert.ok(!s.includes('TESTVALUE'), s);
	}
	assert.equal(c.value, KEY);
});

test('makeRedactor replaces literal and pattern forms', async () => {
	const c = await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: 'plainsecretvalue'}, dataDir: await tmp()});
	const r = makeRedactor(c);
	assert.equal(r('x plainsecretvalue y'), 'x [redacted] y');
	assert.equal(r(`k ${KEY} z`), 'k [redacted] z');
	assert.equal(makeRedactor()(`k ${KEY}`), 'k [redacted]');
});

test('storeApiKey rejects OAuth tokens and garbage without echoing content', async () => {
	const dir = await tmp();
	for (const bad of [OAUTH, 'garbage-TESTVALUE', 'sk-ant-x']) {
		await assert.rejects(storeApiKey(dir, bad), (e: Error) => !e.message.includes('TESTVALUE') && !e.message.includes(bad));
	}
	assert.equal(await removeStored(dir), false);
});

test('stored file is 0600 and removeStored removes only it', async () => {
	const dir = await tmp();
	await writeFile(join(dir, '.token'), 'legacy');
	await storeApiKey(dir, ` ${KEY}\n`);
	const file = join(dir, 'credentials.json');
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(file, 'utf8')).value, KEY);
	assert.equal(await removeStored(dir), true);
	assert.equal(await removeStored(dir), false);
	assert.equal(await readFile(join(dir, '.token'), 'utf8'), 'legacy');
});

test('inspectFileMode warns on 0644 only', async () => {
	const dir = await tmp();
	await writeFile(join(dir, '.token'), 'legacy-TESTVALUE');
	await chmod(join(dir, '.token'), 0o644);
	const w = await inspectFileMode(dir);
	assert.equal(w.length, 1);
	assert.ok(w[0]!.startsWith('.token'));
	assert.ok(!w[0]!.includes('TESTVALUE'));
	await chmod(join(dir, '.token'), 0o600);
	assert.deepEqual(await inspectFileMode(dir), []);
});

test('describeCredential', () => {
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'oauth', source: 'legacy-file'}), 'subscription token (from legacy file .token)');
});

test('registerLogRedaction registers once per value and logger, and the redactor masks the value', async () => {
	const dir = await tmp();
	const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
	const a = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir}))!;
	const b = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir}))!;
	const log = makeFakeLog();
	registerLogRedaction(log, a);
	registerLogRedaction(log, b);
	assert.equal(log.redactors.length, 1);
	assert.equal(log.redactors[0]!(`token=${OAUTH}`), 'token=[redacted]');
	const other = makeFakeLog();
	registerLogRedaction(other, a);
	assert.equal(other.redactors.length, 1);
	const c = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: `${OAUTH}2`}, dataDir: dir}))!;
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 2);
});
