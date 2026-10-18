import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import plugin from '../src/index.js';
import {makeFakeLog} from './helpers/fake-log.js';

const setup = async () => {
	const commands = await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log: makeFakeLog()});
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	return {command: commands[0]!, commands, printed, ctx};
};

test('plugin returns exactly one command named claude', async () => {
	const {commands} = await setup();
	assert.equal(commands.length, 1);
	assert.equal(commands[0]!.name, 'claude');
});

test('ping prints pong', async () => {
	const {command, printed, ctx} = await setup();
	await command.run(['ping'], ctx);
	assert.deepEqual(printed, ['pong']);
});

test('no subcommand throws the usage error', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run([], ctx), {message: 'Usage: claude <ping|ask|chat|new|session|auth>'});
});

test('unknown subcommand throws', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['nope'], ctx), {
		message: 'Unknown subcommand "nope". Usage: claude <ping|ask|chat|new|session|auth>',
	});
});

test('a host without log falls back to a noop logger', async () => {
	const host = {dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}} as unknown as Parameters<typeof plugin>[0];
	const commands = await plugin(host);
	const printed: string[] = [];
	await commands[0]!.run(['ping'], {print: t => printed.push(t), clear: () => {}, exit: () => {}});
	assert.deepEqual(printed, ['pong']);
});

test('plugin load logs info', async () => {
	const log = makeFakeLog();
	await plugin({dataDir: '/tmp/claude-test', events: {emit: () => {}, on: () => () => {}}, log});
	assert.deepEqual(log.records.map(r => [r.level, r.msg]), [['info', 'plugin loaded']]);
});
