import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {makeFakeLog, serialized} from './helpers/fake-log.js';
import {fakeCredentials, seed, type FakeCredentials} from './helpers/fake-credentials.js';
import {buildEnv, resolvePaths} from '../src/config.js';
import {chooseAccount, listAccounts, LoginUnsavedError, markLimited, removeAccount, setOrder, useAccount} from '../src/accounts.js';
import {
	accountsCtx,
	allSecrets,
	type CredentialOpts,
	describeCredential,
	inspectFileMode,
	listCredentialSources,
	makeRedactor,
	prepareCredential,
	registerLogRedaction,
	removeStored,
	requireCredential,
	resolveCredential,
	storeSecret,
} from '../src/credentials.js';
import {hostVault} from '../src/vault.js';

const KEY = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const KEY2 = 'sk-ant-api03-OTHERVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const OAUTH2 = 'sk-ant-oat-SECONDVALUE0123456789abcdef';
const tmp = () => mkdtemp(join(tmpdir(), 'claude-cred-'));
const shape = (c?: {kind: string; source: string; account?: string}) => c && {kind: c.kind, source: c.source, account: c.account};

// `null`: a host without the credential channel.
const setup = async (env: NodeJS.ProcessEnv = {}, fake: FakeCredentials | null = fakeCredentials(), now?: () => number) => {
	const dataDir = await tmp();
	const log = makeFakeLog();
	const opts: CredentialOpts = {env, dataDir, vault: hostVault(fake ?? undefined, log), log, ...(now && {now})};
	return {dataDir, opts, fake: fake as FakeCredentials, log};
};

type Who = {email: string; uuid: string; token: string};
const ALICE: Who = {email: 'alice@example.com', uuid: 'uuid-alice', token: 'ALICE-TOKEN-0123456789'};
const BOB: Who = {email: 'bob@example.com', uuid: 'uuid-bob', token: 'BOB-TOKEN-0123456789'};
const slotOf = (who: Who, expires = 1000) => ({
	credentials: {claudeAiOauth: {accessToken: who.token, refreshToken: `${who.token}-r`, expiresAt: expires}},
	oauthAccount: {emailAddress: who.email, accountUuid: who.uuid},
});

// A Claude Code login as it sits in the config dir (the working copy).
const writeLogin = async (dataDir: string, who: Who, expires = 1000, extra: Record<string, unknown> = {}) => {
	const config = join(dataDir, 'config');
	await mkdir(config, {recursive: true});
	await writeFile(join(config, '.credentials.json'), JSON.stringify(slotOf(who, expires).credentials));
	let claude: Record<string, unknown> = {};
	try {
		claude = JSON.parse(await readFile(join(config, '.claude.json'), 'utf8'));
	} catch {}
	await writeFile(join(config, '.claude.json'), JSON.stringify({...claude, ...extra, oauthAccount: slotOf(who).oauthAccount}));
};
const loginToken = async (dataDir: string): Promise<string> =>
	JSON.parse(await readFile(join(dataDir, 'config', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
const storedToken = (f: FakeCredentials, name: string): string => JSON.parse(f.accounts.get(name)!.secrets.login!).credentials.claudeAiOauth.accessToken;
const seedLogin = (f: FakeCredentials, name: string, who: Who, expires = 1000) =>
	seed(f, name, 'claude-login', JSON.stringify(slotOf(who, expires)), {fields: {email: who.email, method: 'claude.ai'}});

test('default priority: env key, env token, logins, then stored keys and tokens', async () => {
	const {opts, fake} = await setup();
	assert.equal(await resolveCredential(opts), undefined);
	await storeSecret(opts, OAUTH);
	await storeSecret(opts, KEY2);
	assert.deepEqual(shape(await resolveCredential(opts)), {kind: 'api-key', source: 'stored', account: 'key'});
	seedLogin(fake, 'alice', ALICE);
	await opts.vault!.load();
	assert.deepEqual(shape(await resolveCredential(opts)), {kind: 'oauth', source: 'claude-login', account: 'alice'});
	assert.deepEqual(shape(await resolveCredential({...opts, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH2}})), {kind: 'oauth', source: 'env', account: 'env-token'});
	const both = await resolveCredential({...opts, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH2, ANTHROPIC_API_KEY: KEY}});
	assert.deepEqual({...shape(both), v: both?.value}, {kind: 'api-key', source: 'env', account: 'env-key', v: KEY});
	const list = await listCredentialSources({...opts, env: {ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH2}});
	assert.deepEqual(list.map(c => c.account), ['env-key', 'env-token', 'alice', 'key', 'token']);
});

test('without a usable store only the environment counts, and the error says why', async () => {
	const NO = 'No credentials found. Run "claude auth login" to sign in through the browser, or "claude auth add" to paste an API key or a subscription token. See "claude auth status".';
	const granted = await setup();
	assert.equal(await resolveCredential({...granted.opts, env: {ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: ''}}), undefined);
	await assert.rejects(requireCredential(granted.opts), {message: NO});
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
	}
	const broken = fakeCredentials();
	seed(broken, 'work', 'anthropic-token', OAUTH);
	broken.broken = true;
	const b = await setup({}, broken);
	await assert.rejects(requireCredential(b.opts), /cannot be decrypted; see: account vault status/);
	assert.ok(!serialized(b.log).includes(OAUTH));
});

