import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {inspect} from 'node:util';
import {makeFakeLog} from './helpers/fake-log.js';
import {buildEnv, resolvePaths} from '../src/config.js';
import {
	addSecretAccount,
	adoptLogin,
	chooseAccount,
	listAccounts,
	markLimited,
	removeAccount,
	setOrder,
	stashLogin,
	useAccount,
} from '../src/accounts.js';
import {
	accountsCtx,
	allSecrets,
	describeCredential,
	inspectFileMode,
	listCredentialSources,
	makeRedactor,
	prepareCredential,
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
const OAUTH2 = 'sk-ant-oat-SECONDVALUE0123456789abcdef';
const tmp = () => mkdtemp(join(tmpdir(), 'claude-cred-'));
const ctxOf = (dataDir: string, env: NodeJS.ProcessEnv = {}, now?: () => number) => accountsCtx({dataDir, env, ...(now && {now})});
const shape = (c?: {kind: string; source: string; account?: string}) => c && {kind: c.kind, source: c.source, account: c.account};

// A Claude Code login as it sits in the config dir: the credentials file and the account in .claude.json.
const writeLogin = async (dataDir: string, who: {email: string; uuid: string; token: string}, extra: Record<string, unknown> = {}) => {
	const config = join(dataDir, 'config');
	await mkdir(config, {recursive: true});
	await writeFile(join(config, '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: who.token, refreshToken: `${who.token}-r`}}));
	let claude: Record<string, unknown> = {};
	try {
		claude = JSON.parse(await readFile(join(config, '.claude.json'), 'utf8'));
	} catch {}
	await writeFile(join(config, '.claude.json'), JSON.stringify({...claude, ...extra, oauthAccount: {emailAddress: who.email, accountUuid: who.uuid}}));
};
const loginToken = async (dataDir: string): Promise<string> =>
	JSON.parse(await readFile(join(dataDir, 'config', '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
const ALICE = {email: 'alice@example.com', uuid: 'uuid-alice', token: 'ALICE-TOKEN'};
const BOB = {email: 'bob@example.com', uuid: 'uuid-bob', token: 'BOB-TOKEN'};

test('default priority: env key, env token, logins, then stored accounts in the order they were added', async () => {
	const dir = await tmp();
	assert.equal(await resolveCredential({env: {}, dataDir: dir}), undefined);
	await storeOauthToken(dir, OAUTH);
	await storeApiKey(dir, KEY2);
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir})), {kind: 'oauth', source: 'stored', account: 'token'});
	await writeLogin(dir, ALICE);
	assert.deepEqual(shape(await resolveCredential({env: {}, dataDir: dir})), {kind: 'oauth', source: 'claude-login', account: 'alice@example.com'});
	assert.deepEqual(shape(await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH2}, dataDir: dir})), {kind: 'oauth', source: 'env', account: 'env-token'});
	const both = await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH2, ANTHROPIC_API_KEY: KEY}, dataDir: dir});
	assert.deepEqual({...shape(both), v: both?.value}, {kind: 'api-key', source: 'env', account: 'env-key', v: KEY});
	const list = await listCredentialSources({env: {ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH2}, dataDir: dir});
	assert.deepEqual(list.map(c => c.account), ['env-key', 'env-token', 'alice@example.com', 'token', 'key']);
});

test('empty environment values are skipped; requireCredential explains what to do', async () => {
	const dir = await tmp();
	assert.equal(await resolveCredential({env: {ANTHROPIC_API_KEY: '  ', CLAUDE_CODE_OAUTH_TOKEN: ''}, dataDir: dir}), undefined);
	await assert.rejects(requireCredential({env: {}, dataDir: dir}), {
		message:
			'No credentials found. Set ANTHROPIC_API_KEY, run "claude auth login", or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
	});
});

test('an old credentials.json becomes account "stored" and is removed; a broken one is dropped', async () => {
	const dir = await tmp();
	await writeFile(join(dir, 'credentials.json'), JSON.stringify({kind: 'api-key', value: KEY, savedAt: '2026-01-01T00:00:00.000Z'}));
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual({...shape(c), v: c?.value}, {kind: 'api-key', source: 'stored', account: 'stored', v: KEY});
	assert.ok(!(await readdir(dir)).includes('credentials.json'));
	assert.equal((await stat(join(dir, 'accounts.json'))).mode & 0o777, 0o600);
	const other = await tmp();
	for (const body of ['{bad', JSON.stringify({kind: 'oauth', value: KEY}), JSON.stringify({kind: 'api-key', value: 'short'})]) {
		await writeFile(join(other, 'credentials.json'), body);
		assert.equal(await resolveCredential({env: {}, dataDir: other}), undefined, body);
	}
	await writeFile(join(other, 'accounts.json'), '{bad');
	assert.equal(await resolveCredential({env: {}, dataDir: other}), undefined);
});

