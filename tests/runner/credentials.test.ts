import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspect} from 'node:util';
import {afterEach, test} from 'node:test';
import type {ChatEvent} from '../../src/deps/chat.js';
import {createDecoder, encodeFrame, MAX_FRAME_BYTES, ProtocolError, validateFrame, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runRunner, type RunnerControl, type RunnerHandle, type RunnerSession} from '../../src/runner/server.js';
import {bundleVault, decodeBundle, encodeBundle, makeEntry, type CredentialBundle, type WireBundle} from '../../src/vault.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const KEY = 'sk-ant-api03-RUNNERKEY0123456789abcdef';
const SLOT = {credentials: {claudeAiOauth: {accessToken: 'RUNNER-ACCESS-0123456789', refreshToken: 'RUNNER-REFRESH-0123456789', expiresAt: 1000}}, oauthAccount: {emailAddress: 'a@example.com', accountUuid: 'uuid-a'}};
const tick = (ms = 10): Promise<void> => new Promise(r => setTimeout(r, ms));
const until = async (pred: () => boolean, what: string, ms = 3000): Promise<void> => {
	const t0 = Date.now();
	while (!pred()) {
		if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
		await tick(5);
	}
};

const wire = (over: Partial<WireBundle> = {}): WireBundle => ({
	status: 'ok',
	entries: [
		{name: 'key', type: 'key', kind: 'api-key', disabled: false, value: KEY},
		{name: 'other', type: 'key', kind: 'api-key', disabled: false, value: `${KEY}2`},
	],
	...over,
});
const frame = (bundle: unknown) => ({v: 1, type: 'credentials', bundle});

test('the credentials frame is validated: names, sizes, counts; only key entries without a slot', () => {
	const ok = validateFrame(frame(wire()), 'toRunner') as Extract<ClientFrame, {type: 'credentials'}>;
	assert.equal(ok.bundle.entries[0]!.value, KEY);
	const entry = wire().entries[0]!;
	const bad: unknown[] = [
		wire({status: 'maybe' as never}),
		wire({entries: Array.from({length: 51}, (_, i) => ({...entry, name: `k${i}`}))}),
		wire({entries: [{...entry, name: 'Bad Name'}]}),
		wire({entries: [{...entry, name: 'x'.repeat(33)}]}),
		wire({entries: [{...entry, value: 'v'.repeat(8193)}]}),
		wire({entries: [{...entry, type: 'github' as never}]}),
		wire({entries: [{...entry, type: 'token' as never}]}),
		wire({entries: [{...entry, type: 'login' as never}]}),
		wire({entries: [{...entry, slot: SLOT} as never]}),
		wire({entries: [{...entry, type: 'login', slot: {credentials: 'x'}} as never]}),
		wire({entries: [{...entry, slot: {}} as never]}),
	];
	for (const b of bad) assert.throws(() => validateFrame(frame(b), 'toRunner'), ProtocolError);
	assert.equal(validateFrame({v: 1, type: 'loginChanged'}, 'toClient'), null, 'an old runner loginChanged is ignored');
	assert.equal(validateFrame({v: 1, type: 'loginChanged'}, 'toRunner'), null);
	assert.ok(MAX_FRAME_BYTES === 1024 * 1024);
});

test('a decoded bundle hides its values from JSON and inspect; encoding brings them back', () => {
	const b = decodeBundle(wire());
	for (const s of [JSON.stringify(b), inspect(b, {depth: 9}), inspect(b, {depth: 9, showHidden: true})]) {
		assert.ok(!s.includes(KEY), s);
	}
	assert.equal(b.entries[0]!.value, KEY);
	assert.deepEqual(encodeBundle(b), wire());
	assert.equal(makeEntry({name: 'x', type: 'key', kind: 'api-key', disabled: false}).value, undefined);
});

