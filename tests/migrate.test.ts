import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {toAccountName} from '../src/accounts.js';
import {loadBundle} from '../src/credentials.js';
import {accountsDir, accountsFile, legacyCount, legacyFile, migrateLegacy} from '../src/migrate.js';
import {hostVault} from '../src/vault.js';
import {fakeCredentials, seed, type FakeCredentials} from './helpers/fake-credentials.js';
import {makeFakeLog, serialized} from './helpers/fake-log.js';

const KEY = 'sk-ant-api03-MIGRATEKEY0123456789abcdef';
const KEY2 = 'sk-ant-api03-SINGLEFILE0123456789abcdef';
const OAUTH = 'sk-ant-oat01-MIGRATETOKEN0123456789abcdef';
const ALICE = {emailAddress: 'alice@example.com', accountUuid: 'uuid-alice'};
const login = (token: string, expiresAt: number) => ({
	credentials: {claudeAiOauth: {accessToken: token, refreshToken: `${token}-refresh`, expiresAt}},
	oauthAccount: ALICE,
});

// The stores claude kept before the account module held its credentials.
const writeLegacy = async (dataDir: string) => {
	await writeFile(
		accountsFile(dataDir),
		JSON.stringify({
			v: 1,
			accounts: [
				{name: 'Work.Key', type: 'key', kind: 'api-key', value: KEY, addedAt: ''},
				{name: 'token', type: 'token', kind: 'oauth', value: OAUTH, addedAt: ''},
				{name: 'alice@example.com', type: 'login', kind: 'oauth', uuid: 'uuid-alice', addedAt: ''},
			],
			order: ['alice@example.com', 'env-key', 'Work.Key'],
			limits: {token: {until: 9_999_999_999, reason: 'usage-limit'}},
			installed: 'alice@example.com',
		}),
	);
	await mkdir(join(accountsDir(dataDir), 'alice@example.com'), {recursive: true});
	await writeFile(join(accountsDir(dataDir), 'alice@example.com', 'login.json'), JSON.stringify(login('ALICE-SLOT-0123456789', 1000)));
	await writeFile(legacyFile(dataDir), JSON.stringify({kind: 'api-key', value: KEY2, savedAt: ''}));
};

// Claude Code refreshed the installed login after it was last saved.
const writeWorkingCopy = async (dataDir: string, token: string, expiresAt: number) => {
	await mkdir(join(dataDir, 'config'), {recursive: true});
	await writeFile(join(dataDir, 'config', '.credentials.json'), JSON.stringify(login(token, expiresAt).credentials));
	await writeFile(join(dataDir, 'config', '.claude.json'), JSON.stringify({oauthAccount: ALICE, other: 1}));
};

const snapshot = async (dataDir: string): Promise<string[]> => [
	await readFile(accountsFile(dataDir), 'utf8'),
	await readFile(join(accountsDir(dataDir), 'alice@example.com', 'login.json'), 'utf8'),
	await readFile(legacyFile(dataDir), 'utf8'),
];

const setup = async (fake: FakeCredentials = fakeCredentials()) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-migrate-'));
	await writeLegacy(dataDir);
	await writeWorkingCopy(dataDir, 'ALICE-REFRESHED-0123456789', 2000);
	const log = makeFakeLog();
	const vault = hostVault(fake, log);
	const run = () => migrateLegacy({dataDir, configDir: join(dataDir, 'config'), vault, log});
	return {dataDir, fake, log, vault, run};
};

const secretsOf = (f: FakeCredentials) => Object.fromEntries([...f.accounts].map(([n, a]) => [n, {kind: a.kind, ...a.secrets} as Record<string, string>]));

test('migration is lossless: every key, token and login ends in the store, then the old files go', async () => {
	const {dataDir, fake, log, run} = await setup();
	assert.equal(legacyCount(dataDir, join(dataDir, 'config')), 4);
	assert.deepEqual(await run(), {moved: 4, skipped: 0});
	const s = secretsOf(fake);
	assert.deepEqual(Object.keys(s).sort(), ['alice-example-com', 'stored', 'token', 'work-key']);
	assert.equal(s['work-key']!.key, KEY);
	assert.equal(s.token!.token, OAUTH);
	assert.equal(s.stored!.key, KEY2);
	const blob = JSON.parse(s['alice-example-com']!.login!);
	assert.equal(blob.credentials.claudeAiOauth.accessToken, 'ALICE-REFRESHED-0123456789', 'the newer working copy wins');
	assert.deepEqual(blob.oauthAccount, ALICE);
	const auth = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
	assert.deepEqual(auth.order, ['alice-example-com', 'env-key', 'work-key']);
	assert.deepEqual(Object.keys(auth.limits), ['token']);
	assert.equal(auth.installed, 'alice-example-com');
	assert.equal(auth.migrated.accounts, 4);
	assert.deepEqual((await readdir(dataDir)).sort(), ['auth.json', 'config']);
	assert.equal(JSON.parse(await readFile(join(dataDir, 'config', '.claude.json'), 'utf8')).other, 1, 'the working copy is not touched');
	assert.deepEqual(log.records.find(r => r.msg === 'credentials migrated')!.fields, {moved: 4, skipped: 0});
	const logged = serialized(log);
	for (const secret of [KEY, KEY2, OAUTH, 'ALICE', 'alice@']) assert.ok(!logged.includes(secret), secret);
	assert.equal(await run(), 'none');
});