test('an ungranted store is never written; the refusal names the grant', async () => {
	const fake = fakeCredentials({granted: []});
	const {opts} = await setup({}, fake);
	await assert.rejects(storeSecret(opts, KEY), /account grant claude/);
	assert.equal(await removeStored(opts), false);
	assert.deepEqual(fake.calls.filter(c => !c.startsWith('grants')), []);
});

test('a credential and a bundle never leak through stringification', async () => {
	const {opts, fake} = await setup({ANTHROPIC_API_KEY: KEY});
	seed(fake, 'work', 'anthropic-token', OAUTH);
	seedLogin(fake, 'alice', ALICE);
	const c = await resolveCredential(opts);
	assert.ok(c);
	const bundle = opts.vault!.current();
	for (const s of [JSON.stringify(c), inspect(c), `${c}`, JSON.stringify({c}), inspect({c}, {depth: 5}), JSON.stringify(bundle), inspect(bundle, {depth: 9}), inspect(bundle, {depth: 9, showHidden: true})]) {
		assert.ok(!s.includes('TESTVALUE') && !s.includes(ALICE.token), s);
	}
	assert.equal(c.value, KEY);
});

test('makeRedactor masks the credential, bundle values, tokens inside logins and applies the host redactor', async () => {
	const {opts, fake} = await setup({CLAUDE_CODE_OAUTH_TOKEN: 'plainsecretvalue'});
	seed(fake, 'k', 'anthropic-key', KEY2);
	seedLogin(fake, 'alice', ALICE);
	const c = await resolveCredential(opts);
	const r = makeRedactor(c, ['anothersecretvalue'], t => t.replace('github-token-xyz', '[host]'));
	assert.equal(r('x plainsecretvalue y anothersecretvalue z github-token-xyz'), 'x [redacted] y [redacted] z [host]');
	assert.equal(r(`k ${KEY} z`), 'k [redacted] z');
	assert.equal(makeRedactor()(`k ${KEY}`), 'k [redacted]');
	const all = allSecrets(opts);
	for (const v of [KEY2, ALICE.token, `${ALICE.token}-r`, 'plainsecretvalue']) assert.ok(all.includes(v), v);
	assert.ok(!all.includes(ALICE.email), 'the email is not a secret');
	const live = makeRedactor(undefined, () => allSecrets(opts));
	assert.equal(live(`a ${ALICE.token}-r b`), 'a [redacted] b');
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
	seedLogin(fake, 'alice', ALICE);
	await opts.vault!.load();
	await opts.vault!.load();
	const masked = log.redactors.reduce((t, fn) => fn(t), `${KEY} ${ALICE.token}`);
	assert.equal(masked, '[redacted] [redacted]');
	const n = log.redactors.length;
	await opts.vault!.load();
	assert.equal(log.redactors.length, n);
});

