import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {makeFakeLog} from './helpers/fake-log.js';
import {buildEnv, resolvePaths} from '../src/config.js';
import type {LoginProbe, LoginStatus} from '../src/claude-login.js';
import {
	describeCredential,
	inspectFileMode,
	listCredentialSources,
	makeRedactor,
	registerLogRedaction,
	removeStored,
	requireCredential,
	resolveCredential,
	storeApiKey,
	storeOauthToken,
} from '../src/credentials.js';

const KEY = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const KEY2 = 'sk-ant-api03-OTHERVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const tmp = () => mkdtemp(join(tmpdir(), 'claude-cred-'));

test('precedence: env key > env oauth > stored', async () => {
	const dir = await tmp();
	let c = await resolveCredential({env: {}, dataDir: dir});
	assert.equal(c, undefined);
	await storeOauthToken(dir, OAUTH);
	c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source, v: c?.value}, {kind: 'oauth', source: 'stored', v: OAUTH});
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
	assert.equal(await resolveCredential({env: {ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: ''}, dataDir: dir}), undefined);
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
			'No credentials found. Set ANTHROPIC_API_KEY, run "claude auth login", or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
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
	await writeFile(join(dir, 'other.txt'), 'keep');
	await storeApiKey(dir, ` ${KEY}\n`);
	const file = join(dir, 'credentials.json');
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(file, 'utf8')).value, KEY);
	assert.equal(await removeStored(dir), true);
	assert.equal(await removeStored(dir), false);
	assert.equal(await readFile(join(dir, 'other.txt'), 'utf8'), 'keep');
});

test('stored oauth token reads as oauth/stored with its value', async () => {
	const dir = await tmp();
	await storeOauthToken(dir, ` ${OAUTH}\n`);
	const file = join(dir, 'credentials.json');
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	const body = JSON.parse(await readFile(file, 'utf8'));
	assert.equal(body.kind, 'oauth');
	assert.equal(body.value, OAUTH);
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source, v: c?.value}, {kind: 'oauth', source: 'stored', v: OAUTH});
});

test('stored files with a mismatched kind or invalid value are skipped', async () => {
	const dir = await tmp();
	const file = join(dir, 'credentials.json');
	for (const body of [
		{kind: 'oauth', value: KEY},
		{kind: 'oauth', value: 'sk-ant-oat-short'},
		{kind: 'api-key', value: OAUTH},
		{kind: 'other', value: KEY},
		{kind: 'oauth', value: 42},
	]) {
		await writeFile(file, JSON.stringify(body));
		assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined, JSON.stringify(body));
	}
});

test('an old api-key credentials.json still reads', async () => {
	const dir = await tmp();
	await writeFile(join(dir, 'credentials.json'), JSON.stringify({kind: 'api-key', value: KEY, savedAt: '2026-01-01T00:00:00.000Z'}));
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, source: c?.source, v: c?.value}, {kind: 'api-key', source: 'stored', v: KEY});
});

test('the stored slot is shared: the latest write replaces the other kind', async () => {
	const dir = await tmp();
	await storeApiKey(dir, KEY);
	await storeOauthToken(dir, OAUTH);
	assert.equal((await resolveCredential({env: {}, dataDir: dir}))?.kind, 'oauth');
	await storeApiKey(dir, KEY2);
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({kind: c?.kind, v: c?.value}, {kind: 'api-key', v: KEY2});
	await assert.rejects(storeOauthToken(dir, 'sk-ant-api03-nope'), (e: Error) => !e.message.includes('nope'));
});

test('storeApiKey points an OAuth token to "claude auth login --token"', async () => {
	await assert.rejects(storeApiKey(await tmp(), OAUTH), {
		message:
			'This looks like a subscription (OAuth) token, not an API key. Run "claude auth login --token" or set CLAUDE_CODE_OAUTH_TOKEN instead.',
	});
});

test('inspectFileMode warns on 0644 only', async () => {
	const dir = await tmp();
	await storeApiKey(dir, KEY);
	await chmod(join(dir, 'credentials.json'), 0o644);
	const w = await inspectFileMode(dir);
	assert.equal(w.length, 1);
	assert.ok(w[0]!.startsWith('credentials.json'));
	assert.ok(!w[0]!.includes('TESTVALUE'));
	await chmod(join(dir, 'credentials.json'), 0o600);
	assert.deepEqual(await inspectFileMode(dir), []);
});

test('describeCredential', () => {
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'oauth', source: 'stored'}), 'subscription token (stored by yena)');
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

const loginProbe = (status: LoginStatus | undefined): LoginProbe => async () => status;
const writeLoginFile = async (dir: string, body = 'LOGINSECRETMARKER'): Promise<string> => {
	await mkdir(join(dir, 'config'), {recursive: true});
	const file = join(dir, 'config', '.credentials.json');
	await writeFile(file, body);
	return file;
};
const shape = (c?: {kind: string; source: string}) => c && {kind: c.kind, source: c.source};