test('the runner vault waits for the first push, then reads only; it never writes', async () => {
	const v = bundleVault(makeFakeLog(), 50);
	assert.equal((await v.load()).status, 'error', 'nothing pushed in time');
	const seen: CredentialBundle[] = [];
	v.onChange(b => seen.push(b));
	const pending = bundleVault(makeFakeLog(), 2000);
	setTimeout(() => pending.push(decodeBundle(wire())), 20);
	assert.equal((await pending.load()).entries.length, 2);
	v.push(decodeBundle(wire()));
	assert.equal(seen.length, 1);
	await assert.rejects(v.addSecret(undefined, KEY), /Changing accounts needs yena/);
	assert.ok(!('saveLogin' in v) && !('adoptLogin' in v));
});

class Session {
	state: 'idle' | 'running' | 'closed' = 'idle';
	sessionId = undefined;
	model = undefined;
	mode = 'default' as const;
	needsNewSession = false;
	title = undefined;
	pendingPermissions = [];
	tasks = [];
	plan = [];
	commands = [];
	rateLimit = undefined;
	costUsd = undefined;
	private cbs = new Set<(e: ChatEvent) => void>();
	subscribe = (cb: (e: ChatEvent) => void) => {
		this.cbs.add(cb);
		return () => void this.cbs.delete(cb);
	};
	send = (): void => undefined;
	steer = (): void => undefined;
	interrupt = async (): Promise<void> => undefined;
	setMode = (): void => undefined;
	answerPermission = (): boolean => true;
	reset = (): void => undefined;
	close = (): void => void (this.state = 'closed');
	forget = (): void => undefined;
	setTitle = (): void => undefined;
	stopTask = async (): Promise<void> => undefined;
	backgroundTasks = async (): Promise<boolean> => true;
	mcpStatus = async () => [];
	reconnectMcp = async (): Promise<void> => undefined;
	rewindFiles = async () => ({canRewind: false});
}

const dirs: string[] = [];
const handles: RunnerHandle[] = [];
afterEach(async () => {
	for (const h of handles.splice(0)) await h.stop('test').catch(() => undefined);
	for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const startRunner = async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'yrc-'));
	dirs.push(dir);
	const vault = bundleVault(makeFakeLog(), 2000);
	let control: RunnerControl | undefined;
	let bundleAtOpen: CredentialBundle | undefined;
	const handle = await runRunner({
		dir,
		store: {update: async () => undefined},
		onCredentials: b => vault.push(b),
		createEngine: async (_open, _io, log, ctl) => {
			control = ctl;
			bundleAtOpen = await vault.load();
			log.info('engine built', {entries: bundleAtOpen.entries.length});
			return {session: new Session() as unknown as RunnerSession, applyLive: () => undefined, close: () => undefined, flush: async () => undefined};
		},
	});
	handles.push(handle);
	return {dir, vault, handle, control: () => control!, bundleAtOpen: () => bundleAtOpen};
};

test('the runner gets the bundle before open, keeps the last one, and never sends a value back', async () => {
	const r = await startRunner();
	const socket = net.createConnection(r.handle.socketPath);
	await new Promise<void>(resolve => socket.once('connect', resolve));
	let raw = '';
	const frames: RunnerFrame[] = [];
	const dec = createDecoder('toClient');
	socket.on('data', c => {
		raw += c.toString();
		frames.push(...(dec.push(c) as RunnerFrame[]));
	});
	const send = (f: Record<string, unknown>) => socket.write(encodeFrame({v: 1, ...f} as ClientFrame));
	send({type: 'hello', role: 'attach'});
	send({type: 'credentials', bundle: wire()});
	send({type: 'open', open: {fresh: true}, tuning: {}, keep: false});
	await until(() => frames.some(f => f.type === 'snapshot'), 'snapshot');
	assert.equal(r.bundleAtOpen()?.entries.length, 2, 'the engine saw the pushed bundle');
	send({type: 'credentials', bundle: wire({entries: [wire().entries[0]!]})});
	await until(() => r.vault.current().entries.length === 1, 'second push');
	assert.ok(!raw.includes(KEY), 'no value in snapshot, log or event frames');
	socket.destroy();
});
