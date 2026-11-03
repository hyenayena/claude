import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {makeFakeLog, serialized} from './helpers/fake-log.js';
import {fakeCredentials, seed, type FakeCredentials} from './helpers/fake-credentials.js';
import {buildEnv, cliEnv, resolvePaths, scrubChatEnv} from '../src/config.js';
import {authFile, chooseAccount, clearPin, listAccounts, pinnedAccount, prepareAccount, readAuth, removeAccount, setOrder, useAccount} from '../src/accounts.js';
import type {LoginStatus} from '../src/claude-login.js';
import {
	accountsCtx,
	allSecrets,
	API_KEY_ONLY,
	type CredentialOpts,
	describeCredential,
	inspectFileMode,
	listCredentialSources,
	loadBundle,
	makeRedactor,
	NO_CREDENTIALS,
	prepareCredential,
	registerLogRedaction,
	requireCredential,
	resolveCredential,
	storeSecret,
} from '../src/credentials.js';
import {loginCredentialsFile, loginPresent} from '../src/login-slot.js';
import {hostVault} from '../src/vault.js';

const KEY = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const KEY2 = 'sk-ant-api03-OTHERVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat01-TESTVALUE0123456789abcdef';
const REFRESH = 'sk-ant-ort01-TESTVALUE0123456789abcdef';
const tmp = () => mkdtemp(join(tmpdir(), 'claude-cred-'));
const shape = (c?: {kind: string; source: string; account?: string}) => c && {kind: c.kind, source: c.source, account: c.account};
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const setup = async (env: NodeJS.ProcessEnv = {}, fake: FakeCredentials | null = fakeCredentials(), extra: Partial<CredentialOpts> = {}) => {
	const dataDir = await tmp();
	const log = makeFakeLog();
	const opts: CredentialOpts = {env, dataDir, vault: hostVault(fake ?? undefined, log), log, ...extra};
	return {dataDir, opts, fake: fake as FakeCredentials, log};
};

const signedIn = (o: Partial<LoginStatus> = {}) => async (): Promise<LoginStatus> => ({loggedIn: true, method: 'claude.ai', email: 'alice@example.com', ...o});
const WORKING_COPY = '{"claudeAiOauth":{"accessToken":"WORKING-COPY-TOKEN-0123456789"}}';

const writeLogin = async (dataDir: string, text = WORKING_COPY, mode = 0o600) => {
	const config = join(dataDir, 'config');
	await mkdir(config, {recursive: true});
	await writeFile(loginCredentialsFile(config), text, {mode});
	await chmod(loginCredentialsFile(config), mode);
};

test('default priority: env key, env token, the Claude Code login, then stored keys', async () => {
	const {opts, dataDir} = await setup();
	assert.equal(await resolveCredential(opts), undefined);
	await storeSecret(opts, KEY2);
	assert.deepEqual(shape(await resolveCredential(opts)), {kind: 'api-key', source: 'stored', account: 'key'});
	await writeLogin(dataDir);
	assert.deepEqual(shape(await resolveCredential(opts)), {kind: 'oauth', source: 'claude-login', account: 'login'});
	const withToken = await resolveCredential({...opts, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}});
	assert.deepEqual(shape(withToken), {kind: 'oauth', source: 'env', account: 'env-token'});
	const both = await resolveCredential({...opts, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY}});
	assert.deepEqual({...shape(both), v: both?.value}, {kind: 'api-key', source: 'env', account: 'env-key', v: KEY});
	const list = await listCredentialSources({...opts, env: {ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH}});
	assert.deepEqual(list.map(c => c.account), ['env-key', 'env-token', 'login', 'key']);
});