test('migration is idempotent: a rerun after a crash before the cleanup reuses what was written', async () => {
	const {dataDir, fake, run} = await setup();
	await run();
	const before = JSON.stringify(secretsOf(fake));
	// As if the process died after writing to the store but before removing the old files.
	await writeLegacy(dataDir);
	const created = fake.calls.filter(c => c.startsWith('create')).length;
	assert.deepEqual(await run(), {moved: 4, skipped: 0});
	assert.equal(fake.calls.filter(c => c.startsWith('create')).length, created, 'no new accounts');
	assert.equal(JSON.stringify(secretsOf(fake)), before);
});

test('a failed read-back deletes nothing; the next run finishes without duplicates', async () => {
	const fake = fakeCredentials();
	const {dataDir, log, run} = await setup(fake);
	const files = await snapshot(dataDir);
	fake.corrupt = 'token';
	assert.equal(await run(), 'failed');
	assert.deepEqual(await snapshot(dataDir), files, 'the old files are byte-identical');
	assert.deepEqual(log.records.find(r => r.msg === 'credential migration failed')!.fields, {errClass: 'Error', step: 'verify'});
	assert.ok(!(await readdir(dataDir)).includes('migrate.lock'), 'the lock is released');
	fake.corrupt = undefined;
	assert.deepEqual(await run(), {moved: 4, skipped: 0});
	assert.equal(fake.accounts.size, 4);
});

test('without a grant the migration waits and leaves the files untouched', async () => {
	const fake = fakeCredentials({granted: []});
	const {dataDir, run} = await setup(fake);
	const files = await snapshot(dataDir);
	assert.equal(await run(), 'deferred');
	assert.deepEqual(await snapshot(dataDir), files);
	assert.deepEqual(fake.calls, ['grants']);
	const noProvider = await setup(fakeCredentials({installed: false}));
	assert.equal(await noProvider.run(), 'deferred');
});

test('another process migrating holds the lock: this one waits', async () => {
	const {dataDir, fake, run} = await setup();
	await writeFile(join(dataDir, 'migrate.lock'), '{}');
	assert.equal(await run(), 'deferred');
	assert.equal(fake.accounts.size, 0);
});

test('the first credential use migrates once the grant is given', async () => {
	const fake = fakeCredentials({granted: []});
	const {dataDir, vault} = await setup(fake);
	const opts = {env: {}, dataDir, vault};
	assert.equal((await loadBundle(opts)).status, 'no-grant');
	for (const k of ['anthropic-key', 'anthropic-token', 'claude-login']) fake.granted.add(k);
	const bundle = await loadBundle(opts);
	assert.equal(bundle.status, 'ok');
	assert.equal(bundle.entries.length, 4);
	assert.ok(!(await readdir(dataDir)).includes('accounts'));
});

test('names follow the account module; taken names get a suffix; an existing equal account is reused', async () => {
	assert.equal(toAccountName('Me@Example.com', 'x'), 'me-example-com');
	assert.equal(toAccountName('env-key', 'x'), 'env-key-1');
	assert.equal(toAccountName('…', 'login'), 'login');
	assert.equal(toAccountName('a'.repeat(40), 'x').length, 32);
	const fake = fakeCredentials();
	seed(fake, 'token', 'github', 'ghp_other');
	seed(fake, 'mine', 'anthropic-key', KEY);
	const {run} = await setup(fake);
	await run();
	assert.deepEqual(
		[...fake.accounts.keys()].sort(),
		['alice-example-com', 'mine', 'stored', 'token', 'token-2'],
		'the key already stored as "mine" is reused; "token" belongs to another kind',
	);
	assert.equal(fake.accounts.get('token-2')!.secrets.token, OAUTH);
});
