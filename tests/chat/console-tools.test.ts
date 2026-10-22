import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import type {CommandBridge, CommandInfo, CommandRunRequest, CommandRunResult} from '../../../../src/api.js';
import {CONSOLE_MCP_TIMEOUT_MS, CONSOLE_SERVER_NAME, CONSOLE_TIMEOUT_MS, createConsoleServer, type ConsoleSdk} from '../../src/chat/console-tools.js';
import type {PermissionDecision, PermissionPrompter, PermissionRequest} from '../../src/chat/permission.js';
import {noopLog} from '../../src/log.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{content: {text: string}[]; isError?: boolean}>;
type Def = {name: string; description: string; handler: Handler; annotations?: Record<string, unknown>};

const sdk: ConsoleSdk = {
	tool: ((name: string, description: string, _schema: unknown, handler: Handler, extras?: {annotations?: Record<string, unknown>}) => ({
		name,
		description,
		handler,
		annotations: extras?.annotations,
	})) as never,
	createSdkMcpServer: ((o: {name: string; tools: Def[]; timeout?: number}) => ({type: 'sdk', name: o.name, tools: o.tools, timeout: o.timeout})) as never,
	z,
};

const info: CommandInfo[] = [
	{
		name: 'mod',
		description: 'Manage modules',
		usage: 'mod <cmd>',
		policy: 'confirm',
		subcommands: [{name: 'list', aliases: ['ls'], usage: 'mod list', description: 'List', policy: 'safe'}],
	},
];

class FakePrompter implements PermissionPrompter {
	mode = 'default' as const;
	requests: PermissionRequest[] = [];
	decision: PermissionDecision = {kind: 'allow'};
	throws = false;
	request(req: PermissionRequest): Promise<PermissionDecision> {
		this.requests.push(req);
		return this.throws ? Promise.reject(new Error('x')) : Promise.resolve(this.decision);
	}
	hasApproved = () => false;
	remember = () => {};
	audit = () => {};
}

const setup = (run: (req: CommandRunRequest) => Promise<CommandRunResult>, redact = (s: string) => s) => {
	const prompter = new FakePrompter();
	const bridge: CommandBridge = {list: () => info, run};
	const server = createConsoleServer({bridge, sdk, prompter, redact, cwd: '/app', log: noopLog}) as unknown as {
		name: string;
		tools: Def[];
	};
	const byName = (n: string) => server.tools.find(t => t.name === n)!;
	return {server, prompter, list: byName('list_commands'), runTool: byName('run_command')};
};

const ok = (output: string): CommandRunResult => ({status: 'ok', output, truncated: false, ms: 1});

test('the server is named yena with a read-only list tool and a destructive run tool', () => {
	const {server, list, runTool} = setup(async () => ok(''));
	assert.equal(server.name, CONSOLE_SERVER_NAME);
	assert.deepEqual(list.annotations, {readOnlyHint: true});
	assert.deepEqual(runTool.annotations, {destructiveHint: true});
	assert.ok(list.description.length > 0 && runTool.description.length > 0);
});

test('list_commands formats the bridge list', async () => {
	const {list} = setup(async () => ok(''));
	const r = await list.handler({}, {});
	assert.equal(r.isError, undefined);
	assert.ok(r.content[0]!.text.includes('mod <cmd> [confirm]'));
	assert.ok(r.content[0]!.text.includes('mod list (ls) [safe]'));
});

test('run_command passes the line, the caller and the signal', async () => {
	let seen: CommandRunRequest | undefined;
	const {runTool} = setup(async req => {
		seen = req;
		return ok('done');
	});
	const ac = new AbortController();
	const r = await runTool.handler({command: '  mod list '}, {signal: ac.signal});
	assert.equal(seen?.line, 'mod list');
	assert.equal(seen?.caller, 'claude');
	assert.equal(seen?.signal, ac.signal);
	assert.equal(r.content[0]!.text, 'done');
	assert.equal(r.isError, undefined);
});

test('confirm maps allow to true and deny, cancel and a throwing request to false', async () => {
	let confirm: CommandRunRequest['confirm'];
	const {runTool, prompter} = setup(async req => {
		confirm = req.confirm;
		return ok('');
	});
	await runTool.handler({command: 'mod remove x'}, {});
	const creq = {line: 'mod remove x', command: 'mod', caller: 'claude'};
	assert.equal(await confirm!(creq), true);
	const sent = prompter.requests[0] as unknown as {toolName: string; input: {command: string}; always: unknown};
	assert.equal(sent.toolName, 'Command');
	assert.equal(sent.input.command, 'mod remove x');
	assert.equal(sent.always, false);
	prompter.decision = {kind: 'deny'};
	assert.equal(await confirm!(creq), false);
	prompter.decision = {kind: 'cancel', cause: 'aborted'};
	assert.equal(await confirm!(creq), false);
	prompter.throws = true;
	assert.equal(await confirm!(creq), false);
});