test('without a usable store only the environment and the login count, and the error says why', async () => {
	const granted = await setup();
	assert.equal(await resolveCredential({...granted.opts, env: {ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: ''}}), undefined);
	await assert.rejects(requireCredential(granted.opts), {
		message: 'No credentials found. Run "claude auth login" to sign in with Claude Code, or "claude auth add" to paste an API key. See "claude auth status".',
	});
	assert.equal(NO_CREDENTIALS, 'No credentials found. Run "claude auth login" to sign in with Claude Code, or "claude auth add" to paste an API key. See "claude auth status".');
	const cases: Array<[FakeCredentials | null, RegExp]> = [
		[fakeCredentials({installed: false}), /account module, which is not installed \(mod install account\)/],
		[fakeCredentials({granted: []}), /claude may not use stored credentials yet\. Allow it \(only you can\): account grant claude$/],
		[null, /need a yena host with the credential channel/],
	];
	for (const [fake, message] of cases) {
		const s = await setup({}, fake);
		await assert.rejects(requireCredential(s.opts), message);
		const env = await resolveCredential({...s.opts, env: {ANTHROPIC_API_KEY: KEY}});
		assert.equal(env?.account, 'env-key');
		await writeLogin(s.dataDir);
		assert.equal((await resolveCredential(s.opts))?.account, 'login', 'the login needs no store');
	}
	const broken = fakeCredentials();
	seed(broken, 'work', 'anthropic-key', KEY);
	broken.broken = true;
	const b = await setup({}, broken);
	await assert.rejects(requireCredential(b.opts), /cannot be decrypted; see: account vault status/);
	assert.ok(!serialized(b.log).includes(KEY));
});

test('an ungranted store is never written; the refusal names the grant', async () => {
	const fake = fakeCredentials({granted: []});
	const {opts} = await setup({}, fake);
	await assert.rejects(storeSecret(opts, KEY), /account grant claude/);
	assert.deepEqual(fake.calls.filter(c => !c.startsWith('grants')), []);
});

test('a credential and a bundle never leak through stringification', async () => {
	const {opts, fake} = await setup({ANTHROPIC_API_KEY: KEY});
	seed(fake, 'work', 'anthropic-key', KEY2);
	const c = await resolveCredential(opts);
	assert.ok(c);
	await opts.vault!.load();
	const bundle = opts.vault!.current();
	for (const s of [JSON.stringify(c), inspect(c), `${c}`, JSON.stringify({c}), inspect({c}, {depth: 5}), JSON.stringify(bundle), inspect(bundle, {depth: 9}), inspect(bundle, {depth: 9, showHidden: true})]) {
		assert.ok(!s.includes('TESTVALUE') && !s.includes('OTHERVALUE'), s);
	}
	assert.equal(c.value, KEY);
});

test('makeRedactor masks the credential, bundle values and applies the host redactor', async () => {
	const {opts, fake} = await setup({ANTHROPIC_API_KEY: 'plainsecretvalue'});
	seed(fake, 'k', 'anthropic-key', KEY2);
	const c = await resolveCredential(opts);
	const r = makeRedactor(c, ['anothersecretvalue'], t => t.replace('github-token-xyz', '[host]'));
	assert.equal(r('x plainsecretvalue y anothersecretvalue z github-token-xyz'), 'x [redacted] y [redacted] z [host]');
	assert.equal(r(`k ${KEY} z`), 'k [redacted] z');
	assert.equal(makeRedactor()(`k ${KEY}`), 'k [redacted]');
	const all = allSecrets(opts);
	for (const v of [KEY2, 'plainsecretvalue']) assert.ok(all.includes(v), v);
	const live = makeRedactor(undefined, () => allSecrets(opts));
	assert.equal(live(`a ${KEY2} b`), 'a [redacted] b');
});

test('subscription tokens are masked by pattern, with no stored value; allSecrets holds no CLAUDE_CODE_OAUTH_TOKEN value', async () => {
	const r = makeRedactor();
	for (const t of [OAUTH, REFRESH, KEY, 'sk-ant-oat01-' + 'Z'.repeat(80)]) assert.equal(r(`x ${t} y`), 'x [redacted] y', t);
	const {opts} = await setup({CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY});
	const all = allSecrets(opts);
	assert.ok(all.includes(KEY));
	assert.ok(!all.includes(OAUTH), 'the token value is not read');
	const live = makeRedactor(undefined, () => allSecrets(opts));
	assert.equal(live(`t ${OAUTH}`), 't [redacted]');
});

