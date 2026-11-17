import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openSource, type ChatRoute, type ChatRouteRequest, type ChatRunDeps} from '../../src/chat/open.js';
import type {ChatProfile} from '../../src/deps/chat.js';

const profile = {
	id: 'clan',
	owner: 'clan',
	appendSystemPrompt: 'p',
	mainTools: [],
	agents: {},
} as ChatProfile;

const setup = async (route: ChatRoute) => {
	const requests: ChatRouteRequest[] = [];
	let released = 0;
	let spawned = 0;
	const held = {...route, release: () => void released++} as ChatRoute;
	const deps = {
		dataDir: await mkdtemp(join(tmpdir(), 'claude-open-profile-')),
		env: {CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-TESTVALUE0123456789abcdef'},
		loadChatQuery: async () => (() => (async function* () {})()) as never,
		store: {read: async () => ({}), update: async () => undefined},
		showNoticeOnce: async () => undefined,
		isMissingModule: () => false,
		acquire: () => () => undefined,
		route: (req: ChatRouteRequest) => {
			requests.push(req);
			return held;
		},
		spawnRunner: (async () => {
			spawned++;
			throw new Error('must not spawn');
		}) as never,
	} as unknown as ChatRunDeps;
	const io = {print: () => undefined, notice: () => undefined, wait: async () => false};
	return {deps, io, requests, released: () => released, spawned: () => spawned};
};

test('a profile open asks the route for a local chat even when attach and keep are requested', async () => {
	const s = await setup({kind: 'local', release: () => undefined});
	const source = await openSource({fresh: true, attach: true, keep: true, profile}, s.io, s.deps);
	assert.equal(source?.remote, undefined);
	source?.session.close();
	assert.deepEqual(s.requests, [{attach: false, keep: false}]);
	assert.equal(s.spawned(), 0);
});

test('a profile open is refused when the route is an attach or a spawn, and the route is released', async () => {
	for (const route of [
		{kind: 'attach', socketPath: '/nonexistent.sock'},
		{kind: 'spawn', sessionDir: '/nonexistent'},
	] as ChatRoute[]) {
		const s = await setup(route);
		await assert.rejects(openSource({fresh: true, profile}, s.io, s.deps), /runs only in this yena/);
		assert.equal(s.released(), 1);
		assert.equal(s.spawned(), 0);
	}
});

test('without a profile the route request still carries attach and keep', async () => {
	const s = await setup({kind: 'local', release: () => undefined});
	const source = await openSource({fresh: true, attach: true, keep: true}, s.io, s.deps);
	source?.session.close();
	assert.deepEqual(s.requests, [{attach: true, keep: true}]);
});
