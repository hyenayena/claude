import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {authFile, readAuth, toAccountName} from '../src/accounts.js';
import {loadBundle} from '../src/credentials.js';
import {accountsDir, accountsFile, legacyCount, legacyFile, migrateAuthState, migrateLegacy} from '../src/migrate.js';
import {hostVault} from '../src/vault.js';
import {fakeCredentials, seed, type FakeCredentials} from './helpers/fake-credentials.js';
import {makeFakeLog, serialized} from './helpers/fake-log.js';

const KEY = 'sk-ant-api03-MIGRATEKEY0123456789abcdef';
const KEY2 = 'sk-ant-api03-SINGLEFILE0123456789abcdef';
const OAUTH = 'sk-ant-oat01-MIGRATETOKEN0123456789abcdef';
const SLOT = 'ALICE-SLOT-0123456789';

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
			order: ['alice@example.com', 'env-key', 'Work.Key', 'token'],
			limits: {token: {until: 9_999_999_999, reason: 'usage-limit'}},
			installed: 'alice@example.com',
		}),
	);
	await mkdir(join(accountsDir(dataDir), 'alice@example.com'), {recursive: true});
	await writeFile(join(accountsDir(dataDir), 'alice@example.com', 'login.json'), JSON.stringify({credentials: {claudeAiOauth: {accessToken: SLOT}}}));
	await writeFile(legacyFile(dataDir), JSON.stringify({kind: 'api-key', value: KEY2, savedAt: ''}));
};

const snapshot = async (dataDir: string): Promise<string[]> => [
	await readFile(accountsFile(dataDir), 'utf8'),
	await readFile(join(accountsDir(dataDir), 'alice@example.com', 'login.json'), 'utf8'),
	await readFile(legacyFile(dataDir), 'utf8'),
];

const setup = async (fake: FakeCredentials = fakeCredentials()) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-migrate-'));
	await writeLegacy(dataDir);
	const log = makeFakeLog();
	const vault = hostVault(fake, log);
	const run = () => migrateLegacy({dataDir, vault, log});
	return {dataDir, fake, log, vault, run};
};

const secretsOf = (f: FakeCredentials) => Object.fromEntries([...f.accounts].map(([n, a]) => [n, {kind: a.kind, ...a.secrets} as Record<string, string>]));

test('migration moves the keys; tokens and logins are dropped and counted, then the old files go', async () => {
	const {dataDir, fake, log, run} = await setup();
	assert.equal(legacyCount(dataDir), 2);
	assert.deepEqual(await run(), {moved: 2, skipped: 0, dropped: 2});
	const s = secretsOf(fake);
	assert.deepEqual(Object.keys(s).sort(), ['stored', 'work-key']);
	assert.equal(s['work-key']!.key, KEY);
	assert.equal(s.stored!.key, KEY2);
	const auth = JSON.parse(await readFile(join(dataDir, 'auth.json'), 'utf8'));
	assert.deepEqual(auth.order, ['login', 'env-key', 'work-key']);
	assert.equal('limits' in auth, false);
	assert.equal('installed' in auth, false);
	assert.equal(auth.migrated.accounts, 2);
	assert.deepEqual((await readdir(dataDir)).sort(), ['auth.json']);
	assert.deepEqual(log.records.find(r => r.msg === 'credentials migrated')!.fields, {moved: 2, skipped: 0, dropped: 2});
	const logged = serialized(log);
	for (const secret of [KEY, KEY2, OAUTH, 'ALICE', 'alice@']) assert.ok(!logged.includes(secret), secret);
	assert.equal(await run(), 'none');
});

test('migration is idempotent: a rerun after a crash before the cleanup reuses what was written', async () => {
	const {dataDir, fake, run} = await setup();
	await run();
	const before = JSON.stringify(secretsOf(fake));
	await writeLegacy(dataDir);
	const created = fake.calls.filter(c => c.startsWith('create')).length;
	assert.deepEqual(await run(), {moved: 2, skipped: 0, dropped: 2});
	assert.equal(fake.calls.filter(c => c.startsWith('create')).length, created, 'no new accounts');
	assert.equal(JSON.stringify(secretsOf(fake)), before);
});

test('a failed read-back deletes nothing; the next run finishes without duplicates', async () => {
	const fake = fakeCredentials();
	const {dataDir, log, run} = await setup(fake);
	const files = await snapshot(dataDir);
	fake.corrupt = 'work-key';
	assert.equal(await run(), 'failed');
	assert.deepEqual(await snapshot(dataDir), files, 'the old files are byte-identical');
	assert.deepEqual(log.records.find(r => r.msg === 'credential migration failed')!.fields, {errClass: 'Error', step: 'verify'});
	assert.ok(!(await readdir(dataDir)).includes('migrate.lock'), 'the lock is released');
	fake.corrupt = undefined;
	assert.deepEqual(await run(), {moved: 2, skipped: 0, dropped: 2});
	assert.equal(fake.accounts.size, 2);
});