test('makeRedactor masks common secret shapes but not words about tokens', () => {
	const r = makeRedactor();
	const pem = ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAA', '-----END OPENSSH PRIVATE KEY-----'].join('\n');
	assert.equal(r(`a ${pem} b`), 'a [redacted] b');
	assert.equal(r(`t ghp_${'x'.repeat(36)} u`), 't [redacted] u');
	assert.equal(r(`t github_pat_${'Y'.repeat(40)}`), 't [redacted]');
	assert.equal(r('aws AKIAABCDEFGHIJKLMNOP.'), 'aws [redacted].');
	assert.equal(r(`openai sk-${'z'.repeat(32)}`), 'openai [redacted]');
	for (const text of ['token: the next step', 'api_key = process.env.X', 'mask-ghp_ prefix', 'task-123 desk-top']) {
		assert.equal(r(text), text);
	}
});

test('loading a bundle registers a log redactor for every value, once', async () => {
	const {opts, fake, log} = await setup();
	seed(fake, 'k', 'anthropic-key', KEY);
	await opts.vault!.load();
	await opts.vault!.load();
	assert.equal(log.redactors.reduce((t, fn) => fn(t), `${KEY} x`), '[redacted] x');
	const n = log.redactors.length;
	await opts.vault!.load();
	assert.equal(log.redactors.length, n);
});

test('storeSecret stores keys, refuses tokens and garbage without echoing them', async () => {
	const {opts, fake} = await setup();
	for (const bad of ['garbage-TESTVALUE', 'sk-ant-x', 'sk-ant-api03-no pe-TESTVALUE0123456789']) {
		await assert.rejects(storeSecret(opts, bad), (e: Error) => !e.message.includes('TESTVALUE') && !e.message.includes(bad));
	}
	await assert.rejects(
		storeSecret(opts, OAUTH),
		(e: Error) =>
			e.message === 'Subscription tokens are no longer stored; sign in with "claude auth login", or set CLAUDE_CODE_OAUTH_TOKEN in your environment.' && !e.message.includes('TESTVALUE'),
	);
	assert.equal(fake.accounts.size, 0);
	const a = await storeSecret(opts, ` ${KEY}\n`);
	assert.equal(`${a.name}:${a.type}:${a.kind}`, 'key:key:api-key');
	assert.deepEqual([fake.accounts.get('key')!.kind, fake.accounts.get('key')!.secrets.key], ['anthropic-key', KEY]);
});

test('several keys: named, deduplicated, replaced by name; names follow the account module', async () => {
	const {opts, fake} = await setup();
	seed(fake, 'key-2', 'github', 'ghp_hidden');
	assert.equal((await storeSecret(opts, ` ${KEY}\n`)).name, 'key');
	assert.equal((await storeSecret(opts, KEY2)).name, 'key-3', 'a name of a kind claude cannot see is skipped');
	assert.equal((await storeSecret(opts, 'sk-ant-api03-WORKVALUE0123456789abcdef', 'work')).name, 'work');
	await assert.rejects(storeSecret(opts, KEY, 'again'), /already account "key"/);
	await storeSecret(opts, 'sk-ant-api03-WORKTWOVALUE0123456789abcd', 'work');
	assert.equal(fake.accounts.get('work')!.secrets.key, 'sk-ant-api03-WORKTWOVALUE0123456789abcd');
	assert.deepEqual(listAccounts(accountsCtx(opts)).map(a => `${a.name}:${a.type}`), ['key:key', 'key-3:key', 'work:key']);
	assert.equal(prepareCredential(opts).value, KEY);
	await assert.rejects(storeSecret(opts, KEY2, 'env-key'), /environment variable account/);
	await assert.rejects(storeSecret(opts, KEY2, 'login'), /Claude Code login account/);
	await assert.rejects(storeSecret(opts, KEY2, 'Work'), /lowercase/);
});

