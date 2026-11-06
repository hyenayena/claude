import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import {createClaude} from '../src/commands.js';
import {API_KEY_ONLY} from '../src/credentials.js';
import {hostVault} from '../src/vault.js';
import type {ChatUi} from '../src/chat/command.js';
import type {Origin, OpenEnv, OpenRequest} from '../src/deps/chat.js';
import type {ChatQueryFn, QueryFn} from '../src/types.js';
import {uiHelpers} from './helpers/chat-ui.js';
import {fakeCredentials, seed} from './helpers/fake-credentials.js';
import {makeFakeLog} from './helpers/fake-log.js';

const OAUTH = 'sk-ant-oat01-TESTVALUE0123456789abcdef';
const KEY = 'sk-ant-api03-SCHEDVALUE0123456789abcdef';
const SID = '11111111-aaaa-4bbb-8ccc-222222222222';
const NON_INTERACTIVE: Origin[] = ['unattended', 'module', 'x' as Origin];
const INTERACTIVE: Origin[] = ['user', 'assistant'];

const chatQuery = (() =>
	Object.assign(
		(async function* () {})(),
		{close: () => {}, interrupt: async () => {}},
	)) as unknown as ChatQueryFn;

const setup = async (o: {key?: boolean; env?: NodeJS.ProcessEnv; login?: boolean; ask?: () => Promise<void>} = {}) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-provider-'));
	const fake = fakeCredentials();
	if (o.key) seed(fake, 'sched', 'anthropic-key', KEY);
	const vault = hostVault(fake, makeFakeLog());
	await vault.load();
	let queries = 0;
	const {commands, provider} = createClaude({
		dataDir,
		env: o.env ?? {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		vault,
		loadQuery: async () => {
			queries++;
			return (() =>
				(async function* () {
					await o.ask?.();
					yield {type: 'result', subtype: 'success', is_error: false, result: 'answer', session_id: SID};
				})()) as unknown as QueryFn;
		},
		loadChatQuery: async () => chatQuery,
		loadUi: async () => ({...uiHelpers, createChatElement: () => ({})}) as ChatUi,
		login: {probe: async () => (o.login ? {loggedIn: true, method: 'claude.ai'} : undefined)},
		loadRetired: async () => undefined,
	});
	const printed: string[] = [];
	const env: OpenEnv = {print: t => void printed.push(t), notice: t => void printed.push(t), wait: async () => false};
	const ctx: CommandContext = {print: t => void printed.push(t), clear: () => {}, exit: () => {}};
	const open = (req: Partial<OpenRequest> & {origin: Origin}) => provider.open({fresh: true, ...req}, env);
	return {dataDir, commands, provider, printed, env, ctx, open, queries: () => queries};
};

const closeAll = async (chat: {close(): void; flush(): Promise<void>} | undefined): Promise<void> => {
	if (!chat) return;
	chat.close();
	await chat.flush();
};

test('the provider describes itself', async () => {
	const {provider} = await setup();
	assert.equal(provider.id, 'claude');
	assert.equal(provider.label, 'Claude Code');
	assert.deepEqual(provider.modes, ['default', 'acceptEdits', 'plan', 'auto']);
	assert.equal(provider.validModel('claude-test-1'), true);
	assert.equal(provider.validModel('bad model'), false);
});

test('admit lets an interactive origin through without a key and refuses the others', async () => {
	const s = await setup();
	for (const origin of INTERACTIVE) await s.provider.admit(origin);
	for (const origin of NON_INTERACTIVE) await assert.rejects(s.provider.admit(origin), {message: API_KEY_ONLY}, String(origin));
});

test('admit accepts a non-interactive origin when a stored key exists, even with the env token first or pinned', async () => {
	const s = await setup({key: true, login: true});
	for (const origin of NON_INTERACTIVE) await s.provider.admit(origin);
	await s.commands.find(c => c.name === 'claude')!.run(['auth', 'use', 'login'], s.ctx);
	for (const origin of NON_INTERACTIVE) await s.provider.admit(origin);
});

test('admit refuses while an ask is running', async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => (release = resolve));
	const s = await setup({ask: () => gate});
	const asking = s.provider.ask({origin: 'user', text: 'hi', fresh: true}, {print: () => {}});
	await new Promise(resolve => setTimeout(resolve, 20));
	await assert.rejects(s.provider.admit('user'), {message: 'An ask is already running'});
	await assert.rejects(s.provider.admit('unattended'), {message: 'An ask is already running'});
	release();
	await asking;
	await s.provider.admit('user');
});

test('admit with no key leaves the open chat untouched', async () => {
	const s = await setup();
	const chat = await s.open({origin: 'user'});
	assert.ok(chat);
	await assert.rejects(s.provider.admit('unattended'), {message: API_KEY_ONLY});
	assert.notEqual(chat.session.state, 'closed');
	await closeAll(chat);
});

test('open gives an interactive origin the normal selection and frees everything at flush', async () => {
	const s = await setup({key: true});
	for (const origin of INTERACTIVE) {
		const chat = await s.open({origin});
		assert.ok(chat);
		assert.equal(chat.account, 'env-token');
		assert.equal(chat.projectDir.length > 0, true);
		assert.equal(chat.detachedWhileRunning(), false);
		await closeAll(chat);
	}
});

