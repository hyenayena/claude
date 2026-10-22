import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {CommandContext} from '../../../../src/api.js';
import {createClaudeCommand} from '../../src/commands.js';
import {serveControl} from '../../src/sessions/control.js';
import {acquireLock} from '../../src/sessions/lock.js';
import type {QueryFn} from '../../src/types.js';

const make = () => {
	const sessionDir = mkdtempSync(join(tmpdir(), 'session-cmd-'));
	const dataDir = mkdtempSync(join(tmpdir(), 'session-data-'));
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	const command = createClaudeCommand({
		dataDir,
		env: {ANTHROPIC_API_KEY: 'sk-ant-api03-TESTVALUE0123456789abcdef'},
		loadQuery: async () => (() => (async function* () {})()) as unknown as QueryFn,
		login: {probe: async () => undefined},
		sessionDir: () => sessionDir,
	});
	return {command, sessionDir, printed, ctx};
};

test('policies: sessions is safe, stop needs confirmation', () => {
	const {command} = make();
	const by = (n: string) => command.subcommands?.find(s => s.name === n);
	assert.equal(by('sessions')?.agent, 'safe');
	assert.equal(by('stop')?.agent, 'confirm');
});

test('sessions and stop report no session when the lock is free', async () => {
	const {command, printed, ctx} = make();
	await command.run(['sessions'], ctx);
	await command.run(['stop'], ctx);
	assert.deepEqual(printed, ['No session is running.', 'No session is running.']);
});

test('sessions shows a held lock as unresponsive, then with status once the socket answers', async () => {
	const {command, sessionDir, printed, ctx} = make();
	const got = acquireLock({dir: sessionDir, kind: 'chat', where: 'runner'});
	assert.ok(got.ok);
	await command.run(['sessions'], ctx);
	assert.match(printed[0]!, /^chat \(background\) · unresponsive · since \d\d:\d\d · pid \d+$/);
	const server = await serveControl({
		dir: sessionDir,
		handlers: {
			status: () => ({kind: 'chat', where: 'runner', state: 'waiting-permission', title: 'Fix it', sessionId8: 'abcdef01', startedAt: 1, pending: 1, queued: 0, attached: false}),
			stop: () => {},
		},
	});
	await command.run(['sessions'], ctx);
	assert.match(printed[1]!, /waiting-permission · "Fix it" · session abcdef01 .* · 1 permission waiting · detached$/);
	await server.close();
	got.lock.release();
});

test('ask refuses while another process holds the lock, and stop validates the session argument', async () => {
	const {command, sessionDir, ctx} = make();
	const got = acquireLock({dir: sessionDir, kind: 'chat', where: 'runner', sessionId: '11111111-aaaa-4bbb-8ccc-222222222222'});
	assert.ok(got.ok);
	await assert.rejects(async () => command.run(['ask', 'hi'], ctx), /A session is running \(chat 11111111 since \d\d:\d\d\)\. Wait for it or run "claude stop"\./);
	await assert.rejects(async () => command.run(['stop', 'ffff'], ctx), /No running session matches "ffff"/);
	await assert.rejects(async () => command.run(['stop', 'a', 'b'], ctx), /Usage: claude stop/);
	got.lock.release();
});

test('an ask holds the lock while it runs and releases it afterwards', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'session-ask-'));
	const dataDir = mkdtempSync(join(tmpdir(), 'session-data-'));
	let during: boolean | undefined;
	const command = createClaudeCommand({
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
	const ctx: CommandContext = {print: () => {}, clear: () => {}, exit: () => {}};
	await command.run(['ask', 'hi'], ctx);
	assert.equal(during, true);
	assert.ok(acquireLock({dir, kind: 'ask', where: 'local'}).ok);
});