test('order, use and remove change the priority in auth.json; environment accounts take part but cannot be removed', async () => {
	const {opts, dataDir, fake} = await setup({ANTHROPIC_API_KEY: KEY});
	await storeSecret(opts, KEY2, 'a');
	await storeSecret(opts, 'sk-ant-api03-BEEVALUE0123456789abcdef', 'b');
	const ctx = () => accountsCtx(opts);
	assert.deepEqual(listAccounts(ctx()).map(a => a.name), ['env-key', 'a', 'b']);
	assert.deepEqual(setOrder(ctx(), ['b', 'a']).map(a => a.name), ['b', 'a', 'env-key']);
	assert.equal(chooseAccount(ctx())?.name, 'b');
	assert.throws(() => setOrder(ctx(), ['nope']), /No account "nope"/);
	assert.throws(() => setOrder(ctx(), ['a', 'a']), /Each account once/);
	assert.deepEqual(useAccount(ctx(), 'env-key').map(a => a.name), ['b', 'a', 'env-key'], 'use keeps the order');
	assert.equal(chooseAccount(ctx())?.name, 'env-key');
	assert.deepEqual(setOrder(ctx(), ['env-key']).map(a => a.name), ['env-key', 'b', 'a']);
	await assert.rejects(removeAccount(ctx(), opts.vault!, 'env-key'), /unset the variable/);
	await removeAccount(ctx(), opts.vault!, 'b');
	assert.ok(!fake.accounts.has('b'));
	assert.deepEqual(listAccounts(ctx()).map(a => a.name), ['env-key', 'a']);
	await assert.rejects(removeAccount(ctx(), opts.vault!, 'b'), /No account "b"/);
	const auth = await readFile(join(dataDir, 'auth.json'), 'utf8');
	assert.deepEqual(JSON.parse(auth).order, ['env-key', 'a']);
	assert.ok(!auth.includes('sk-ant'), 'auth.json holds no secret');
	assert.equal((await stat(join(dataDir, 'auth.json'))).mode & 0o777, 0o600);
});

test('disabled, reserved and empty accounts are listed but never chosen', async () => {
	const fake = fakeCredentials();
	seed(fake, 'off', 'anthropic-key', KEY, {disabled: true});
	seed(fake, 'env-key', 'anthropic-key', KEY2);
	seed(fake, 'login', 'anthropic-key', KEY2);
	seed(fake, 'empty', 'anthropic-key');
	seed(fake, 'ok', 'anthropic-key', 'sk-ant-api03-OKVALUE0123456789abcdef');
	const {opts} = await setup({}, fake);
	await opts.vault!.load();
	const list = listAccounts(accountsCtx(opts));
	assert.deepEqual(list.map(a => [a.name, a.unusable]), [['off', 'disabled'], ['env-key', 'reserved'], ['login', 'reserved'], ['empty', 'missing'], ['ok', undefined]]);
	assert.equal((await resolveCredential(opts))?.account, 'ok');
	assert.ok(!allSecrets(opts).includes(KEY), 'a disabled account is not read');
});

test('chooseAccount: the pin when usable, else the first usable account; limits in the auth state are not read', async () => {
	const {opts, dataDir} = await setup();
	await storeSecret(opts, KEY, 'a');
	await storeSecret(opts, KEY2, 'b');
	const ctx = () => accountsCtx(opts);
	assert.equal(chooseAccount(ctx())?.name, 'a');
	await writeFile(
		authFile(dataDir),
		JSON.stringify({v: 1, order: ['a', 'b'], limits: {a: {until: 9_999_999_999, reason: 'usage-limit'}}, installed: 'b'}),
	);
	assert.equal(chooseAccount(ctx())?.name, 'a', 'a recorded limit does not skip the account');
	assert.deepEqual(Object.keys(listAccounts(ctx())[0]!).sort(), ['kind', 'name', 'type']);
	useAccount(ctx(), 'b');
	assert.equal(chooseAccount(ctx())?.name, 'b');
	assert.deepEqual(listAccounts(ctx()).map(a => a.name), ['a', 'b'], 'the order stays');
	const c = prepareCredential(opts);
	assert.deepEqual({...shape(c), v: c.value}, {kind: 'api-key', source: 'stored', account: 'b', v: KEY2});
	assert.equal(readAuth(dataDir).pin?.name, 'b');
	assert.ok(!('limits' in JSON.parse(await readFile(authFile(dataDir), 'utf8'))), 'saving drops the old limits');
});

