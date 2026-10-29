import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {readAuth, writeAuth} from '../src/accounts.js';
import {createLoginSync} from '../src/login-sync.js';
import {hostVault} from '../src/vault.js';
import {fakeCredentials, seed} from './helpers/fake-credentials.js';
import {makeFakeLog, serialized} from './helpers/fake-log.js';

const who = (email: string, uuid: string) => ({emailAddress: email, accountUuid: uuid});
const ALICE = who('alice@example.com', 'uuid-alice');
const BOB = who('bob@example.com', 'uuid-bob');
const blob = (acct: object, token: string, expiresAt: number) =>
	JSON.stringify({credentials: {claudeAiOauth: {accessToken: token, refreshToken: `${token}-r`, expiresAt}}, oauthAccount: acct});

const setup = async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-sync-'));
	const configDir = join(dataDir, 'config');
	await mkdir(configDir, {recursive: true});
	const fake = fakeCredentials();
	seed(fake, 'alice', 'claude-login', blob(ALICE, 'ALICE-STORED-0123456789', 1000));
	const log = makeFakeLog();
	const vault = hostVault(fake, log);
	await vault.load();
	writeAuth(dataDir, {v: 1, order: [], limits: {}, installed: 'alice'});
	const sync = createLoginSync({dataDir, configDir, vault, log});
	const workingCopy = async (acct: object, token: string, expiresAt: number) => {
		const b = JSON.parse(blob(acct, token, expiresAt));
		await writeFile(join(configDir, '.credentials.json'), JSON.stringify(b.credentials));
		await writeFile(join(configDir, '.claude.json'), JSON.stringify({oauthAccount: acct}));
	};
	const stored = (name: string) => JSON.parse(fake.accounts.get(name)!.secrets.login!).credentials.claudeAiOauth.accessToken as string;
	return {dataDir, configDir, fake, log, vault, sync, workingCopy, stored};
};

test('a refreshed login is detected and written back; then the working copy is clean', async () => {
	const s = await setup();
	assert.equal(await s.sync.sync(), 'clean', 'no working copy');
	await s.workingCopy(ALICE, 'ALICE-STORED-0123456789', 1000);
	assert.equal(s.sync.dirty(), false);
	assert.equal(await s.sync.sync(), 'clean');
	await s.workingCopy(ALICE, 'ALICE-REFRESHED-0123456789', 2000);
	assert.equal(s.sync.dirty(), true);
	assert.equal(s.sync.changed(), true);
	assert.equal(s.sync.changed(), false);
	assert.equal(await s.sync.sync(), 'saved');
	assert.equal(s.stored('alice'), 'ALICE-REFRESHED-0123456789');
	assert.equal(s.sync.dirty(), false);
	assert.deepEqual(s.log.records.find(r => r.msg === 'login sync')!.fields, {outcome: 'saved'});
	assert.ok(!serialized(s.log).includes('ALICE-'));
});

test('an older working copy never overwrites a newer stored login', async () => {
	const s = await setup();
	await s.workingCopy(ALICE, 'ALICE-OLD-0123456789', 500);
	assert.equal(await s.sync.sync(), 'skipped');
	assert.equal(s.stored('alice'), 'ALICE-STORED-0123456789');
	assert.equal(s.sync.dirty(), false, 'nothing in it is worth saving');
});

test('a login of another Claude account is adopted as a new account and becomes the installed one', async () => {
	const s = await setup();
	await s.workingCopy(BOB, 'BOB-TOKEN-0123456789', 1000);
	assert.equal(s.sync.dirty(), true);
	assert.equal(await s.sync.sync(), 'adopted');
	assert.equal(s.stored('bob'), 'BOB-TOKEN-0123456789');
	assert.equal(s.stored('alice'), 'ALICE-STORED-0123456789', 'the installed login is not saved over');
	assert.equal(readAuth(s.dataDir).installed, 'bob');
	assert.deepEqual(s.fake.accounts.get('bob')!.fields, {method: 'claude.ai', email: 'bob@example.com'});
});

test('an unparseable working copy (the CLI writing it) is skipped and stays protected', async () => {
	const s = await setup();
	await writeFile(join(s.configDir, '.credentials.json'), '{"claudeAiOauth": {"accessTo');
	assert.equal(await s.sync.sync(), 'skipped');
	assert.equal(s.sync.dirty(), true);
	assert.equal(await readFile(join(s.configDir, '.credentials.json'), 'utf8'), '{"claudeAiOauth": {"accessTo');
});

test('a store that refuses the write gives "failed" and logs no value', async () => {
	const s = await setup();
	await s.workingCopy(ALICE, 'ALICE-REFRESHED-0123456789', 2000);
	s.fake.granted.delete('claude-login');
	assert.equal(await s.sync.sync(), 'failed');
	assert.deepEqual(s.log.records.find(r => r.msg === 'login sync failed')!.fields, {errClass: 'Error'});
	assert.ok(!serialized(s.log).includes('ALICE-'));
});