test('a credential never leaks through stringification', async () => {
	const c = await resolveCredential({env: {ANTHROPIC_API_KEY: KEY}, dataDir: await tmp()});
	assert.ok(c);
	for (const s of [JSON.stringify(c), inspect(c), `${c}`, JSON.stringify({c}), inspect({c}, {depth: 5})]) {
		assert.ok(!s.includes('TESTVALUE'), s);
	}
	assert.equal(c.value, KEY);
});

test('makeRedactor masks the credential, every other secret and the key pattern', async () => {
	const c = await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: 'plainsecretvalue'}, dataDir: await tmp()});
	const r = makeRedactor(c, ['anothersecretvalue']);
	assert.equal(r('x plainsecretvalue y anothersecretvalue'), 'x [redacted] y [redacted]');
	assert.equal(r(`k ${KEY} z`), 'k [redacted] z');
	assert.equal(makeRedactor()(`k ${KEY}`), 'k [redacted]');
	const dir = await tmp();
	await storeApiKey(dir, KEY2);
	assert.deepEqual(allSecrets({env: {ANTHROPIC_API_KEY: KEY}, dataDir: dir}).sort(), [KEY, KEY2].sort());
});

test('storing refuses the wrong kind and garbage without echoing it', async () => {
	const dir = await tmp();
	for (const bad of [OAUTH, 'garbage-TESTVALUE', 'sk-ant-x']) {
		await assert.rejects(storeApiKey(dir, bad), (e: Error) => !e.message.includes('TESTVALUE') && !e.message.includes(bad));
	}
	await assert.rejects(storeApiKey(dir, OAUTH), {
		message:
			'This looks like a subscription (OAuth) token, not an API key. Run "claude auth login --token" or set CLAUDE_CODE_OAUTH_TOKEN instead.',
	});
	await assert.rejects(storeOauthToken(dir, 'sk-ant-api03-nope'), (e: Error) => !e.message.includes('nope'));
	assert.equal(await removeStored(dir), false);
});

test('several keys and tokens: named, deduplicated, and replaced by name', async () => {
	const dir = await tmp();
	const ctx = ctxOf(dir);
	assert.equal((await storeApiKey(dir, ` ${KEY}\n`)).name, 'key');
	assert.equal((await storeApiKey(dir, KEY2)).name, 'key-2');
	assert.equal((await storeOauthToken(dir, OAUTH, 'work')).name, 'work');
	assert.throws(() => addSecretAccount(ctx, 'again', KEY), /already account "key"/);
	addSecretAccount(ctx, 'work', OAUTH2);
	assert.deepEqual(listAccounts(ctx).map(a => `${a.name}:${a.type}`), ['key:key', 'key-2:key', 'work:token']);
	assert.equal(prepareCredential({env: {}, dataDir: dir}).value, KEY);
	assert.throws(() => addSecretAccount(ctx, 'env-key', KEY), /environment variable account/);
	assert.throws(() => addSecretAccount(ctx, '../x', KEY), /account name/);
	const body = await readFile(join(dir, 'accounts.json'), 'utf8');
	assert.ok(body.includes(OAUTH2) && !body.includes(OAUTH), 'the replaced token is gone');
});

test('order, use and remove change the priority; environment accounts take part but cannot be removed', async () => {
	const dir = await tmp();
	const env = {ANTHROPIC_API_KEY: KEY};
	const ctx = ctxOf(dir, env);
	await storeOauthToken(dir, OAUTH, 'a');
	await storeOauthToken(dir, OAUTH2, 'b');
	assert.deepEqual(listAccounts(ctx).map(a => a.name), ['env-key', 'a', 'b']);
	assert.deepEqual(setOrder(ctx, ['b', 'a']).map(a => a.name), ['b', 'a', 'env-key']);
	assert.equal(chooseAccount(ctx)?.name, 'b');
	assert.throws(() => setOrder(ctx, ['nope']), /No account "nope"/);
	assert.throws(() => setOrder(ctx, ['a', 'a']), /Each account once/);
	assert.deepEqual(useAccount(ctx, 'env-key').map(a => a.name), ['env-key', 'b', 'a']);
	assert.throws(() => removeAccount(ctx, 'env-key'), /unset the variable/);
	removeAccount(ctx, 'b');
	assert.deepEqual(listAccounts(ctx).map(a => a.name), ['env-key', 'a']);
	assert.throws(() => removeAccount(ctx, 'b'), /No account "b"/);
});

