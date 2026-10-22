import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import type {CommandContext} from '../../../../src/api.js';
import type {ChatUi} from '../../src/chat/command.js';
import {createClaudeCommands, type ClaudeDeps} from '../../src/commands.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runnerSocketPath} from '../../src/runner/spawn.js';
import {serveControl} from '../../src/sessions/control.js';
import {acquireLock} from '../../src/sessions/lock.js';
import type {ChatQueryFn, QueryFn} from '../../src/types.js';

const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const SID = '11111111-aaaa-4bbb-8ccc-222222222222';
type Props = Parameters<ChatUi['createChatElement']>[0];

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

const setup = async (opts: {keep?: boolean; deps?: Partial<ClaudeDeps>} = {}) => {
	const dataDir = mkdtempSync(join(tmpdir(), 'route-data-'));
	const sessionDir = mkdtempSync(join(tmpdir(), 'route-sess-'));
	if (opts.keep) writeFileSync(join(dataDir, 'state.json'), JSON.stringify({chatKeepRunning: 'on'}));
	const printed: string[] = [];
	const props: Props[] = [];
	const waits: Array<Parameters<NonNullable<ChatUi['createWaitingElement']>>[0]> = [];
	const scripts: Array<(close: () => void) => void | Promise<void>> = [];
	let mounts = 0;
	const ctx: CommandContext = {
		print: t => printed.push(t),
		clear: () => {},
		exit: () => {},
		mount: async build => {
			const n = mounts++;
			let close!: () => void;
			const done = new Promise<void>(r => (close = r));
			build({close});
			void Promise.resolve(scripts[n] ? scripts[n]!(close) : close());
			await done;
		},
	};
	const query = (() => (async function* () {})()) as unknown as ChatQueryFn;
	const chat = createClaudeCommands({
		dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => { throw new Error('unused'); }) as unknown as QueryFn,
		loadChatQuery: async () => query,
		loadUi: async () => ({
			createChatElement: p => (props.push(p), {}),
			createWaitingElement: p => (waits.push(p), {}),
		}),
		login: {probe: async () => undefined},
		sessionDir: () => sessionDir,
		shellTmp: () => mkdtempSync(join(tmpdir(), 'route-shell-')),
		chatTiming: {waitPollMs: 5, remote: {connectTimeoutMs: 2000}},
		...opts.deps,
	}).find(c => c.name === 'claude')!;
	return {chat, ctx, printed, props, waits, scripts, dataDir, sessionDir, mounts: () => mounts};
};

test('setting Off keeps the chat in this process', async () => {
	let spawned = 0;
	const t = await setup({deps: {spawnRunner: async () => (spawned++, {socketPath: '', pid: 1})}});
	await t.chat.run(['chat'], t.ctx);
	assert.equal(spawned, 0);
	assert.equal(t.props.length, 1);
	assert.equal(t.props[0]!.controller.detachesOnClose, undefined);
});

test('setting On spawns a runner and attaches with hello then open', async () => {
	let frames: ClientFrame[] = [];
	let spawnArgs: Record<string, unknown> | undefined;
	const t = await setup({
		keep: true,
		deps: {
			spawnRunner: async opts => {
				spawnArgs = opts as unknown as Record<string, unknown>;
				frames = await startRunnerServer(opts.sessionDir);
				return {socketPath: runnerSocketPath(opts.sessionDir), pid: 1};
			},
		},
	});
	await t.chat.run(['chat', '--new'], t.ctx);
	assert.equal(spawnArgs?.sessionDir, t.sessionDir);
	assert.equal(t.props.length, 1);
	assert.equal(t.props[0]!.controller.detachesOnClose, true);
	const open = frames.find(f => f.type === 'open') as Extract<ClientFrame, {type: 'open'}>;
	assert.equal(open.keep, true);
	assert.equal(open.open.fresh, true);
	assert.match(t.printed.at(-1)!, /^\[chat left running|^\[chat closed/);
});

test('a failing spawn warns and falls back to the local chat', async () => {
	const t = await setup({
		keep: true,
		deps: { spawnRunner: async () => { throw new Error('Could not start the background chat'); } },
	});
	await t.chat.run(['chat'], t.ctx);
	assert.ok(t.printed.some(p => /could not start the chat in the background/i.test(p)));
	assert.equal(t.props.length, 1);
	assert.equal(t.props[0]!.controller.detachesOnClose, undefined);
});

test('a runner that holds the lock is attached to by chat, with a reattach notice', async () => {
	const t = await setup();
	const frames = await startRunnerServer(t.sessionDir);
	const got = acquireLock({dir: t.sessionDir, kind: 'chat', where: 'runner', socket: runnerSocketPath(t.sessionDir)});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	await t.chat.run(['chat'], t.ctx);
	assert.equal(t.props.length, 1);
	assert.equal(t.props[0]!.controller.detachesOnClose, true);
	assert.deepEqual(frames.map(f => f.type), ['hello']);
	assert.equal(t.waits.length, 0);
	assert.ok(t.printed.some(p => p.includes('Reattached to a session working since')));
});

test('new waits for a runner instead of attaching, and Esc cancels without error', async () => {
	const t = await setup();
	await startRunnerServer(t.sessionDir);
	const got = acquireLock({dir: t.sessionDir, kind: 'chat', where: 'runner', socket: runnerSocketPath(t.sessionDir)});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	t.scripts.push(close => {
		assert.equal(t.waits.length, 1);
		t.waits[0]!.onCancel();
		void close;
	});
	await t.chat.run(['new'], t.ctx);
	assert.equal(t.props.length, 0);
});

test('a chat held by another yena waits, polls the lock and opens when it is free', async () => {
	const t = await setup();
	const got = acquireLock({dir: t.sessionDir, kind: 'chat', where: 'local'});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	t.scripts.push(async () => {
		const first = await t.waits[0]!.check();
		assert.equal(first.free, false);
		assert.ok(first.title);
		if (got.ok) got.lock.release();
		assert.equal((await t.waits[0]!.check()).free, true);
		t.waits[0]!.onFree();
	});
	await t.chat.run(['chat', '--new'], t.ctx);
	assert.equal(t.waits.length, 1);
	assert.equal(t.props.length, 1);
	assert.equal(t.mounts(), 2);
});

test('ask refuses while a session runs and names it by title when it answers', async () => {
	const t = await setup();
	const got = acquireLock({dir: t.sessionDir, kind: 'chat', where: 'local'});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	await assert.rejects(async () => t.chat.run(['ask', 'hi'], t.ctx), /^Error: A session is running \(chat( \w+)? since \d\d:\d\d\)\. Wait for it or run "claude stop"\.$/);
});

test('ask names the running session by its title when the control socket answers', async () => {
	const t = await setup();
	const got = acquireLock({dir: t.sessionDir, kind: 'chat', where: 'local'});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	const server = await serveControl({
		dir: t.sessionDir,
		handlers: {
			status: () => ({kind: 'chat', where: 'local', state: 'idle', title: 'Fix the parser', startedAt: 1, pending: 0, queued: 0, attached: true}),
			stop: () => {},
		},
	});
	cleanup.push(() => void server.close());
	await assert.rejects(async () => t.chat.run(['ask', 'hi'], t.ctx), {message: 'A session is running (Fix the parser). Wait for it or run "claude stop".'});
});