test('without a grant the migration waits and leaves the files byte-identical', async () => {
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
	fake.granted.add('anthropic-key');
	const bundle = await loadBundle(opts);
	assert.equal(bundle.status, 'ok');
	assert.equal(bundle.entries.length, 2);
	assert.ok(!(await readdir(dataDir)).includes('accounts'));
});

test('names follow the account module; an existing equal account is reused; an oauth single file is dropped', async () => {
	assert.equal(toAccountName('Me@Example.com', 'x'), 'me-example-com');
	assert.equal(toAccountName('env-key', 'x'), 'env-key-1');
	assert.equal(toAccountName('login', 'x'), 'login-1');
	assert.equal(toAccountName('…', 'key'), 'key');
	assert.equal(toAccountName('a'.repeat(40), 'x').length, 32);
	const fake = fakeCredentials();
	seed(fake, 'work-key', 'github', 'ghp_other');
	seed(fake, 'mine', 'anthropic-key', KEY);
	const {dataDir, run} = await setup(fake);
	await writeFile(legacyFile(dataDir), JSON.stringify({kind: 'oauth', value: OAUTH}));
	assert.deepEqual(await run(), {moved: 1, skipped: 0, dropped: 3});
	assert.deepEqual([...fake.accounts.keys()].sort(), ['mine', 'work-key'], 'the key already stored as "mine" is reused; no token account appears');
});

const authText = (o: object) => JSON.stringify({v: 1, ...o});

test('migrateAuthState maps the installed login to "login" in order and pin and drops limits and "only"', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-authstate-'));
	const log = makeFakeLog();
	await writeFile(
		authFile(dataDir),
		authText({order: ['env-key', 'alice', 'work'], limits: {work: {until: 9_999_999_999, reason: 'billing'}}, installed: 'alice', pin: {name: 'alice', only: true}}),
	);
	assert.equal(migrateAuthState(dataDir, log), true);
	const raw = JSON.parse(await readFile(authFile(dataDir), 'utf8'));
	assert.deepEqual(raw, {v: 1, order: ['env-key', 'login', 'work'], pin: {name: 'login'}});
	assert.deepEqual(readAuth(dataDir), {v: 1, order: ['env-key', 'login', 'work'], pin: {name: 'login'}});
	assert.deepEqual(log.records.find(r => r.msg === 'auth state migrated')!.fields ?? {}, {});
	assert.ok(!serialized(log).includes('alice'));
	const after = await readFile(authFile(dataDir), 'utf8');
	assert.equal(migrateAuthState(dataDir, log), false, 'a second run is a no-op');
	assert.equal(await readFile(authFile(dataDir), 'utf8'), after);
});

test('migrateAuthState cleans limits without an installed name and leaves a clean file and a missing one alone', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-authstate-'));
	assert.equal(migrateAuthState(dataDir), false);
	await writeFile(authFile(dataDir), authText({order: ['a'], limits: {a: {until: 1, reason: 'usage-limit'}}, pin: {name: 'a', only: false}}));
	assert.equal(migrateAuthState(dataDir), true);
	assert.deepEqual(JSON.parse(await readFile(authFile(dataDir), 'utf8')), {v: 1, order: ['a'], pin: {name: 'a'}});
	assert.equal(migrateAuthState(dataDir), false);
	await writeFile(authFile(dataDir), 'not json');
	assert.equal(migrateAuthState(dataDir), false);
});

test('migrateAuthState never touches the working copy of the login', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-authstate-'));
	const config = join(dataDir, 'config');
	await mkdir(config, {recursive: true});
	const files = {'.credentials.json': '{"keep":1}', '.claude.json': '{"keep":2}'};
	for (const [n, c] of Object.entries(files)) await writeFile(join(config, n), c);
	await writeFile(authFile(dataDir), authText({order: ['alice'], installed: 'alice'}));
	migrateAuthState(dataDir);
	for (const [n, c] of Object.entries(files)) assert.equal(await readFile(join(config, n), 'utf8'), c);
	assert.deepEqual((await readdir(config)).sort(), ['.claude.json', '.credentials.json']);
});

test('loadBundle migrates the auth state once, without any credential channel', async () => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-authstate-'));
	await writeFile(authFile(dataDir), authText({order: ['alice'], installed: 'alice'}));
	await loadBundle({env: {}, dataDir, vault: hostVault(undefined)});
	assert.deepEqual(JSON.parse(await readFile(authFile(dataDir), 'utf8')), {v: 1, order: ['login']});
});
