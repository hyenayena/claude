import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import plugin from '../src/index.js';
import {makeFakeLog} from './helpers/fake-log.js';

const setup = async () => {
	const commands = await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: makeFakeLog()});
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	return {command: commands.find(c => c.name === 'claude')!, commands, printed, ctx};
};

test('plugin returns the autostarted chat command, the claude command and fix', async () => {
	const {commands} = await setup();
	assert.deepEqual(
		commands.map(c => c.name),
		['chat', 'claude', 'fix'],
	);
	assert.equal(commands[0]!.autostart, true);
	assert.equal(commands[0]!.settings?.title, 'Chat');
});

test('ping prints pong', async () => {
	const {command, printed, ctx} = await setup();
	await command.run(['ping'], ctx);
	assert.deepEqual(printed, ['pong']);
});

test('no subcommand shows core help, or throws the usage error without it', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run([], ctx), {
		message: 'Usage: claude <ping|ask|chat|new|start|resume|rewind|fork|rename|export|copy|memory|code|tasks|mcp|session|sessions|stop|auth|help|<Claude Code command>>',
	});
	const paths: (string[] | undefined)[] = [];
	await command.run([], {...ctx, showHelp: path => paths.push(path)});
	await command.run(['auth'], {...ctx, showHelp: path => paths.push(path)});
	assert.deepEqual(paths, [undefined, ['auth']]);
	await assert.rejects(async () => command.run(['auth'], ctx), {message: 'Usage: claude auth <status|login|add|order|use|remove|logout>'});
});

test('claude declares no help subcommand of its own', async () => {
	const {command} = await setup();
	assert.equal(command.subcommands!.some(s => s.name === 'help'), false);
});

test('an unknown subcommand is a Claude Code command and needs an open chat', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['nope'], ctx), {
		message: 'No chat is open. Claude Code commands run in the open chat; start one with "chat".',
	});
	await assert.rejects(async () => command.run(['bad\u001bname'], ctx), /Unknown subcommand/);
});

test('a host without log falls back to a noop logger', async () => {
	const host = {dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}} as unknown as Parameters<typeof plugin>[0];
	const commands = await plugin(host);
	const printed: string[] = [];
	await commands.find(c => c.name === 'claude')!.run(['ping'], {print: t => printed.push(t), clear: () => {}, exit: () => {}});
	assert.deepEqual(printed, ['pong']);
});

test('plugin load logs info', async () => {
	const log = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log});
	assert.deepEqual(log.records.map(r => [r.level, r.msg]), [['info', 'plugin loaded']]);
});