test('login tier: probe result sits between env and stored', async () => {
	const dir = await tmp();
	await storeApiKey(dir, KEY2);
	const probe = loginProbe({loggedIn: true, method: 'claude.ai'});
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir, probeLogin: probe})), {kind: 'oauth', source: 'claude-login'});
	assert.deepEqual(shape(await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir, probeLogin: probe})), {kind: 'oauth', source: 'env'});
	assert.deepEqual(shape(await resolveCredential({env: {ANTHROPIC_API_KEY: KEY}, dataDir: dir, probeLogin: probe})), {kind: 'api-key', source: 'env'});
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir})), {kind: 'api-key', source: 'stored'});
});

test('login tier: console login is an api-key credential', async () => {
	const c = await resolveCredential({env: {}, dataDir: await tmp(), probeLogin: loginProbe({loggedIn: true, method: 'console'})});
	assert.deepEqual(shape(c), {kind: 'api-key', source: 'claude-login'});
});

test('login tier: probe loggedIn:false beats the file, undefined falls back to it', async () => {
	const dir = await tmp();
	await writeLoginFile(dir);
	assert.equal(await resolveCredential({env: {}, dataDir: dir, probeLogin: loginProbe({loggedIn: false})}), undefined);
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir, probeLogin: loginProbe(undefined)})), {kind: 'oauth', source: 'claude-login'});
	const throwing: LoginProbe = async () => {
		throw new Error('boom');
	};
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir, probeLogin: throwing})), {kind: 'oauth', source: 'claude-login'});
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir})), {kind: 'oauth', source: 'claude-login'});
});

test('login file fallback ignores symlinks, empty files and directories', async () => {
	const dir = await tmp();
	await mkdir(join(dir, 'config'), {recursive: true});
	const file = join(dir, 'config', '.credentials.json');
	await writeFile(file, '');
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
	await rm(file);
	await writeFile(join(dir, 'target'), 'x');
	await symlink(join(dir, 'target'), file);
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
	await rm(file);
	await mkdir(file);
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
});

test('login credential has an empty value and never exposes the file content', async () => {
	const dir = await tmp();
	await writeLoginFile(dir);
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.ok(c);
	assert.equal(c.value, '');
	for (const s of [JSON.stringify(c), inspect(c), `${c}`]) assert.ok(!s.includes('LOGINSECRETMARKER'), s);
});

test('registerLogRedaction is a noop for an empty value', async () => {
	const dir = await tmp();
	await writeLoginFile(dir);
	const c = await resolveCredential({env: {}, dataDir: dir});
	const log = makeFakeLog();
	let added = 0;
	const spy = {...log, addRedactor: () => void added++} as unknown as Parameters<typeof registerLogRedaction>[0];
	registerLogRedaction(spy, c!);
	assert.equal(added, 0);
});

test('listCredentialSources lists every source in precedence order', async () => {
	const dir = await tmp();
	await storeApiKey(dir, KEY2);
	const list = await listCredentialSources({
		env: {ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		dataDir: dir,
		probeLogin: loginProbe({loggedIn: true, method: 'claude.ai'}),
	});
	assert.deepEqual(
		list.map(c => `${c.source}:${c.kind}`),
		['env:api-key', 'env:oauth', 'claude-login:oauth', 'stored:api-key'],
	);
	assert.deepEqual(await listCredentialSources({env: {}, dataDir: await tmp()}), []);
});

test('describeCredential texts', () => {
	assert.equal(describeCredential({kind: 'oauth', source: 'claude-login'}), 'Claude subscription (Claude Code login)');
	assert.equal(describeCredential({kind: 'api-key', source: 'claude-login'}), 'Console API key (Claude Code login)');
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
});

test('inspectFileMode warns about a group-readable login file', async () => {
	const dir = await tmp();
	const file = await writeLoginFile(dir);
	await chmod(file, 0o644);
	const w = await inspectFileMode(dir);
	assert.equal(w.length, 1);
	assert.match(w[0]!, /\.credentials\.json is readable by other users/);
	await chmod(file, 0o600);
	assert.deepEqual(await inspectFileMode(dir), []);
});

test('a stored oauth token reaches the SDK env as CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY', async () => {
	const dir = await tmp();
	await storeOauthToken(dir, OAUTH);
	const cred = await requireCredential({env: {}, dataDir: dir});
	assert.equal(cred.kind, 'oauth');
	assert.equal(cred.source, 'stored');
	const env = buildEnv({}, resolvePaths(dir), cred);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
	assert.ok(!('ANTHROPIC_API_KEY' in env));
});

test('a stored api key replacing a stored oauth token flips the env mapping', async () => {
	const dir = await tmp();
	await storeOauthToken(dir, OAUTH);
	await storeApiKey(dir, KEY);
	const cred = await requireCredential({env: {}, dataDir: dir});
	const env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: 'stale'}, resolvePaths(dir), cred);
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
});

test('the redactor and log registration mask a stored oauth token', async () => {
	const dir = await tmp();
	await storeOauthToken(dir, OAUTH);
	const cred = await requireCredential({env: {}, dataDir: dir});
	assert.ok(!makeRedactor(cred)(`x ${OAUTH} y`).includes(OAUTH));
	let added = 0;
	const spy = {...makeFakeLog(), addRedactor: () => void added++} as unknown as Parameters<typeof registerLogRedaction>[0];
	registerLogRedaction(spy, cred);
	assert.equal(added, 1);
});