test('output is scrubbed and redacted', async () => {
	const {runTool} = setup(
		async () => ok('key sk-ant-api03-SECRETSECRETSECRET \x1b]52;c;QUJD\x07 end'),
		s => s.replace(/sk-ant-\S+/g, '[redacted]'),
	);
	const text = (await runTool.handler({command: 'x'}, {})).content[0]!.text;
	assert.equal(text.includes('sk-ant'), false);
	assert.equal(/\x1b|\x07/.test(text), false);
	assert.ok(text.includes('end'));
});

test('non-ok statuses and failures are tool errors', async () => {
	const {runTool} = setup(async () => ({status: 'declined', output: '', truncated: false, ms: 1}));
	const r = await runTool.handler({command: 'mod remove x'}, {});
	assert.equal(r.isError, true);
	assert.ok(r.content[0]!.text.includes('declined'));
	const thrown = setup(async () => {
		throw new Error('secret detail');
	});
	const t = await thrown.runTool.handler({command: 'x'}, {});
	assert.equal(t.isError, true);
	assert.equal(t.content[0]!.text.includes('secret detail'), false);
	const empty = await runTool.handler({command: '   '}, {});
	assert.equal(empty.isError, true);
});

test('log records carry metadata only: no command line, output or error text', async () => {
	const records: {msg: string; data: unknown}[] = [];
	const rec = (msg: string, data?: unknown) => void records.push({msg, data});
	const log = {error: rec, warn: rec, info: rec, debug: rec, child: () => log, addRedactor: () => {}} as never;
	const make = (run: () => Promise<CommandRunResult>) => {
		const bridge: CommandBridge = {list: () => info, run};
		const server = createConsoleServer({bridge, sdk, prompter: new FakePrompter(), redact: s => s, cwd: '/app', log}) as unknown as {tools: Def[]};
		return server.tools.find(t => t.name === 'run_command')!;
	};
	await make(async () => ok('SECRET-OUTPUT')).handler({command: 'mod install SECRET-LINE'}, {});
	await make(async () => {
		throw new Error('SECRET-ERROR-TEXT');
	}).handler({command: 'mod install SECRET-LINE'}, {});
	assert.ok(records.length >= 2);
	const dump = JSON.stringify(records);
	for (const secret of ['SECRET-LINE', 'SECRET-OUTPUT', 'SECRET-ERROR-TEXT']) assert.equal(dump.includes(secret), false, secret);
});

test('run_command passes the global bridge timeout and the server gets a longer MCP timeout', async () => {
	let seen: CommandRunRequest | undefined;
	const {server, runTool} = setup(async req => {
		seen = req;
		return ok('');
	});
	await runTool.handler({command: 'x'}, {});
	assert.equal(seen?.timeoutMs, CONSOLE_TIMEOUT_MS);
	assert.equal(CONSOLE_TIMEOUT_MS, 600_000);
	assert.equal((server as unknown as {timeout?: number}).timeout, CONSOLE_MCP_TIMEOUT_MS);
	assert.ok(CONSOLE_MCP_TIMEOUT_MS > CONSOLE_TIMEOUT_MS);
});

test('holdTurn is taken before the run and released after it, also when the bridge throws', async () => {
	const events: string[] = [];
	const make = (run: () => Promise<CommandRunResult>) => {
		const bridge: CommandBridge = {list: () => info, run};
		const server = createConsoleServer({
			bridge,
			sdk,
			prompter: new FakePrompter(),
			redact: s => s,
			cwd: '/app',
			log: noopLog,
			holdTurn: () => {
				events.push('hold');
				return () => events.push('release');
			},
		}) as unknown as {tools: Def[]};
		return server.tools.find(t => t.name === 'run_command')!;
	};
	await make(async () => {
		events.push('run');
		return ok('');
	}).handler({command: 'x'}, {});
	assert.deepEqual(events, ['hold', 'run', 'release']);
	events.length = 0;
	await make(async () => {
		throw new Error('boom');
	}).handler({command: 'x'}, {});
	assert.deepEqual(events, ['hold', 'release']);
	events.length = 0;
	await make(async () => ok('')).handler({command: '  '}, {});
	assert.deepEqual(events, []);
});