test('apiKeyOnly: the pin when it is a key, else the first usable key; none -> refused with the scheduler message', async () => {
	const {opts, dataDir} = await setup({CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, fakeCredentials(), {probeLogin: signedIn({method: 'claude.ai'})});
	await writeLogin(dataDir);
	await loadBundle(opts);
	const ctx = () => accountsCtx(opts);
	assert.equal(chooseAccount(ctx())?.name, 'env-token');
	assert.equal(chooseAccount(ctx(), {apiKeyOnly: true}), undefined);
	await assert.rejects(requireCredential(opts, {apiKeyOnly: true}), {message: API_KEY_ONLY});
	assert.throws(() => prepareCredential(opts, {apiKeyOnly: true}), {message: API_KEY_ONLY});
	assert.match(API_KEY_ONLY, /^A chat started by the scheduler runs only on an API key: Claude subscription plans are for your own interactive use\. Add one with "claude auth add" or set ANTHROPIC_API_KEY\.$/);
	await storeSecret(opts, KEY, 'a');
	await storeSecret(opts, KEY2, 'b');
	assert.equal(chooseAccount(ctx(), {apiKeyOnly: true})?.name, 'a');
	useAccount(ctx(), 'login');
	assert.equal(chooseAccount(ctx())?.name, 'login');
	assert.equal(chooseAccount(ctx(), {apiKeyOnly: true})?.name, 'a', 'a pinned login is skipped');
	useAccount(ctx(), 'b');
	assert.equal(chooseAccount(ctx(), {apiKeyOnly: true})?.name, 'b', 'a pinned key is used');
	assert.equal((await requireCredential(opts, {apiKeyOnly: true})).account, 'b');
	const consoleLogin = await setup({}, fakeCredentials(), {probeLogin: signedIn({method: 'console'})});
	await writeLogin(consoleLogin.dataDir);
	assert.equal((await requireCredential(consoleLogin.opts, {apiKeyOnly: true})).account, 'login', 'a Console login is an API key');
});

test('the login account: present from the file or the probe, kind and email only from the probe', async () => {
	const none = await setup({}, fakeCredentials(), {probeLogin: async () => ({loggedIn: false})});
	await loadBundle(none.opts);
	assert.deepEqual(listAccounts(accountsCtx(none.opts)), []);
	assert.throws(() => prepareAccount(accountsCtx(none.opts), 'login'), /Claude Code is not signed in; run "claude auth login"/);

	const file = await setup();
	await writeLogin(file.dataDir);
	assert.deepEqual(listAccounts(accountsCtx(file.opts)), [{name: 'login', type: 'login', kind: 'oauth'}]);

	const probe = await setup({}, fakeCredentials(), {probeLogin: signedIn({email: 'alice@example.com'})});
	await loadBundle(probe.opts);
	assert.deepEqual(listAccounts(accountsCtx(probe.opts)), [{name: 'login', type: 'login', kind: 'oauth', email: 'alice@example.com'}], 'present without a file when Claude Code says so');

	const consoleLogin = await setup({}, fakeCredentials(), {probeLogin: signedIn({method: 'console', email: undefined as never})});
	await writeLogin(consoleLogin.dataDir);
	await loadBundle(consoleLogin.opts);
	assert.equal(listAccounts(accountsCtx(consoleLogin.opts))[0]!.kind, 'api-key');

	const bad = await setup({}, fakeCredentials(), {probeLogin: async () => undefined});
	await writeLogin(bad.dataDir, 'not json at all');
	await loadBundle(bad.opts);
	assert.deepEqual(listAccounts(accountsCtx(bad.opts)), [{name: 'login', type: 'login', kind: 'oauth'}], 'a half-written file still counts');
});

test('the login probe is refreshed at most once a minute', async () => {
	let now = 1_000_000;
	let calls = 0;
	const {opts} = await setup({}, fakeCredentials(), {
		now: () => now,
		probeLogin: async () => {
			calls++;
			return {loggedIn: true, method: 'claude.ai'};
		},
	});
	await loadBundle(opts);
	await loadBundle(opts);
	assert.equal(calls, 1);
	now += 61_000;
	await loadBundle(opts);
	assert.equal(calls, 2);
});

test('loginPresent never opens the login file: a non-empty unreadable or garbage file counts, an empty one does not', async () => {
	const {dataDir} = await setup();
	const config = join(dataDir, 'config');
	assert.equal(loginPresent(config), false);
	await writeLogin(dataDir, 'garbage, not json', 0o000);
	assert.equal(loginPresent(config), true);
	await chmod(loginCredentialsFile(config), 0o600);
	await writeLogin(dataDir, '');
	assert.equal(loginPresent(config), false);
	const src = await readFile(new URL('../src/login-slot.ts', import.meta.url), 'utf8');
	const body = src.slice(src.indexOf('export function loginPresent'));
	assert.ok(!/read|open|parse/i.test(body), 'the presence check only lstat-s');
});

test('using the login or any other account leaves the working copy byte-identical and writes nothing into config', async () => {
	const {opts, dataDir} = await setup({}, fakeCredentials(), {probeLogin: signedIn()});
	await writeLogin(dataDir);
	await storeSecret(opts, KEY, 'a');
	const config = join(dataDir, 'config');
	const hash = async () => sha(await readFile(loginCredentialsFile(config), 'utf8'));
	const before = [await hash(), (await readdir(config)).sort().join()];
	await loadBundle(opts);
	const ctx = accountsCtx(opts);
	for (const name of ['login', 'a']) prepareAccount(ctx, name);
	const c = await requireCredential(opts);
	assert.deepEqual(shape(c), {kind: 'oauth', source: 'claude-login', account: 'login'});
	assert.equal(c.value, '');
	setOrder(ctx, ['a', 'login']);
	useAccount(ctx, 'login');
	clearPin(ctx);
	assert.deepEqual([await hash(), (await readdir(config)).sort().join()], before);
	for (const s of [JSON.stringify(c), inspect(c), `${c}`]) assert.ok(!s.includes('WORKING-COPY-TOKEN'), s);
	const log = makeFakeLog();
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 0, 'an empty value registers no redactor');
});