test('a limited account is skipped until its reset; when all are limited, the first to reset is used', async () => {
	const dir = await tmp();
	let now = 1_000_000_000_000;
	const ctx = ctxOf(dir, {}, () => now);
	await storeOauthToken(dir, OAUTH, 'a');
	await storeOauthToken(dir, OAUTH2, 'b');
	markLimited(ctx, 'a', now / 1000 + 3600, 'usage-limit');
	assert.equal(chooseAccount(ctx)?.name, 'b');
	const view = listAccounts(ctx).find(a => a.name === 'a')!;
	assert.deepEqual([view.limitedUntil, view.reason], [now / 1000 + 3600, 'usage-limit']);
	markLimited(ctx, 'b', now / 1000 + 600, 'billing');
	assert.equal(chooseAccount(ctx)?.name, 'b', 'all limited: b resets first');
	now += 3601_000;
	assert.equal(chooseAccount(ctx)?.name, 'a', 'a is back after its reset');
	useAccount(ctx, 'b');
	assert.equal(listAccounts(ctx).find(a => a.name === 'b')!.limitedUntil, undefined, '"use" forgets the limit');
	const c = prepareCredential({env: {}, dataDir: dir, now: () => now});
	assert.deepEqual({...shape(c), v: c.value}, {kind: 'oauth', source: 'stored', account: 'b', v: OAUTH2});
});

test('a Claude Code login becomes an account named by its email; its credential has no value and nothing leaks', async () => {
	const dir = await tmp();
	await writeLogin(dir, ALICE);
	const c = await resolveCredential({env: {}, dataDir: dir});
	assert.deepEqual(shape(c), {kind: 'oauth', source: 'claude-login', account: 'alice@example.com'});
	assert.equal(c!.value, '');
	for (const s of [JSON.stringify(c), inspect(c), `${c}`]) assert.ok(!s.includes('ALICE-TOKEN'), s);
	const slot = join(dir, 'accounts', 'alice@example.com', 'login.json');
	assert.equal((await stat(slot)).mode & 0o777, 0o600);
	assert.equal(JSON.parse(await readFile(slot, 'utf8')).credentials.claudeAiOauth.accessToken, 'ALICE-TOKEN');
	assert.equal(listAccounts(ctxOf(dir))[0]!.email, 'alice@example.com');
	const log = makeFakeLog();
	let added = 0;
	registerLogRedaction({...log, addRedactor: () => void added++} as unknown as Parameters<typeof registerLogRedaction>[0], c!);
	assert.equal(added, 0, 'an empty value registers no redactor');
});

test('logins are swapped into the config dir; the one leaving keeps its refreshed tokens; the rest of .claude.json stays', async () => {
	const dir = await tmp();
	const ctx = ctxOf(dir);
	await writeLogin(dir, ALICE, {mcpServers: {x: {command: 'y'}}});
	adoptLogin(ctx, 'alice');
	stashLogin(ctx);
	await writeLogin(dir, BOB);
	adoptLogin(ctx, 'bob');
	assert.equal(await loginToken(dir), 'BOB-TOKEN');
	await writeFile(join(dir, 'config', 'policy-limits.json'), '{}');
	setOrder(ctx, ['alice', 'bob']);
	const c = prepareCredential({env: {}, dataDir: dir});
	assert.equal(c.account, 'alice');
	assert.equal(await loginToken(dir), 'ALICE-TOKEN');
	const claude = JSON.parse(await readFile(join(dir, 'config', '.claude.json'), 'utf8'));
	assert.deepEqual(claude.oauthAccount, {emailAddress: ALICE.email, accountUuid: ALICE.uuid});
	assert.deepEqual(claude.mcpServers, {x: {command: 'y'}}, 'other settings stay');
	assert.ok(!(await readdir(join(dir, 'config'))).includes('policy-limits.json'), 'the other organisation\'s cache goes');
	// Claude Code refreshes Alice's token while she is in; it travels back to her slot at the next swap.
	await writeLogin(dir, {...ALICE, token: 'ALICE-REFRESHED'});
	setOrder(ctx, ['bob', 'alice']);
	prepareCredential({env: {}, dataDir: dir});
	assert.equal(await loginToken(dir), 'BOB-TOKEN');
	setOrder(ctx, ['alice', 'bob']);
	prepareCredential({env: {}, dataDir: dir});
	assert.equal(await loginToken(dir), 'ALICE-REFRESHED');
});

