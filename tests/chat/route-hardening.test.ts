import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import type {CommandContext} from '../../../../src/api.js';
import type {ChatUi} from '../../src/chat/command.js';
import {createClaudeCommands, type ClaudeDeps} from '../../src/commands.js';
import {createDecoder, encodeFrame, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runnerSocketPath} from '../../src/runner/spawn.js';
import {acquireLock, lockPath} from '../../src/sessions/lock.js';
import {procStart} from '../../src/sessions/proc.js';
import type {ChatQueryFn, QueryFn} from '../../src/types.js';

const TOKEN = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const SID = '11111111-aaaa-4bbb-8ccc-222222222222';
type Props = Parameters<ChatUi['createChatElement']>[0];

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
});

type Script = (s: net.Socket, frame: ClientFrame) => void;

// A runner stand-in that answers the hello through `script`.
const startRunner = async (dir: string, script: Script) => {
	const frames: ClientFrame[] = [];
	const server = net.createServer(s => {
		const dec = createDecoder('toRunner');
		s.on('error', () => {});
		s.on('data', d => {
			for (const f of dec.push(d) as ClientFrame[]) {
				frames.push(f);
				script(s, f);
			}
		});
		cleanup.push(() => s.destroy());
	});
	await new Promise<void>(r => server.listen(runnerSocketPath(dir), r));
	cleanup.push(() => server.close());
	return frames;
};

const snapshot = (extra: Record<string, unknown> = {}): string =>
	encodeFrame({
		v: 1, type: 'snapshot', state: 'idle', sessionId: SID, mode: 'default', needsNewSession: false,
		pendingPermissions: [], tasks: [], commands: [], queued: [], startedAt: 1_000, ...extra,
	} as RunnerFrame);

const setup = async (opts: {deps?: Partial<ClaudeDeps>} = {}) => {
	const dataDir = mkdtempSync(join(tmpdir(), 'route-h-data-'));
	const sessionDir = mkdtempSync(join(tmpdir(), 'route-h-sess-'));
	cleanup.push(() => {
		rmSync(dataDir, {recursive: true, force: true});
		rmSync(sessionDir, {recursive: true, force: true});
	});
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
		env: {CLAUDE_CODE_OAUTH_TOKEN: TOKEN},
		loadQuery: async () => (() => { throw new Error('unused'); }) as unknown as QueryFn,
		loadChatQuery: async () => query,
		loadUi: async () => ({
			createChatElement: p => (props.push(p), {}),
			createWaitingElement: p => (waits.push(p), {}),
		}),
		login: {probe: async () => undefined},
		sessionDir: () => sessionDir,
		shellTmp: () => mkdtempSync(join(tmpdir(), 'route-h-shell-')),
		chatTiming: {waitPollMs: 5, remote: {connectTimeoutMs: 2000}},
		...opts.deps,
	}).find(c => c.name === 'claude')!;
	return {chat, ctx, printed, props, waits, scripts, dataDir, sessionDir};
};

const hold = (dir: string, where: 'local' | 'runner', socket?: string) => {
	const got = acquireLock({dir, kind: 'chat', where, ...(socket && {socket})});
	assert.ok(got.ok);
	cleanup.push(() => got.ok && got.lock.release());
	return got.ok ? got.lock : undefined;
};

test('the socket path comes from the session directory, never from the lock file', async () => {
	const t = await setup();
	const frames = await startRunner(t.sessionDir, (s, f) => {
		if (f.type === 'hello') s.write(snapshot());
	});
	hold(t.sessionDir, 'runner', '/definitely/not/here/evil.sock');
	await t.chat.run(['chat'], t.ctx);
	assert.deepEqual(frames.map(f => f.type), ['hello']);
	assert.equal(t.props.length, 1);
});

test('a runner lock without a socket entry is not attached to', async () => {
	const t = await setup();
	await startRunner(t.sessionDir, (s, f) => {
		if (f.type === 'hello') s.write(snapshot());
	});
	hold(t.sessionDir, 'runner');
	t.scripts.push(() => t.waits[0]!.onCancel());
	await t.chat.run(['chat'], t.ctx);
	assert.equal(t.props.length, 0);
	assert.equal(t.waits.length, 1);
});

