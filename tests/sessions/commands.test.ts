import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createClaude} from '../../src/commands.js';
import {serveControl} from '../../src/sessions/control.js';
import {acquireLock} from '../../src/sessions/lock.js';
import type {QueryFn} from '../../src/types.js';

test('running shows a held lock as unresponsive, then with status once the socket answers', async () => {
	const {provider, sessionDir} = makeProvider();
	const got = acquireLock({dir: sessionDir, kind: 'chat', where: 'runner'});
	assert.ok(got.ok);
	const first = (await provider.running()).sessions[0]!;
	assert.equal(first.where, 'background');
	assert.equal(first.state, undefined);
	const server = await serveControl({
		dir: sessionDir,
		handlers: {
			status: () => ({kind: 'chat', where: 'runner', state: 'waiting-permission', title: 'Fix it', sessionId8: 'abcdef01', startedAt: 1, pending: 1, queued: 0, attached: false}),
			stop: () => {},
		},
	});
	const second = (await provider.running()).sessions[0]!;
	assert.equal(second.state, 'waiting-permission');
	assert.equal(second.title, 'Fix it');
	assert.equal(second.session8, 'abcdef01');
	await server.close();
	got.lock.release();
});

test('ask refuses while another process holds the lock, and stop validates the session argument', async () => {
	const {provider, sessionDir} = makeProvider();
	const got = acquireLock({dir: sessionDir, kind: 'chat', where: 'runner', sessionId: '11111111-aaaa-4bbb-8ccc-222222222222'});
	assert.ok(got.ok);
	await assert.rejects(provider.ask({origin: 'user', text: 'hi', fresh: false}, {print: () => {}}), /A session is running \(chat 11111111 since \d\d:\d\d\)\. Wait for it or run "chat stop"\./);
	await assert.rejects(provider.stop('ffff'), /No running session matches "ffff"\. Usage: chat stop \[session\]/);
	got.lock.release();
});

test('an ask holds the lock while it runs and releases it afterwards', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'session-ask-'));
	const dataDir = mkdtempSync(join(tmpdir(), 'session-data-'));
	let during: boolean | undefined;
	const {provider} = createClaude({
		dataDir,
		env: {ANTHROPIC_API_KEY: 'sk-ant-api03-TESTVALUE0123456789abcdef'},
		login: {probe: async () => undefined},
		sessionDir: () => dir,
		loadQuery: async () =>
			(() =>
				(async function* () {
					during = !acquireLock({dir, kind: 'ask', where: 'local', pid: process.pid}).ok;
					yield {type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: '11111111-aaaa-4bbb-8ccc-222222222222'};
				})()) as unknown as QueryFn,
	});
	await provider.ask({origin: 'user', text: 'hi', fresh: false}, {print: () => {}});
	assert.equal(during, true);
	assert.ok(acquireLock({dir, kind: 'ask', where: 'local'}).ok);
});

const makeProvider = (withDir = true) => {
	const sessionDir = mkdtempSync(join(tmpdir(), 'session-prov-'));
	const dataDir = mkdtempSync(join(tmpdir(), 'session-data-'));
	const {provider} = createClaude({
		dataDir,
		env: {ANTHROPIC_API_KEY: 'sk-ant-api03-TESTVALUE0123456789abcdef'},
		loadQuery: async () => (() => (async function* () {})()) as unknown as QueryFn,
		login: {probe: async () => undefined},
		...(withDir && {sessionDir: () => sessionDir}),
	});
	return {provider, sessionDir};
};

test('the provider reports running and stop as data when no lock is held, and refuses without a run directory', async () => {
	const {provider} = makeProvider();
	assert.deepEqual(await provider.running(), {sessions: [], starting: false});
	assert.equal(await provider.stop(), undefined);
	const bare = makeProvider(false).provider;
	await assert.rejects(bare.running(), {message: 'Session control is not available (no private run directory)'});
	await assert.rejects(bare.stop(), {message: 'Session control is not available (no private run directory)'});
});

test('the provider returns the running session as data and validates the stop argument', async () => {
	const {provider, sessionDir} = makeProvider();
	const got = acquireLock({dir: sessionDir, kind: 'chat', where: 'runner', sessionId: '11111111-aaaa-4bbb-8ccc-222222222222'});
	assert.ok(got.ok);
	const server = await serveControl({
		dir: sessionDir,
		handlers: {
			status: () => ({kind: 'chat', where: 'runner', state: 'waiting-permission', title: 'Fix it', sessionId8: 'abcdef01', startedAt: 1, pending: 1, queued: 2, attached: false}),
			stop: () => {},
		},
	});
	const {sessions, starting} = await provider.running();
	assert.equal(starting, false);
	assert.deepEqual(sessions.map(({pid, startedAt, ...rest}) => ({...rest, pid: typeof pid, startedAt: typeof startedAt})), [
		{kind: 'chat', where: 'background', state: 'waiting-permission', title: 'Fix it', session8: 'abcdef01', pid: 'number', startedAt: 'number', pending: 1, queued: 2, attached: false},
	]);
	await assert.rejects(provider.stop('ffff'), /No running session matches "ffff"/);
	await server.close();
	got.lock.release();
});