test('storeSecret tells a key from a token by its prefix and refuses garbage without echoing it', async () => {
	const {opts, fake} = await setup();
	for (const bad of ['garbage-TESTVALUE', 'sk-ant-x', 'sk-ant-api03-no pe-TESTVALUE0123456789']) {
		await assert.rejects(storeSecret(opts, bad), (e: Error) => !e.message.includes('TESTVALUE') && !e.message.includes(bad));
	}
	assert.equal(await removeStored(opts), false);
	assert.deepEqual(
		[await storeSecret(opts, OAUTH), await storeSecret(opts, ` ${KEY}\n`)].map(a => `${a.name}:${a.type}:${a.kind}`),
		['token:token:oauth', 'key:key:api-key'],
	);
	assert.deepEqual([fake.accounts.get('token')!.kind, fake.accounts.get('key')!.secrets.key], ['anthropic-token', KEY]);
});

test('several keys and tokens: named, deduplicated, replaced by name; names follow the account module', async () => {
	const {opts, fake} = await setup();
	seed(fake, 'key-2', 'github', 'ghp_hidden');
	assert.equal((await storeSecret(opts, ` ${KEY}\n`)).name, 'key');
	assert.equal((await storeSecret(opts, KEY2)).name, 'key-3', 'a name of a kind claude cannot see is skipped');
	assert.equal((await storeSecret(opts, OAUTH, 'work')).name, 'work');
	await assert.rejects(storeSecret(opts, KEY, 'again'), /already account "key"/);
	await storeSecret(opts, OAUTH2, 'work');
	assert.equal(fake.accounts.get('work')!.secrets.token, OAUTH2);
	await assert.rejects(storeSecret(opts, 'sk-ant-api03-THIRDVALUE0123456789abcdef', 'work'), /"work" is a subscription token account/);
	assert.deepEqual(listAccounts(accountsCtx(opts)).map(a => `${a.name}:${a.type}`), ['key:key', 'key-3:key', 'work:token']);
	assert.equal(prepareCredential(opts).value, KEY);
	await assert.rejects(storeSecret(opts, KEY2, 'env-key'), /environment variable account/);
	await assert.rejects(storeSecret(opts, KEY2, 'Work'), /lowercase/);
});

test('order, use and remove change the priority in auth.json; environment accounts take part but cannot be removed', async () => {
	const {opts, dataDir, fake} = await setup({ANTHROPIC_API_KEY: KEY});
	await storeSecret(opts, OAUTH, 'a');
	await storeSecret(opts, OAUTH2, 'b');
	const ctx = () => accountsCtx(opts);
	assert.deepEqual(listAccounts(ctx()).map(a => a.name), ['env-key', 'a', 'b']);
	assert.deepEqual(setOrder(ctx(), ['b', 'a']).map(a => a.name), ['b', 'a', 'env-key']);
	assert.equal(chooseAccount(ctx())?.name, 'b');
	assert.throws(() => setOrder(ctx(), ['nope']), /No account "nope"/);
	assert.throws(() => setOrder(ctx(), ['a', 'a']), /Each account once/);
	assert.deepEqual(useAccount(ctx(), 'env-key').map(a => a.name), ['env-key', 'b', 'a']);
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
	seed(fake, 'empty', 'anthropic-token');
	seed(fake, 'ok', 'anthropic-token', OAUTH);
	const {opts} = await setup({}, fake);
	await opts.vault!.load();
	const list = listAccounts(accountsCtx(opts));
	assert.deepEqual(list.map(a => [a.name, a.unusable]), [['off', 'disabled'], ['env-key', 'reserved'], ['empty', 'missing'], ['ok', undefined]]);
	assert.equal((await resolveCredential(opts))?.account, 'ok');
	assert.ok(!allSecrets(opts).includes(KEY), 'a disabled account is not read');
});

