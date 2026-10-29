import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inspect} from 'node:util';
import {afterEach, test} from 'node:test';
import {writeAuth} from '../../src/accounts.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {RemoteChatSession} from '../../src/chat/remote-session.js';
import {loginSyncOf} from '../../src/credentials.js';
import {createLoginSync} from '../../src/login-sync.js';
import {createDecoder, encodeFrame, MAX_FRAME_BYTES, ProtocolError, validateFrame, type ClientFrame, type RunnerFrame} from '../../src/runner/protocol.js';
import {runRunner, type RunnerControl, type RunnerHandle, type RunnerSession} from '../../src/runner/server.js';
import {bundleVault, decodeBundle, encodeBundle, hostVault, makeEntry, type CredentialBundle, type WireBundle} from '../../src/vault.js';
import {fakeCredentials, seed} from '../helpers/fake-credentials.js';
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
		{name: 'alice', type: 'login', kind: 'oauth', email: 'a@example.com', disabled: false, slot: SLOT},
	],
	...over,
});
const frame = (bundle: unknown) => ({v: 1, type: 'credentials', bundle});

test('the credentials frame is validated: names, sizes, counts, slot shape', () => {
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
		wire({entries: [{...entry, type: 'login', slot: {credentials: 'x'} as never}]}),
		wire({entries: [{...entry, type: 'login', slot: {...SLOT, oauthAccount: {pad: 'p'.repeat(70_000)}} as never}]}),
	];
	for (const b of bad) assert.throws(() => validateFrame(frame(b), 'toRunner'), ProtocolError);
	assert.deepEqual(validateFrame({v: 1, type: 'loginChanged'}, 'toClient'), {v: 1, type: 'loginChanged'});
	assert.equal(validateFrame({v: 1, type: 'loginChanged'}, 'toRunner'), null, 'only the runner sends it');
	const huge = wire({entries: Array.from({length: 50}, (_, i) => ({name: `l${i}`, type: 'login' as const, kind: 'oauth' as const, disabled: false, slot: {...SLOT, oauthAccount: {pad: 'p'.repeat(60_000)}}}))});
	assert.throws(() => encodeFrame({v: 1, type: 'credentials', bundle: huge}), /too large/);
	assert.ok(MAX_FRAME_BYTES === 1024 * 1024);
});

test('a decoded bundle hides its values from JSON and inspect; encoding brings them back', () => {
	const b = decodeBundle(wire());
	for (const s of [JSON.stringify(b), inspect(b, {depth: 9}), inspect(b, {depth: 9, showHidden: true})]) {
		assert.ok(!s.includes(KEY) && !s.includes('RUNNER-ACCESS'), s);
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
	await assert.rejects(v.saveLogin('alice', SLOT), /Changing accounts needs yena/);
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
	r.control().loginChanged();
	await until(() => frames.some(f => f.type === 'loginChanged'), 'loginChanged');
	assert.ok(!raw.includes(KEY) && !raw.includes('RUNNER-ACCESS'), 'no value in snapshot, log or event frames');
	socket.destroy();
});

test('loginChanged makes the attached yena save the runner login and push a fresh bundle; the runner is clean again', async () => {
	const dataDir = mkdtempSync(path.join(tmpdir(), 'yrc-data-'));
	dirs.push(dataDir);
	const configDir = path.join(dataDir, 'config');
	mkdirSync(configDir, {recursive: true});
	const fake = fakeCredentials();
	seed(fake, 'alice', 'claude-login', JSON.stringify(SLOT));
	const log = makeFakeLog();
	const vault = hostVault(fake, log);
	await vault.load();
	writeAuth(dataDir, {v: 1, order: [], limits: {}, installed: 'alice'});
	const r = await startRunner();
	const remote = await RemoteChatSession.connect({
		socketPath: r.handle.socketPath,
		cwd: dataDir,
		stateUpdate: async () => undefined,
		open: {open: {fresh: true}, tuning: {}, keep: false},
		credentials: vault,
		onLoginChanged: () => void loginSyncOf({env: {}, dataDir, vault, log}).sync(),
	});
	await until(() => r.vault.current().entries.length === 1, 'first push');
	const refreshed = {...SLOT, credentials: {claudeAiOauth: {...SLOT.credentials.claudeAiOauth, accessToken: 'RUNNER-ACCESS-NEW-0123456789', expiresAt: 2000}}};
	writeFileSync(path.join(configDir, '.credentials.json'), JSON.stringify(refreshed.credentials));
	writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({oauthAccount: SLOT.oauthAccount}));
	const runnerSync = createLoginSync({dataDir, configDir, vault: r.vault});
	assert.equal(runnerSync.dirty(), true);
	await assert.rejects(r.vault.saveLogin('alice', refreshed), /needs yena/);
	r.control().loginChanged();
	await until(() => !runnerSync.dirty(), 'runner clean after the push');
	assert.equal(JSON.parse(fake.accounts.get('alice')!.secrets.login!).credentials.claudeAiOauth.accessToken, 'RUNNER-ACCESS-NEW-0123456789');
	remote.close();
});