test('open is key-only for unattended, module and unknown origins on every path', async () => {
	const s = await setup({key: true, login: true});
	await s.commands.find(c => c.name === 'claude')!.run(['auth', 'use', 'login'], s.ctx);
	const paths: Partial<OpenRequest>[] = [
		{fresh: true},
		{fresh: false},
		{fresh: false, resume: SID},
		{fresh: false, resume: SID, fork: true},
		{fresh: false, resume: SID, fork: true, resumeAt: SID},
	];
	for (const origin of NON_INTERACTIVE) {
		for (const path of paths) {
			const chat = await s.open({origin, ...path});
			assert.ok(chat);
			assert.equal(chat.account, 'sched', `${String(origin)} ${JSON.stringify(path)}`);
			await closeAll(chat);
		}
	}
});

test('open with no stored key refuses a non-interactive origin on every path and opens nothing', async () => {
	const s = await setup();
	const paths: Partial<OpenRequest>[] = [{fresh: true}, {fresh: false}, {fresh: false, resume: SID}, {fresh: false, resume: SID, fork: true, resumeAt: SID}];
	for (const origin of NON_INTERACTIVE) {
		for (const path of paths) await assert.rejects(s.open({origin, ...path}), {message: API_KEY_ONLY}, `${String(origin)} ${JSON.stringify(path)}`);
	}
	const chat = await s.open({origin: 'user'});
	assert.ok(chat, 'no chat was left claimed by the refused opens');
	await closeAll(chat);
});

test('a second open is refused while a chat is open and allowed after flush', async () => {
	const s = await setup();
	const first = await s.open({origin: 'user'});
	assert.ok(first);
	await assert.rejects(s.open({origin: 'user'}), {message: 'A chat is already open'});
	await closeAll(first);
	const again = await s.open({origin: 'user'});
	assert.ok(again);
	await closeAll(again);
});

test('admitSend refuses a non-key-only chat for a non-interactive origin', async () => {
	const s = await setup({key: true});
	const chat = await s.open({origin: 'user'});
	assert.ok(chat);
	for (const origin of INTERACTIVE) chat.admitSend(origin);
	for (const origin of NON_INTERACTIVE) assert.throws(() => chat.admitSend(origin), {message: API_KEY_ONLY}, String(origin));
	await closeAll(chat);
});

test('admitSend accepts every origin for a chat that was opened key-only', async () => {
	const s = await setup({key: true});
	const chat = await s.open({origin: 'unattended'});
	assert.ok(chat);
	for (const origin of [...INTERACTIVE, ...NON_INTERACTIVE]) chat.admitSend(origin);
	await closeAll(chat);
});

test('ask on a subscription: allowed for user and assistant, refused for the others before the SDK loads', async () => {
	const s = await setup();
	for (const origin of INTERACTIVE) {
		await s.provider.ask({origin, text: 'hi', fresh: true}, {print: t => void s.printed.push(t)});
	}
	assert.equal(s.queries(), 2);
	assert.ok(s.printed.some(t => t.includes('subscription token')));
	for (const origin of NON_INTERACTIVE) {
		await assert.rejects(s.provider.ask({origin, text: 'hi', fresh: true}, {print: () => {}}), {message: API_KEY_ONLY}, String(origin));
	}
	assert.equal(s.queries(), 2, 'a refused ask never loads the SDK');
	await s.provider.ask({origin: 'user', text: 'again', fresh: true}, {print: () => {}});
});

test('ask by a non-interactive origin uses the stored key even when the env token comes first or is pinned', async () => {
	const s = await setup({key: true, login: true});
	await s.commands.find(c => c.name === 'claude')!.run(['auth', 'use', 'login'], s.ctx);
	for (const origin of NON_INTERACTIVE) {
		const out: string[] = [];
		await s.provider.ask({origin, text: 'hi', fresh: true}, {print: t => void out.push(t)});
		assert.ok(out.some(t => t.endsWith('· API key]')), String(origin));
		assert.ok(out.every(t => !t.includes(KEY)));
	}
});

test('ask stops when its signal aborts', async () => {
	const ac = new AbortController();
	const s = await setup({ask: () => new Promise(resolve => setTimeout(resolve, 5000).unref())});
	const asking = s.provider.ask({origin: 'user', text: 'hi', fresh: true}, {print: () => {}, signal: ac.signal});
	await new Promise(resolve => setTimeout(resolve, 20));
	ac.abort();
	await assert.rejects(asking);
});

test('redact removes the key the provider used', async () => {
	const s = await setup({key: true});
	await s.provider.ask({origin: 'unattended', text: 'hi', fresh: true}, {print: () => {}});
	assert.equal(s.provider.redact(`leak ${KEY} end`).includes(KEY), false);
});

test('legacyPrefs reads the three old chat settings and clearLegacyPrefs removes only them', async () => {
	const s = await setup();
	const file = join(s.dataDir, 'state.json');
	assert.deepEqual(await s.provider.legacyPrefs!(), {});
	await writeFile(file, JSON.stringify({chatPermissionMode: 'plan', chatInputMode: 'vim', chatKeepRunning: 'on', chatModel: 'claude-test-1'}));
	assert.deepEqual(await s.provider.legacyPrefs!(), {permissionMode: 'plan', inputMode: 'vim', keepRunning: true});
	await s.provider.clearLegacyPrefs!();
	assert.deepEqual(await s.provider.legacyPrefs!(), {});
	assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {chatModel: 'claude-test-1'});
	await s.provider.clearLegacyPrefs!();
	assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {chatModel: 'claude-test-1'});
});

test('describe lists the session rows without the token usage', async () => {
	const s = await setup();
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({chatModel: 'claude-test-1'}));
	const rows = await s.provider.describe();
	assert.deepEqual(rows.map(r => r.label), ['Session', 'Model', 'Chat model', 'Claude Code runtime', 'Agent SDK', 'Binary in use']);
	assert.equal(rows[2]!.value, 'claude-test-1');
	assert.equal(rows[0]!.value, '(none)');
});