test('a limited account is skipped until its reset; when all are limited, the first to reset is used', async () => {
	let now = 1_000_000_000_000;
	const {opts} = await setup({}, fakeCredentials(), () => now);
	await storeSecret(opts, OAUTH, 'a');
	await storeSecret(opts, OAUTH2, 'b');
	const ctx = () => accountsCtx(opts);
	markLimited(ctx(), 'a', now / 1000 + 3600, 'usage-limit');
	assert.equal(chooseAccount(ctx())?.name, 'b');
	const view = listAccounts(ctx()).find(a => a.name === 'a')!;
	assert.deepEqual([view.limitedUntil, view.reason], [now / 1000 + 3600, 'usage-limit']);
	markLimited(ctx(), 'b', now / 1000 + 600, 'billing');
	assert.equal(chooseAccount(ctx())?.name, 'b', 'all limited: b resets first');
	now += 3601_000;
	assert.equal(chooseAccount(ctx())?.name, 'a', 'a is back after its reset');
	useAccount(ctx(), 'b');
	assert.equal(listAccounts(ctx()).find(a => a.name === 'b')!.limitedUntil, undefined, '"use" forgets the limit');
	const c = prepareCredential(opts);
	assert.deepEqual({...shape(c), v: c.value}, {kind: 'oauth', source: 'stored', account: 'b', v: OAUTH2});
});

test('a login made in Claude Code directly is adopted at the first use; its credential has no value', async () => {
	const {opts, dataDir, fake} = await setup();
	await writeLogin(dataDir, ALICE);
	const c = await resolveCredential(opts);
	assert.deepEqual(shape(c), {kind: 'oauth', source: 'claude-login', account: 'alice'});
	assert.equal(c!.value, '');
	for (const s of [JSON.stringify(c), inspect(c), `${c}`]) assert.ok(!s.includes(ALICE.token), s);
	assert.equal(storedToken(fake, 'alice'), ALICE.token);
	assert.deepEqual(fake.accounts.get('alice')!.fields, {method: 'claude.ai', email: ALICE.email});
	assert.equal(listAccounts(accountsCtx(opts))[0]!.email, ALICE.email);
	const log = makeFakeLog();
	registerLogRedaction(log, c!);
	assert.equal(log.redactors.length, 0, 'an empty value registers no redactor');
});

test('logins are swapped into the config dir only when the working copy is saved; the rest of .claude.json stays', async () => {
	const fake = fakeCredentials();
	seedLogin(fake, 'alice', ALICE, 1000);
	seedLogin(fake, 'bob', BOB, 1000);
	const {opts, dataDir} = await setup({}, fake);
	await mkdir(join(dataDir, 'config'), {recursive: true});
	await writeFile(join(dataDir, 'config', '.claude.json'), JSON.stringify({mcpServers: {x: {command: 'y'}}}));
	await opts.vault!.load();
	setOrder(accountsCtx(opts), ['alice', 'bob']);
	await writeFile(join(dataDir, 'config', 'policy-limits.json'), '{}');
	assert.equal(prepareCredential(opts).account, 'alice');
	assert.equal(await loginToken(dataDir), ALICE.token);
	const claude = JSON.parse(await readFile(join(dataDir, 'config', '.claude.json'), 'utf8'));
	assert.deepEqual(claude.mcpServers, {x: {command: 'y'}}, 'other settings stay');
	assert.ok(!(await readdir(join(dataDir, 'config'))).includes('policy-limits.json'), "the other organisation's cache goes");
	// Claude Code refreshes Alice's login while she is in: the working copy is now ahead of the store.
	await writeLogin(dataDir, {...ALICE, token: 'ALICE-REFRESHED-0123456789'}, 2000);
	assert.equal(prepareCredential(opts).account, 'alice', 'the refreshed login is used as it is');
	assert.equal(await loginToken(dataDir), 'ALICE-REFRESHED-0123456789');
	setOrder(accountsCtx(opts), ['bob', 'alice']);
	assert.throws(() => prepareCredential(opts), LoginUnsavedError);
	assert.equal(await loginToken(dataDir), 'ALICE-REFRESHED-0123456789', 'the unsaved login was not overwritten');
	assert.equal(storedToken(fake, 'alice'), ALICE.token);
	const {loginSyncOf} = await import('../src/credentials.js');
	assert.equal(await loginSyncOf(opts).sync(), 'saved');
	assert.equal(storedToken(fake, 'alice'), 'ALICE-REFRESHED-0123456789');
	assert.equal(prepareCredential(opts).account, 'bob');
	assert.equal(await loginToken(dataDir), BOB.token);
});

