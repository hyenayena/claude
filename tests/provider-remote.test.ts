import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import net from 'node:net';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import {createClaude} from '../src/commands.js';
import {API_KEY_ONLY} from '../src/credentials.js';
import {hostVault} from '../src/vault.js';
import type {Origin, OpenEnv} from '../src/deps/chat.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame} from '../src/runner/protocol.js';
import {runnerSocketPath} from '../src/runner/spawn.js';
import type {ChatQueryFn, QueryFn} from '../src/types.js';
import {fakeCredentials, seed} from './helpers/fake-credentials.js';
import {makeFakeLog} from './helpers/fake-log.js';

const OAUTH = 'sk-ant-oat01-TESTVALUE0123456789abcdef';
const KEY = 'sk-ant-api03-SCHEDVALUE0123456789abcdef';
const SID = '11111111-aaaa-4bbb-8ccc-222222222222';

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

const startRunnerServer = async (dir: string) => {
	const frames: ClientFrame[] = [];
	const server = net.createServer(s => {
		const dec = createDecoder('toRunner');
		s.on('error', () => {});
		s.on('data', d => {
			for (const f of dec.push(d) as ClientFrame[]) {
				frames.push(f);
				if (f.type === 'hello') {
					s.write(
						encodeFrame({
							v: 1, type: 'snapshot', state: 'idle', sessionId: SID, mode: 'default', needsNewSession: false,
							pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1_000,
						} as RunnerFrame),
					);
				}
			}
		});
		cleanup.push(() => s.destroy());
	});
	await new Promise<void>(r => server.listen(runnerSocketPath(dir), r));
	cleanup.push(() => server.close());
	return frames;
};

const setup = async (key: boolean) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'prov-remote-'));
	const sessionDir = mkdtempSync(join(tmpdir(), 'prov-remote-sess-'));
	const fake = fakeCredentials();
	if (key) seed(fake, 'sched', 'anthropic-key', KEY);
	const vault = hostVault(fake, makeFakeLog());
	await vault.load();
	let frames: ClientFrame[] = [];
	let spawned = 0;
	const {provider} = createClaude({
		dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		vault,
		loadQuery: async () => (() => { throw new Error('unused'); }) as unknown as QueryFn,
		loadChatQuery: async () => (() => (async function* () {})()) as unknown as ChatQueryFn,
		login: {probe: async () => undefined},
		sessionDir: () => sessionDir,
		shellTmp: () => mkdtempSync(join(tmpdir(), 'prov-remote-shell-')),
		chatTiming: {remote: {connectTimeoutMs: 2000}},
		spawnRunner: async opts => {
			spawned++;
			frames = await startRunnerServer(opts.sessionDir);
			return {socketPath: runnerSocketPath(opts.sessionDir), pid: 1};
		},
	});
	const env: OpenEnv = {print: () => {}, notice: () => {}, wait: async () => false};
	return {provider, env, frames: () => frames, spawned: () => spawned};
};

test('a background chat is opened key-only for a non-interactive origin and normally for the others', async () => {
	for (const [origin, keyOnly] of [['unattended', true], ['module', true], ['x', true], ['user', false], ['assistant', false]] as const) {
		const s = await setup(true);
		const chat = await s.provider.open({origin: origin as Origin, fresh: true, keep: true}, s.env);
		assert.ok(chat, origin);
		const open = s.frames().find(f => f.type === 'open') as Extract<ClientFrame, {type: 'open'}>;
		assert.equal(open.open.apiKeyOnly, keyOnly ? true : undefined, origin);
		chat.close();
		await chat.flush();
		for (const fn of cleanup) fn();
		cleanup = [];
	}
});

test('a background chat without a stored key is refused for a non-interactive origin before a runner starts', async () => {
	const s = await setup(false);
	await assert.rejects(s.provider.open({origin: 'unattended', fresh: true, keep: true}, s.env), {message: API_KEY_ONLY});
	assert.equal(s.spawned(), 0);
});