test('the login cannot be removed here; it is removed with "claude auth logout"', async () => {
	const {opts, dataDir} = await setup();
	await writeLogin(dataDir);
	await assert.rejects(removeAccount(accountsCtx(opts), opts.vault!, 'login'), /removed with "claude auth logout"/);
	assert.equal(loginPresent(join(dataDir, 'config')), true);
});

test('env-token: passthrough, no value read, the variable reaches Claude Code untouched, the key variable goes', async () => {
	const {opts, dataDir} = await setup({CLAUDE_CODE_OAUTH_TOKEN: OAUTH});
	const c = await requireCredential(opts);
	assert.deepEqual(shape(c), {kind: 'oauth', source: 'env', account: 'env-token'});
	assert.equal(c.value, '');
	assert.equal(c.passthrough, true);
	assert.deepEqual(prepareAccount(accountsCtx(opts), 'env-token'), {account: {name: 'env-token', type: 'env', kind: 'oauth'}, kind: 'oauth', value: '', login: false, passthrough: true});
	assert.equal(prepareCredential(opts).passthrough, true);
	const env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY, PATH: '/usr/bin'}, resolvePaths(dataDir), c);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'the parent variable is passed on as it is');
	assert.ok(!('ANTHROPIC_API_KEY' in env));
	const kept = scrubChatEnv(env, ['CLAUDE_CODE_OAUTH_TOKEN']);
	assert.equal(kept.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in scrubChatEnv(env)), 'dropped without the keep list');
	const log = makeFakeLog();
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 0);
});

