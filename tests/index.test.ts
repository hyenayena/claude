import assert from 'node:assert/strict';
import {after, test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import {chatProvider, chatProviders} from '../src/deps/chat.js';
import plugin, {releaseProvider} from '../src/index.js';
import {makeFakeLog} from './helpers/fake-log.js';

const setup = async () => {
	const commands = await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: makeFakeLog()});
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	return {command: commands.find(c => c.name === 'claude')!, commands, printed, ctx};
};

test('plugin returns only the claude command, with the Claude settings tab', async () => {
	const {commands} = await setup();
	assert.deepEqual(
		commands.map(c => c.name),
		['claude'],
	);
	assert.equal(commands[0]!.settings?.title, 'Claude');
});

test('ping prints pong', async () => {
	const {command, printed, ctx} = await setup();
	await command.run(['ping'], ctx);
	assert.deepEqual(printed, ['pong']);
});

test('no subcommand shows core help, or throws the usage error without it', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run([], ctx), {
		message: 'Usage: claude <ping|memory|code|tier|auth|help>',
	});
	const paths: (string[] | undefined)[] = [];
	await command.run([], {...ctx, showHelp: path => paths.push(path)});
	await command.run(['auth'], {...ctx, showHelp: path => paths.push(path)});
	assert.deepEqual(paths, [undefined, ['auth']]);
	await assert.rejects(async () => command.run(['auth'], ctx), {message: 'Usage: claude auth <status|login|add|order|use|auto|remove|logout>'});
});

test('claude declares no help subcommand of its own', async () => {
	const {command} = await setup();
	assert.equal(command.subcommands!.some(s => s.name === 'help'), false);
});

test('an unknown subcommand is an error that does not echo control bytes', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['nope'], ctx), {message: 'Unknown subcommand "nope". See "claude help"'});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /Unknown subcommand "ask"/);
	await assert.rejects(async () => command.run(['bad\u001bname'], ctx), (err: Error) => /^Unknown subcommand "/.test(err.message) && !err.message.includes("\u001b"));
});

test('a host without log falls back to a noop logger', async () => {
	const host = {dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}} as unknown as Parameters<typeof plugin>[0];
	const commands = await plugin(host);
	const printed: string[] = [];
	await commands.find(c => c.name === 'claude')!.run(['ping'], {print: t => printed.push(t), clear: () => {}, exit: () => {}});
	assert.deepEqual(printed, ['pong']);
});

test('plugin load logs at debug', async () => {
	const log = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log});
	assert.deepEqual(log.records.filter(r => r.level === 'debug').map(r => [r.level, r.msg]), [['debug', 'plugin loaded']]);
});

after(() => releaseProvider());

test('the plugin registers the claude chat provider once; a second registration is refused and logged', async () => {
	releaseProvider();
	const first = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: first});
	assert.equal(chatProvider('claude')?.label, 'Claude Code');
	assert.deepEqual(chatProviders().filter(p => p.id === 'claude'), [{id: 'claude', label: 'Claude Code'}]);
	assert.deepEqual(first.records.filter(r => r.msg === 'chat provider not registered'), []);
	const registered = chatProvider('claude');
	const second = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: second});
	assert.deepEqual(second.records.filter(r => r.level === 'warn').map(r => r.msg), ['chat provider not registered']);
	assert.equal(chatProvider('claude'), registered, 'the first registration stays');
});

test('releaseProvider removes the registration this module made', async () => {
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: makeFakeLog()});
	releaseProvider();
	assert.equal(chatProvider('claude'), undefined);
	const log = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log});
	assert.deepEqual(log.records.filter(r => r.level === 'warn'), []);
	assert.ok(chatProvider('claude'));
});
