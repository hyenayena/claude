import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {ClaudeDeps} from '../src/commands.js';
import {API_KEY_ONLY, type CredentialOpts} from '../src/credentials.js';
import {createClaudeProvider} from '../src/provider.js';
import {createSessionHub, type SessionHub} from '../src/session-hub.js';
import {createStore} from '../src/store.js';
import type {OpenEnv, Origin} from '../src/deps/chat.js';
import type {ChatQueryFn, QueryFn} from '../src/types.js';
import {makeFakeLog} from './helpers/fake-log.js';

const KEY = 'sk-ant-api03-SCHEDVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat01-TESTVALUE0123456789abcdef';
const NON_INTERACTIVE: Origin[] = ['unattended', 'module', 'x' as Origin];
const BUSY = 'A session is running (chat since 10:00). Wait for it or run "chat stop".';

const chatQuery = (() => Object.assign((async function* () {})(), {close: () => {}, interrupt: async () => {}})) as unknown as ChatQueryFn;

const setup = async (env: NodeJS.ProcessEnv) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-attach-'));
	const log = makeFakeLog();
	const deps: ClaudeDeps = {
		dataDir,
		env,
		log,
		loadQuery: async () => (() => (async function* () {})()) as unknown as QueryFn,
		loadChatQuery: async () => chatQuery,
		login: {probe: async () => undefined},
		loadRetired: async () => undefined,
	};
	const credOpts: CredentialOpts = {env, dataDir, log, probeLogin: async () => undefined};
	const hub: SessionHub = createSessionHub(deps, createStore(dataDir, log), credOpts, log);
	const provider = createClaudeProvider(hub, deps);
	const requests: Array<{attach: boolean; keep: boolean}> = [];
	const original = hub.routeChat;
	let override: ((req: {attach: boolean; keep: boolean}) => ReturnType<SessionHub['routeChat']>) | undefined;
	hub.routeChat = req => {
		requests.push(req);
		return override ? override(req) : original(req);
	};
	let waits = 0;
	const io: OpenEnv = {print: () => {}, notice: () => {}, wait: async () => (waits++, false)};
	return {provider, hub, requests, io, waits: () => waits, route: (fn: typeof override) => (override = fn)};
};

test('a non-interactive origin with attach never attaches: the route is asked without attach, and a busy runner is refused, not waited for', async () => {
	const s = await setup({ANTHROPIC_API_KEY: KEY});
	s.route(req => (req.attach ? {kind: 'attach', socketPath: '/nonexistent/runner.sock', release: () => {}} : {kind: 'wait', message: BUSY}));
	for (const origin of NON_INTERACTIVE) {
		await assert.rejects(s.provider.open({origin, fresh: true, attach: true}, s.io), {message: BUSY}, String(origin));
	}
	assert.deepEqual(s.requests.map(r => r.attach), [false, false, false]);
	assert.equal(s.waits(), 0);
});

test('a key-only open without attach still waits for a busy session as before', async () => {
	const s = await setup({ANTHROPIC_API_KEY: KEY});
	s.route(() => ({kind: 'wait', message: BUSY}));
	assert.equal(await s.provider.open({origin: 'unattended', fresh: true}, s.io), undefined);
	assert.equal(s.waits(), 1);
});

test('a route that returns an attach for a key-only open is refused and released: nothing connects', async () => {
	const s = await setup({ANTHROPIC_API_KEY: KEY});
	let released = 0;
	s.route(() => ({kind: 'attach', socketPath: '/nonexistent/runner.sock', release: () => void released++}));
	for (const origin of NON_INTERACTIVE) {
		await assert.rejects(s.provider.open({origin, fresh: true}, s.io), /does not join/, String(origin));
	}
	assert.equal(released, 3);
});

test('an interactive origin keeps attach in the route request', async () => {
	const s = await setup({CLAUDE_CODE_OAUTH_TOKEN: OAUTH});
	const chat = await s.provider.open({origin: 'user', fresh: true, attach: true}, s.io);
	assert.deepEqual(s.requests, [{attach: true, keep: false}]);
	chat!.close();
	await chat!.flush();
});

test('openKeyOnly is set only for a key-only open and reset on flush; a later unattended send into a login session is refused', async () => {
	const s = await setup({ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH});
	const login = await s.provider.open({origin: 'user', fresh: true}, s.io);
	assert.equal(s.hub.openKeyOnly, false);
	for (const origin of NON_INTERACTIVE) assert.throws(() => login!.admitSend(origin), {message: API_KEY_ONLY}, String(origin));
	for (const origin of ['user', 'assistant'] as Origin[]) login!.admitSend(origin);
	login!.close();
	await login!.flush();

	const keyed = await s.provider.open({origin: 'unattended', fresh: true}, s.io);
	assert.equal(s.hub.openKeyOnly, true);
	for (const origin of NON_INTERACTIVE) keyed!.admitSend(origin);
	keyed!.close();
	await keyed!.flush();
	assert.equal(s.hub.openKeyOnly, false);
	assert.equal(s.hub.openSession, undefined);
});