test('switching to a key or the login deletes CLAUDE_CODE_OAUTH_TOKEN from the child environment', async () => {
	const {opts, dataDir} = await setup({ANTHROPIC_API_KEY: KEY});
	const paths = resolvePaths(dataDir);
	const key = await requireCredential(opts);
	let env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, paths, key);
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
	await writeLogin(dataDir);
	const login = await requireCredential({...opts, env: {}});
	assert.equal(login.source, 'claude-login');
	env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY}, paths, login);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env) && !('ANTHROPIC_API_KEY' in env));
});

test('inspectFileMode warns about a readable auth.json and login file', async () => {
	const {opts, dataDir} = await setup({ANTHROPIC_API_KEY: KEY});
	await storeSecret(opts, KEY2, 'a');
	setOrder(accountsCtx(opts), ['a']);
	await chmod(join(dataDir, 'auth.json'), 0o644);
	let w = await inspectFileMode(dataDir);
	assert.equal(w.length, 1);
	assert.ok(w[0]!.startsWith('auth.json'));
	await chmod(join(dataDir, 'auth.json'), 0o600);
	assert.deepEqual(await inspectFileMode(dataDir), []);
	await writeLogin(dataDir, WORKING_COPY, 0o644);
	w = await inspectFileMode(dataDir);
	assert.match(w[0]!, /\.credentials\.json is readable by other users/);
});

test('describeCredential names the account', () => {
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'api-key', source: 'env', account: 'env-key'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'oauth', source: 'env', account: 'env-token'}), 'subscription token (from environment)');
	assert.equal(describeCredential({kind: 'api-key', source: 'stored', account: 'work'}), 'account "work": API key (stored in the account module)');
	assert.equal(describeCredential({kind: 'oauth', source: 'claude-login'}), 'Claude Code login (subscription)');
	assert.equal(describeCredential({kind: 'api-key', source: 'claude-login', account: 'login'}), 'account "login": Claude Code login (Console)');
});

test('registerLogRedaction registers once per value and logger', async () => {
	const {opts} = await setup({ANTHROPIC_API_KEY: KEY});
	const a = (await resolveCredential(opts))!;
	const b = (await resolveCredential(opts))!;
	const log = makeFakeLog();
	registerLogRedaction(log, a);
	registerLogRedaction(log, b);
	assert.equal(log.redactors.length, 1);
	assert.equal(log.redactors[0]!(`key=${KEY}`), 'key=[redacted]');
	const c = (await resolveCredential({...opts, env: {ANTHROPIC_API_KEY: `${KEY}2`}}))!;
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 2);
});

test('a stored key reaches Claude Code as ANTHROPIC_API_KEY only', async () => {
	const {opts, dataDir} = await setup();
	await storeSecret(opts, KEY);
	const env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: 'stale'}, resolvePaths(dataDir), await requireCredential(opts));
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
});

test('readAuth keeps a well-formed pin only and ignores limits, installed and "only"', async () => {
	const {dataDir} = await setup();
	const write = (pin: unknown, extra: object = {}) => writeFile(join(dataDir, 'auth.json'), JSON.stringify({v: 1, order: [], pin, ...extra}));
	await write({name: 'work', only: true}, {limits: {work: {until: 1, reason: 'billing'}}, installed: 'work'});
	assert.deepEqual(readAuth(dataDir), {v: 1, order: [], pin: {name: 'work'}});
	for (const bad of ['work', {name: 'Work'}, {only: true}, {name: 7}, null]) {
		await write(bad);
		assert.equal(readAuth(dataDir).pin, undefined, JSON.stringify(bad));
	}
});

