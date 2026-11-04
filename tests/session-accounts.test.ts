import assert from 'node:assert/strict';
import {mkdtemp, readFile, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {useAccount, type AccountsCtx} from '../src/accounts.js';
import {bindSession, chooseForSession, sessionAccountsFile, sessionSubscription} from '../src/session-accounts.js';

const ID = '0f8b9a52-6a8e-4d3c-9b1e-2f4a6c8d0e12';
const ID2 = '1f8b9a52-6a8e-4d3c-9b1e-2f4a6c8d0e12';
const KEY = 'sk-ant-api03-' + 'a'.repeat(40);

const ctxOf = async (opts: {loginEmail?: string; loginOff?: boolean; envToken?: boolean; key?: boolean} = {}): Promise<AccountsCtx> => {
	const dataDir = await mkdtemp(join(tmpdir(), 'yena-sessacc-'));
	return {
		dataDir,
		configDir: join(dataDir, 'config'),
		env: {...(opts.envToken && {CLAUDE_CODE_OAUTH_TOKEN: 'x'})},
		bundle: {status: 'ok', entries: opts.key ? [{name: 'work', type: 'key', kind: 'api-key', disabled: false, value: KEY}] : []},
		...(!opts.loginOff && {login: {present: true, kind: 'oauth', ...(opts.loginEmail !== undefined && {email: opts.loginEmail})}}),
	};
};

test('a session without a recorded subscription takes the usual choice', async () => {
	const ctx = await ctxOf({loginEmail: 'a@x', envToken: true});
	assert.equal(chooseForSession(ctx, undefined)?.account.name, 'env-token');
});

test('a session stays on its subscription when another one is pinned', async () => {
	const ctx = await ctxOf({loginEmail: 'a@x', envToken: true});
	useAccount(ctx, 'env-token');
	const choice = chooseForSession(ctx, {account: 'login', email: 'a@x'});
	assert.equal(choice?.account.name, 'login');
	assert.deepEqual(choice?.kept, {wanted: 'env-token'});
});

test('a session may move to an API key', async () => {
	const ctx = await ctxOf({loginEmail: 'a@x', key: true});
	useAccount(ctx, 'work');
	const choice = chooseForSession(ctx, {account: 'login', email: 'a@x'});
	assert.equal(choice?.account.name, 'work');
	assert.equal(choice?.kept, undefined);
});

test('a login signed in to another subscription is refused for the session', async () => {
	const ctx = await ctxOf({loginEmail: 'b@x'});
	assert.throws(() => chooseForSession(ctx, {account: 'login', email: 'a@x'}), /only one Claude subscription/);
});

test('a missing subscription is refused, not replaced by another one', async () => {
	const ctx = await ctxOf({loginOff: true, envToken: true});
	assert.throws(() => chooseForSession(ctx, {account: 'login', email: 'a@x'}), /"login", which is not available/);
});

test('API key only: the session subscription is not used', async () => {
	const ctx = await ctxOf({loginEmail: 'a@x', key: true});
	assert.equal(chooseForSession(ctx, {account: 'login'}, {apiKeyOnly: true})?.account.name, 'work');
	const noKey = await ctxOf({loginEmail: 'a@x'});
	assert.equal(chooseForSession(noKey, {account: 'login'}, {apiKeyOnly: true}), undefined);
});

test('bindSession records only subscriptions and refuses a second one', async () => {
	const ctx = await ctxOf();
	assert.equal(bindSession(ctx.dataDir, ID, {name: 'work', type: 'key', kind: 'api-key'}), true);
	assert.equal(sessionSubscription(ctx.dataDir, ID), undefined);
	assert.equal(bindSession(ctx.dataDir, ID, {name: 'login', type: 'login', kind: 'oauth'}), true);
	assert.deepEqual(sessionSubscription(ctx.dataDir, ID), {account: 'login'});
	assert.equal(bindSession(ctx.dataDir, ID, {name: 'login', type: 'login', kind: 'oauth', email: 'a@x'}), true);
	assert.deepEqual(sessionSubscription(ctx.dataDir, ID), {account: 'login', email: 'a@x'});
	assert.equal(bindSession(ctx.dataDir, ID, {name: 'env-token', type: 'env', kind: 'oauth'}), false);
	assert.equal(bindSession(ctx.dataDir, ID, {name: 'login', type: 'login', kind: 'oauth', email: 'b@x'}), false);
	assert.deepEqual(sessionSubscription(ctx.dataDir, ID), {account: 'login', email: 'a@x'});
	assert.equal(sessionSubscription(ctx.dataDir, ID2), undefined);
	assert.equal((await stat(sessionAccountsFile(ctx.dataDir))).mode & 0o777, 0o600);
});

test('a broken file reads as no bindings', async () => {
	const ctx = await ctxOf();
	bindSession(ctx.dataDir, ID, {name: 'login', type: 'login', kind: 'oauth'});
	const raw = JSON.parse(await readFile(sessionAccountsFile(ctx.dataDir), 'utf8')) as {sessions: Record<string, unknown>};
	assert.ok(raw.sessions[ID]);
	assert.equal(sessionSubscription(ctx.dataDir, 'not-a-session'), undefined);
});