test('a bye reason during the attach is scrubbed before it reaches the user', async () => {
	const t = await setup();
	await startRunner(t.sessionDir, (s, f) => {
		if (f.type === 'hello') s.write(encodeFrame({v: 1, type: 'bye', reason: `boom \u001b]0;title\u0007 ${TOKEN}`} as RunnerFrame));
	});
	hold(t.sessionDir, 'runner', runnerSocketPath(t.sessionDir));
	await assert.rejects(
		async () => t.chat.run(['chat'], t.ctx),
		(err: Error) => {
			assert.doesNotMatch(err.message, /\u001b|\u0007/);
			assert.equal(err.message.includes(TOKEN), false);
			assert.match(err.message, /boom/);
			return true;
		},
	);
});

test('attached elsewhere is turned into a hint that names claude stop', async () => {
	const t = await setup();
	await startRunner(t.sessionDir, (s, f) => {
		if (f.type === 'hello') s.write(encodeFrame({v: 1, type: 'bye', reason: 'attached elsewhere'} as RunnerFrame));
	});
	hold(t.sessionDir, 'runner', runnerSocketPath(t.sessionDir));
	await assert.rejects(async () => t.chat.run(['chat'], t.ctx), /claude stop/);
});

test('a bye in the middle of the chat prints a scrubbed notice', async () => {
	const t = await setup();
	await startRunner(t.sessionDir, (s, f) => {
		if (f.type !== 'hello') return;
		s.write(snapshot());
		setTimeout(() => s.write(encodeFrame({v: 1, type: 'bye', reason: `gone \u001b[31m${TOKEN}`} as RunnerFrame)), 20);
	});
	hold(t.sessionDir, 'runner', runnerSocketPath(t.sessionDir));
	t.scripts.push(close => void setTimeout(close, 150));
	await t.chat.run(['chat'], t.ctx);
	const notice = t.printed.find(p => p.includes('gone'));
	assert.ok(notice, t.printed.join('|'));
	assert.equal(notice.includes(TOKEN), false);
	assert.doesNotMatch(notice.replace(/\u001b\[[0-9;]*m/g, ''), /\u001b/);
});

test('a runner snapshot with escapes and a secret in the title never reaches the controller unscrubbed in the UI props', async () => {
	const t = await setup();
	await startRunner(t.sessionDir, (s, f) => {
		if (f.type === 'hello') s.write(snapshot({title: `T\u001b]52;c;AAAA\u0007 ${TOKEN}`, queued: ['q\u001b[2J']}));
	});
	hold(t.sessionDir, 'runner', runnerSocketPath(t.sessionDir));
	await t.chat.run(['chat'], t.ctx);
	const controller = t.props[0]!.controller;
	// The mirror keeps the raw value; the view scrubs it (ChatView `scrub(controller.title)`), so the scrub handed over must clean it.
	const scrub = t.props[0]!.scrub;
	const clean = scrub(controller.title ?? '');
	assert.doesNotMatch(clean, /\u001b|\u0007/);
	assert.equal(clean.includes(TOKEN), false);
});

test('ask is refused while a runner holds the lock', async () => {
	const t = await setup();
	hold(t.sessionDir, 'runner', runnerSocketPath(t.sessionDir));
	await assert.rejects(async () => t.chat.run(['ask', 'hi'], t.ctx), /A session is running/);
});

test('a lock with a recycled pid does not block a new chat', async () => {
	const t = await setup();
	writeFileSync(
		lockPath(t.sessionDir),
		JSON.stringify({v: 1, pid: process.pid, procStart: String(Number(procStart(process.pid)) + 1), kind: 'chat', where: 'runner', startedAt: 1, socket: '/x'}),
	);
	await t.chat.run(['chat'], t.ctx);
	assert.equal(t.props.length, 1);
	assert.equal(t.waits.length, 0);
});