test('a pin on an unusable or missing account is ignored and pruned', async () => {
	const fake = fakeCredentials();
	seed(fake, 'a', 'anthropic-key', KEY);
	seed(fake, 'b', 'anthropic-key', KEY2);
	const {opts, dataDir} = await setup({ANTHROPIC_API_KEY: 'sk-ant-api03-ENVVALUE0123456789abcdef'}, fake);
	await opts.vault!.load();
	const ctx = () => accountsCtx(opts);
	assert.throws(() => useAccount(ctx(), 'nope'), /^Error: No account "nope"; "claude auth status" lists them$/);
	useAccount(ctx(), 'b');
	fake.accounts.get('b')!.disabled = true;
	await opts.vault!.load();
	assert.equal(pinnedAccount(ctx()), undefined);
	assert.equal(chooseAccount(ctx())?.name, 'env-key');
	assert.throws(() => useAccount(ctx(), 'b'), /^Error: Account "b" cannot be used right now \(disabled\)$/);
	setOrder(ctx(), ['a']);
	assert.equal(readAuth(dataDir).pin, undefined, 'saving prunes a pin on a disabled account');

	useAccount(ctx(), 'env-key');
	assert.deepEqual(readAuth(dataDir).pin, {name: 'env-key'}, 'an environment account can be pinned');
	const unset = {...opts, env: {}};
	assert.equal(pinnedAccount(accountsCtx(unset)), undefined, 'the variable is gone');
	assert.equal(chooseAccount(accountsCtx(unset))?.name, 'a');
	setOrder(accountsCtx(unset), ['a']);
	assert.deepEqual(readAuth(dataDir).pin, {name: 'env-key'}, 'environment accounts count as known');

	await removeAccount(ctx(), opts.vault!, 'a');
	useAccount(ctx(), 'env-key');
	assert.ok(clearPin(ctx()));
	assert.equal(clearPin(ctx()), false);
	assert.equal(readAuth(dataDir).pin, undefined);
});

test('removing the pinned account drops the pin', async () => {
	const fake = fakeCredentials();
	seed(fake, 'b', 'anthropic-key', KEY);
	const {opts, dataDir} = await setup({}, fake);
	await opts.vault!.load();
	const ctx = () => accountsCtx(opts);
	useAccount(ctx(), 'b');
	await removeAccount(ctx(), opts.vault!, 'b');
	assert.equal(readAuth(dataDir).pin, undefined);
});

test('the CLI probe env carries neither the API key nor the env token, so status describes the login only', () => {
	const paths = {configDir: '/data/claude/config'};
	const env = cliEnv({PATH: '/bin', HOME: '/root', ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_AUTH_TOKEN: KEY2}, paths);
	assert.deepEqual(env, {PATH: '/bin', HOME: '/root', CLAUDE_CONFIG_DIR: paths.configDir, DISABLE_AUTOUPDATER: '1'});
	assert.ok(!JSON.stringify(env).includes('sk-ant'));
});

const sourceFiles = async (dir: URL): Promise<URL[]> => {
	const out: URL[] = [];
	for (const e of await readdir(dir, {withFileTypes: true})) {
		const url = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
		if (e.isDirectory()) out.push(...(await sourceFiles(url)));
		else if (/\.tsx?$/.test(e.name)) out.push(url);
	}
	return out;
};

test('the value of CLAUDE_CODE_OAUTH_TOKEN is never read: only presence checks and deletes touch it', async () => {
	const offenders: string[] = [];
	for (const file of await sourceFiles(new URL('../src/', import.meta.url))) {
		const lines = (await readFile(file, 'utf8')).split('\n');
		lines.forEach((line, i) => {
			if (!/\.CLAUDE_CODE_OAUTH_TOKEN\b/.test(line)) return;
			if (/^\s*delete\s+\w+\.CLAUDE_CODE_OAUTH_TOKEN;/.test(line) || /nonEmpty\(\w+(\.\w+)?\.CLAUDE_CODE_OAUTH_TOKEN\)/.test(line)) return;
			offenders.push(`${file.pathname.split('/src/')[1]}:${i + 1}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test('only login-slot.ts names the login working copy; nothing else opens it', async () => {
	const named: string[] = [];
	for (const file of await sourceFiles(new URL('../src/', import.meta.url))) {
		const text = await readFile(file, 'utf8');
		if (/\b(loginCredentialsFile|claudeJsonFile)\b|\.loginFile\b/.test(text)) named.push(file.pathname.split('/src/')[1]!);
	}
	assert.deepEqual(named, ['login-slot.ts']);
});