test('removing the installed login signs Claude Code out of it; removeStored forgets every Claude account', async () => {
	const {opts, dataDir, fake} = await setup();
	seed(fake, 'gh', 'github', 'ghp_keep');
	await writeLogin(dataDir, ALICE, 1000, {keep: 1});
	await storeSecret(opts, KEY);
	assert.deepEqual(await removeAccount(accountsCtx(opts), opts.vault!, 'alice'), {wasInstalled: true});
	assert.ok(!(await readdir(join(dataDir, 'config'))).includes('.credentials.json'));
	const claude = JSON.parse(await readFile(join(dataDir, 'config', '.claude.json'), 'utf8'));
	assert.deepEqual(claude, {keep: 1});
	assert.deepEqual(listAccounts(accountsCtx(opts)).map(a => a.name), ['key']);
	assert.equal(await removeStored(opts), true);
	assert.equal(await removeStored(opts), false);
	assert.deepEqual([...fake.accounts.keys()], ['gh'], 'accounts of other kinds stay');
});

test('inspectFileMode warns about a readable auth.json and login file', async () => {
	const {opts, dataDir} = await setup({ANTHROPIC_API_KEY: KEY});
	await storeSecret(opts, OAUTH, 'a');
	setOrder(accountsCtx(opts), ['a']);
	await chmod(join(dataDir, 'auth.json'), 0o644);
	let w = await inspectFileMode(dataDir);
	assert.equal(w.length, 1);
	assert.ok(w[0]!.startsWith('auth.json'));
	await chmod(join(dataDir, 'auth.json'), 0o600);
	assert.deepEqual(await inspectFileMode(dataDir), []);
	await writeLogin(dataDir, ALICE);
	await chmod(join(dataDir, 'config', '.credentials.json'), 0o644);
	w = await inspectFileMode(dataDir);
	assert.match(w[0]!, /\.credentials\.json is readable by other users/);
});

test('describeCredential names the account', () => {
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'api-key', source: 'env', account: 'env-key'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'oauth', source: 'stored', account: 'work'}), 'account "work": subscription token (stored in the account module)');
	assert.equal(describeCredential({kind: 'oauth', source: 'claude-login'}), 'Claude subscription (Claude Code login)');
	assert.equal(describeCredential({kind: 'api-key', source: 'claude-login', account: 'me'}), 'account "me": Console API key (Claude Code login)');
});

test('registerLogRedaction registers once per value and logger', async () => {
	const {opts} = await setup({CLAUDE_CODE_OAUTH_TOKEN: OAUTH});
	const a = (await resolveCredential(opts))!;
	const b = (await resolveCredential(opts))!;
	const log = makeFakeLog();
	registerLogRedaction(log, a);
	registerLogRedaction(log, b);
	assert.equal(log.redactors.length, 1);
	assert.equal(log.redactors[0]!(`token=${OAUTH}`), 'token=[redacted]');
	const c = (await resolveCredential({...opts, env: {CLAUDE_CODE_OAUTH_TOKEN: `${OAUTH}2`}}))!;
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 2);
});

test('a stored token or key reaches Claude Code as the matching variable only', async () => {
	const {opts, dataDir} = await setup();
	await storeSecret(opts, OAUTH);
	let env = buildEnv({}, resolvePaths(dataDir), await requireCredential(opts));
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
	assert.ok(!('ANTHROPIC_API_KEY' in env));
	const key = await storeSecret(opts, KEY);
	useAccount(accountsCtx(opts), key.name);
	env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: 'stale'}, resolvePaths(dataDir), await requireCredential(opts));
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
});