test('a login made directly in Claude Code is taken as a new account, not saved over the installed one', async () => {
	const dir = await tmp();
	const ctx = ctxOf(dir);
	await writeLogin(dir, ALICE);
	adoptLogin(ctx, 'alice');
	await writeLogin(dir, BOB);
	assert.deepEqual(listAccounts(ctx).map(a => a.name), ['alice', 'bob@example.com']);
	const aliceSlot = JSON.parse(await readFile(join(dir, 'accounts', 'alice', 'login.json'), 'utf8'));
	assert.equal(aliceSlot.credentials.claudeAiOauth.accessToken, 'ALICE-TOKEN');
});

test('removing the installed login signs Claude Code out of it; removeStored forgets everything', async () => {
	const dir = await tmp();
	const ctx = ctxOf(dir);
	await writeFile(join(dir, 'other.txt'), 'keep');
	await writeLogin(dir, ALICE, {keep: 1});
	await storeApiKey(dir, KEY);
	assert.deepEqual(removeAccount(ctx, 'alice@example.com'), {wasInstalled: true});
	assert.ok(!(await readdir(join(dir, 'config'))).includes('.credentials.json'));
	const claude = JSON.parse(await readFile(join(dir, 'config', '.claude.json'), 'utf8'));
	assert.deepEqual(claude, {keep: 1});
	assert.deepEqual(listAccounts(ctx).map(a => a.name), ['key'], 'not adopted again');
	assert.equal(await removeStored(dir), true);
	assert.equal(await removeStored(dir), false);
	assert.deepEqual((await readdir(dir)).sort(), ['config', 'other.txt']);
});

test('inspectFileMode warns about readable accounts and login files', async () => {
	const dir = await tmp();
	await storeApiKey(dir, KEY);
	await chmod(join(dir, 'accounts.json'), 0o644);
	let w = await inspectFileMode(dir);
	assert.equal(w.length, 1);
	assert.ok(w[0]!.startsWith('accounts.json'));
	assert.ok(!w[0]!.includes('TESTVALUE'));
	await chmod(join(dir, 'accounts.json'), 0o600);
	assert.deepEqual(await inspectFileMode(dir), []);
	await writeLogin(dir, ALICE);
	await chmod(join(dir, 'config', '.credentials.json'), 0o644);
	w = await inspectFileMode(dir);
	assert.match(w[0]!, /\.credentials\.json is readable by other users/);
});

test('describeCredential names the account', () => {
	assert.equal(describeCredential({kind: 'api-key', source: 'env'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'api-key', source: 'env', account: 'env-key'}), 'API key (from environment)');
	assert.equal(describeCredential({kind: 'oauth', source: 'stored', account: 'work'}), 'account "work": subscription token (stored by yena)');
	assert.equal(describeCredential({kind: 'oauth', source: 'claude-login'}), 'Claude subscription (Claude Code login)');
	assert.equal(describeCredential({kind: 'api-key', source: 'claude-login', account: 'me'}), 'account "me": Console API key (Claude Code login)');
});

test('registerLogRedaction registers once per value and logger', async () => {
	const dir = await tmp();
	const a = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir}))!;
	const b = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, dataDir: dir}))!;
	const log = makeFakeLog();
	registerLogRedaction(log, a);
	registerLogRedaction(log, b);
	assert.equal(log.redactors.length, 1);
	assert.equal(log.redactors[0]!(`token=${OAUTH}`), 'token=[redacted]');
	const c = (await resolveCredential({env: {CLAUDE_CODE_OAUTH_TOKEN: `${OAUTH}2`}, dataDir: dir}))!;
	registerLogRedaction(log, c);
	assert.equal(log.redactors.length, 2);
});

test('a stored token or key reaches Claude Code as the matching variable only', async () => {
	const dir = await tmp();
	await storeOauthToken(dir, OAUTH);
	let env = buildEnv({}, resolvePaths(dir), await requireCredential({env: {}, dataDir: dir}));
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
	assert.ok(!('ANTHROPIC_API_KEY' in env));
	useAccount(ctxOf(dir), (await storeApiKey(dir, KEY)).name);
	env = buildEnv({CLAUDE_CODE_OAUTH_TOKEN: 'stale'}, resolvePaths(dir), await requireCredential({env: {}, dataDir: dir}));
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
});
