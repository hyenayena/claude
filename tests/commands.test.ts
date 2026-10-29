import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import {storeSecret} from '../src/credentials.js';
import {CONTINUE_TEXT} from '../src/chat/chat-session.js';
import {createClaudeCommand, createClaudeCommands, type ClaudeDeps} from '../src/commands.js';
import {checkCommandDocs} from '../src/kit.js';
import type {LoginStatus} from '../src/claude-login.js';
import type {QueryFn} from '../src/types.js';
import {TurnFailure} from '../src/session.js';
import {makeFakeLog, serialized} from './helpers/fake-log.js';

const KEY = 'sk-ant-api03-TESTVALUE0123456789abcdef';
const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const SID1 = '11111111-aaaa-4bbb-8ccc-222222222222';
const SID2 = '33333333-aaaa-4bbb-8ccc-444444444444';

type Call = {prompt: string; options: Record<string, unknown>};

const makeQuery = (script: (call: Call, n: number) => Record<string, unknown>[] | Error, gate?: Promise<void>) => {
	const calls: Call[] = [];
	let closed = 0;
	const query = ((arg: Call) => {
		calls.push(arg);
		const n = calls.length;
		const gen = (async function* () {
			if (gate) await gate;
			const out = script(arg, n);
			if (out instanceof Error) throw out;
			for (const m of out) yield m;
		})();
		return Object.assign(gen, {close: () => void closed++});
	}) as unknown as QueryFn;
	return {query, calls, closed: () => closed};
};

const okMsgs = (sid: string, text: string) => [
	{type: 'system', subtype: 'init', session_id: sid, model: 'claude-test-1', apiKeySource: 'x'},
	{type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid},
];

const setup = async (over: Partial<ClaudeDeps> & {env?: NodeJS.ProcessEnv} = {}) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-cmd-'));
	const printed: string[] = [];
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	const q = makeQuery(() => okMsgs(SID1, 'answer'));
	const command = createClaudeCommand({
		dataDir,
		env: {ANTHROPIC_API_KEY: KEY},
		loadQuery: async () => q.query,
		login: {probe: async () => undefined},
		...over,
	});
	return {command, dataDir, printed, ctx, q};
};

const state = async (dir: string) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;

test('ask joins args with spaces and keeps quotes literal', async () => {
	const {command, ctx, q} = await setup();
	await command.run(['ask', 'say', '"a', 'b"'], ctx);
	assert.equal(q.calls[0]!.prompt, 'say "a b"');
});

test('ask prints progress, answer and footer without secrets', async () => {
	const {command, ctx, printed} = await setup();
	await command.run(['ask', 'hi'], ctx);
	assert.deepEqual(printed, ['Asking yena…', 'answer', '[session 11111111 · model claude-test-1 · API key]']);
	assert.ok(!printed.join('\n').includes(KEY));
});

test('ask continues the stored session; --new starts fresh', async () => {
	const {command, ctx, q, dataDir} = await setup();
	await command.run(['ask', 'one'], ctx);
	assert.equal(q.calls[0]!.options.resume, undefined);
	assert.equal((await state(dataDir)).lastSessionId, SID1);
	await command.run(['ask', 'two'], ctx);
	assert.equal(q.calls[1]!.options.resume, SID1);
	await command.run(['ask', '--new', 'three'], ctx);
	assert.equal(q.calls[2]!.options.resume, undefined);
});

test('-- ends flag parsing', async () => {
	const {command, ctx, q} = await setup();
	await command.run(['ask', '--', '--new', 'x'], ctx);
	assert.equal(q.calls[0]!.prompt, '--new x');
	await assert.rejects(async () => command.run(['ask', '--bogus', 'x'], ctx), /Unknown option "--bogus"/);
});

test('missing text and slash commands are refused', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['ask'], ctx), {message: 'Usage: claude ask [--new] <text…>'});
	await assert.rejects(async () => command.run(['ask', '--new'], ctx), {message: 'Usage: claude ask [--new] <text…>'});
	await assert.rejects(async () => command.run(['ask', '/help'], ctx), {
		message: 'Slash commands are not supported in "claude ask"',
	});
});

test('a second concurrent ask is rejected', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const q = makeQuery(() => okMsgs(SID1, 'a'), gate);
	const {command, ctx} = await setup({loadQuery: async () => q.query});
	const first = command.run(['ask', 'one'], ctx);
	await new Promise(r => setTimeout(r, 20));
	await assert.rejects(async () => command.run(['ask', 'two'], ctx), {message: 'An ask is already running'});
	release();
	await first;
	await command.run(['ask', 'three'], ctx);
});

test('session id is not stored after a failure', async () => {
	const q = makeQuery(() => new Error('kaboom'));
	const {command, ctx, dataDir} = await setup({loadQuery: async () => q.query});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), {message: 'Claude request failed: kaboom'});
	await assert.rejects(readFile(join(dataDir, 'state.json'), 'utf8'));
	assert.equal(q.closed(), 1);
});

const failedMsgs = (sid: string, error: string) => [
	{type: 'system', subtype: 'init', session_id: sid, model: 'claude-test-1', apiKeySource: 'x'},
	{type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error], session_id: sid},
];

test('a failed turn that created a session still persists it and rethrows the failure', async () => {
	const {command, ctx, dataDir} = await setup({loadQuery: async () => makeQuery(() => failedMsgs(SID1, 'Usage limit reached')).query});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /Usage limit reached/);
	const st = await state(dataDir);
	assert.equal(st.lastSessionId, SID1);
	assert.equal(st.lastModel, 'claude-test-1');
});

test('a resume failure does not persist a session', async () => {
	const {command, ctx, dataDir} = await setup({
		loadQuery: async () => makeQuery(() => failedMsgs(SID1, 'No conversation found with session ID: x')).query,
	});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /no longer exists/);
	await assert.rejects(readFile(join(dataDir, 'state.json'), 'utf8'));
});

test('request errors are redacted', async () => {
	const q = makeQuery(() => new Error(`leak ${KEY}`));
	const {command, ctx} = await setup({loadQuery: async () => q.query});
	await assert.rejects(
		async () => command.run(['ask', 'x'], ctx),
		(e: Error) => !e.message.includes(KEY) && e.message.startsWith('Claude request failed'),
	);
});

test('child env carries the credential through options, not state', async () => {
	const {command, ctx, q, dataDir} = await setup();
	await command.run(['ask', 'x'], ctx);
	const env = q.calls[0]!.options.env as Record<string, string>;
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	assert.ok(!(await readFile(join(dataDir, 'state.json'), 'utf8')).includes(KEY));
});

test('missing credential makes ask throw the exact error', async () => {
	const {command, ctx} = await setup({env: {}});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), {
		message:
			'No credentials found. Run "claude auth login" to sign in through the browser, or "claude auth add" to paste an API key or a subscription token. See "claude auth status".',
	});
});

test('missing SDK gives the install hint', async () => {
	const {command, ctx} = await setup({
		loadQuery: async () => {
			throw Object.assign(new Error('Cannot find package'), {code: 'ERR_MODULE_NOT_FOUND'});
		},
	});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), {
		message: 'The Claude Agent SDK is not installed. Run modules/claude/bin/install.',
	});
});

test('timeout aborts the turn and closes the query', async () => {
	let closeCalled = false;
	let release!: () => void;
	const hang = (() => ({
		[Symbol.asyncIterator]: () => ({
			next: () => new Promise<IteratorResult<never>>(resolve => (release = () => resolve({done: true, value: undefined}))),
		}),
		close: () => {
			closeCalled = true;
			release();
		},
	})) as unknown as QueryFn;
	const {command, ctx} = await setup({loadQuery: async () => hang, timeoutMs: 30});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /Request timed out after/);
	assert.ok(closeCalled);
});

test('registerAbort controller is registered and released', async () => {
	const seen: AbortController[] = [];
	let released = 0;
	const {command, ctx} = await setup({
		registerAbort: c => {
			seen.push(c);
			return () => void released++;
		},
	});
	await command.run(['ask', 'x'], ctx);
	assert.equal(seen.length, 1);
	assert.equal(released, 1);
});

test('subscription notice is shown once across status and ask', async () => {
	const {command, ctx, printed} = await setup({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}});
	await command.run(['ask', 'x'], ctx);
	assert.equal(printed.filter(l => l.startsWith('Notice:')).length, 1);
	assert.equal(printed.at(-1), '[session 11111111 · model claude-test-1 · subscription token]');
	await command.run(['auth', 'status'], ctx);
	assert.equal(printed.filter(l => l.startsWith('Notice:')).length, 1);
	assert.ok(!printed.join('\n').includes(OAUTH));
});

test('no notice for API keys', async () => {
	const {command, ctx, printed} = await setup();
	await command.run(['auth', 'status'], ctx);
	assert.ok(!printed.some(l => l.startsWith('Notice:')));
	assert.equal(printed[0], 'Active credential: API key (from environment)');
});

test('new clears the session; session prints id and model', async () => {
	const {command, ctx, printed, dataDir} = await setup();
	await command.run(['session'], ctx);
	assert.equal(printed[0], 'Session: (none)');
	assert.equal(printed[1], 'Model: (unknown)');
	await command.run(['ask', 'x'], ctx);
	printed.length = 0;
	await command.run(['session'], ctx);
	assert.equal(printed[0], `Session: ${SID1}`);
	assert.equal(printed[1], 'Model: claude-test-1');
	void dataDir;
});

test('auth status warns on a world-readable accounts.json and reports no secret', async () => {
	const {command, ctx, printed, dataDir} = await setup({env: {}});
	await storeSecret(dataDir, OAUTH);
	await chmod(join(dataDir, 'accounts.json'), 0o644);
	await command.run(['auth', 'status'], ctx);
	const out = printed.join('\n');
	assert.match(out, /account "token": subscription token \(stored by yena\)/);
	assert.match(out, /Warning: accounts\.json is readable by other users/);
	assert.ok(!out.includes(OAUTH));
});

test('auth status without credentials prints the missing message', async () => {
	const {command, ctx, printed} = await setup({env: {}});
	await command.run(['auth', 'status'], ctx);
	assert.match(printed[0]!, /^No credentials found/);
});

const ACCOUNTS_HEAD = 'Accounts, in priority order (▸ is used next; when it reaches its limit, the next one takes over):';

test('auth status lists the accounts in priority order, by name only', async () => {
	const {command, ctx, printed, dataDir} = await setup();
	await command.run(['auth', 'status'], ctx);
	assert.deepEqual(printed.slice(1, 3), [ACCOUNTS_HEAD, printed[2]]);
	assert.match(printed[2]!, /^▸ 1\. env-key +ANTHROPIC_API_KEY \(environment variable\)$/);
	await storeSecret(dataDir, OAUTH);
	printed.length = 0;
	await command.run(['auth', 'status'], ctx);
	assert.equal(printed[0], 'Active credential: API key (from environment)');
	assert.equal(printed[1], ACCOUNTS_HEAD);
	assert.match(printed[2]!, /^▸ 1\. env-key +ANTHROPIC_API_KEY \(environment variable\)$/);
	assert.match(printed[3]!, /^  2\. token +subscription token$/);
	assert.ok(!printed.join('\n').includes(OAUTH) && !printed.join('\n').includes(KEY));
	await assert.rejects(async () => command.run(['auth', 'status', 'x'], ctx), {message: 'Usage: claude auth status'});
});

test('the removed auth subcommands are gone', async () => {
	const {command, ctx} = await setup();
	for (const sub of ['accounts', 'list', 'key']) {
		await assert.rejects(async () => command.run(['auth', sub], ctx), {message: 'Usage: claude auth <status|login|add|order|use|remove|logout>'}, sub);
	}
	await assert.rejects(async () => command.run(['auth', 'login', '--token'], ctx), /Unknown option "--token"/);
});

test('auth order, use and remove manage the priority', async () => {
	const {command, ctx, printed, dataDir} = await setup();
	await storeSecret(dataDir, OAUTH, 'work');
	await command.run(['auth', 'order', 'work'], ctx);
	assert.match(printed[0]!, /^▸ 1\. work /);
	assert.match(printed[1]!, /^  2\. env-key /);
	await assert.rejects(async () => command.run(['auth', 'order'], ctx), /Usage: claude auth order/);
	await assert.rejects(async () => command.run(['auth', 'order', 'nope'], ctx), /No account "nope"/);
	printed.length = 0;
	await command.run(['auth', 'use', 'env-key'], ctx);
	assert.equal(printed[0], '"env-key" is first now and its limit is forgotten; new turns use it.');
	printed.length = 0;
	await command.run(['auth', 'remove', 'work'], ctx);
	assert.equal(printed[0], 'Account "work" removed.');
	await assert.rejects(async () => command.run(['auth', 'remove', 'env-key'], ctx), /unset the variable/);
});

// A hidden-input stand-in: answers the queued values in turn and records the labels it was shown.
const secrets = (...values: string[]) => {
	const labels: string[] = [];
	const promptSecret = async (_ctx: CommandContext, label: string) => (labels.push(label), values.shift() ?? '');
	return {labels, promptSecret};
};

test('auth add stores a pasted key or token at 0600, tells them apart and never echoes them', async () => {
	const s = secrets(` ${KEY}\n`, OAUTH);
	const {command, ctx, printed, dataDir} = await setup({env: {}, login: {probe: async () => undefined, promptSecret: s.promptSecret}});
	await command.run(['auth', 'add'], ctx);
	assert.equal(printed[0], `API key stored as account "key" in ${join(dataDir, 'accounts.json')} (mode 0600).`);
	assert.equal((await stat(join(dataDir, 'accounts.json'))).mode & 0o777, 0o600);
	printed.length = 0;
	await command.run(['auth', 'add', '--name', 'spare'], ctx);
	assert.equal(printed[0], `Subscription token stored as account "spare" in ${join(dataDir, 'accounts.json')} (mode 0600).`);
	assert.equal(printed[1], 'Note: "spare" is used after account "key": API key (stored by yena) in priority order; "claude auth use spare" puts it first.');
	assert.ok(printed.some(l => l.startsWith('Notice:')));
	assert.deepEqual(s.labels, ['API key (sk-ant-…) or subscription token (sk-ant-oat…)', 'API key (sk-ant-…) or subscription token (sk-ant-oat…)']);
	const accounts = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')).accounts as {name: string; type: string; value: string}[];
	assert.deepEqual(accounts.map(a => [a.name, a.type, a.value]), [['key', 'key', KEY], ['spare', 'token', OAUTH]]);
	assert.ok(!printed.join('\n').includes(KEY) && !printed.join('\n').includes(OAUTH));
});

test('auth add refuses arguments and garbage without echoing them; cancel saves nothing', async () => {
	const s = secrets('', 'not-a-key-SECRETISH');
	const {command, ctx, printed, dataDir} = await setup({env: {}, login: {probe: async () => undefined, promptSecret: s.promptSecret}});
	await assert.rejects(
		async () => command.run(['auth', 'add', KEY], ctx),
		(e: Error) => /not accepted as arguments/.test(e.message) && !e.message.includes(KEY),
	);
	await assert.rejects(async () => command.run(['auth', 'add', '--name'], ctx), /"--name" needs an account name/);
	assert.deepEqual(s.labels, []);
	await command.run(['auth', 'add'], ctx);
	assert.deepEqual(printed, ['Cancelled; nothing was saved.']);
	await assert.rejects(async () => command.run(['auth', 'add'], ctx), (e: Error) => !e.message.includes('SECRETISH'));
	assert.ok(!(await readdir(dataDir)).includes('accounts.json'));
});

test('auth add reads the terminal without echo when there is no app, and refuses with neither', async () => {
	const asked: string[] = [];
	const {command, ctx, dataDir} = await setup({
		env: {},
		login: {probe: async () => undefined, readSecret: prompt => (asked.push(prompt), KEY), readName: prompt => (asked.push(prompt), '')},
	});
	await assert.rejects(async () => command.run(['auth', 'add'], ctx), /needs the app \(\.\/yena\) or a terminal/);
	const headless = {...ctx, headless: true, suspend: async <T,>(fn: () => T | Promise<T>) => fn()};
	await command.run(['auth', 'add'], headless);
	assert.deepEqual(asked, ['API key (sk-ant-…) or subscription token (sk-ant-oat…) (input hidden): ', 'Account name [key]: ']);
	assert.ok((await readdir(dataDir)).includes('accounts.json'));
});

test('auth add asks for the name with "token" or "key" suggested; Esc saves nothing', async () => {
	const s = secrets(OAUTH, OAUTH, KEY);
	const asked: {label: string; initial: string; problems: (string | undefined)[]}[] = [];
	const answers: (string | undefined)[] = [undefined, '', 'work'];
	const {command, ctx, printed, dataDir} = await setup({
		env: {},
		login: {
			probe: async () => undefined,
			promptSecret: s.promptSecret,
			promptName: async (_ctx, label, initial, validate) => {
				asked.push({label, initial, problems: ['token', 'env-key', 'bad/name', 'fresh'].map(validate)});
				const a = answers.shift();
				return a === '' ? initial : a;
			},
		},
	});
	await command.run(['auth', 'add'], ctx);
	assert.deepEqual(printed, ['Cancelled; nothing was saved.']);
	assert.ok(!(await readdir(dataDir)).includes('accounts.json'));
	printed.length = 0;
	await command.run(['auth', 'add'], ctx);
	assert.equal(printed[0], `Subscription token stored as account "token" in ${join(dataDir, 'accounts.json')} (mode 0600).`);
	await command.run(['auth', 'add'], ctx);
	assert.deepEqual(
		asked.map(a => [a.label, a.initial]),
		[['Account name', 'token'], ['Account name', 'token'], ['Account name', 'key']],
	);
	assert.equal(asked[1]!.problems[0], undefined);
	assert.match(asked[2]!.problems[0]!, /"token" is already an account/);
	assert.match(asked[2]!.problems[1]!, /environment variable account/);
	assert.match(asked[2]!.problems[2]!, /An account name is/);
	assert.equal(asked[2]!.problems[3], undefined);
	const accounts = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')).accounts as {name: string}[];
	assert.deepEqual(accounts.map(a => a.name), ['token', 'work']);
});

test('auth add refuses a token that is already stored before asking for a name', async () => {
	const s = secrets(OAUTH, OAUTH);
	let asked = 0;
	const {command, ctx} = await setup({
		env: {},
		login: {probe: async () => undefined, promptSecret: s.promptSecret, promptName: async (_c, _l, initial) => (asked++, initial)},
	});
	await command.run(['auth', 'add'], ctx);
	await assert.rejects(async () => command.run(['auth', 'add'], ctx), /already account "token"/);
	assert.equal(asked, 1);
});

test('auth add from the terminal asks again for a taken name, then gives up', async () => {
	const names = ['token', 'mine'];
	const prompts: string[] = [];
	const {command, ctx, dataDir} = await setup({
		env: {},
		login: {probe: async () => undefined, readSecret: () => KEY, readName: p => (prompts.push(p), names.shift() ?? 'token')},
	});
	const term = {...ctx, headless: true, suspend: async <T,>(fn: () => T | Promise<T>) => fn()};
	await storeSecret(dataDir, OAUTH);
	await command.run(['auth', 'add'], term);
	assert.deepEqual(prompts, ['Account name [key]: ', '"token" is already an account; choose another name\nAccount name [key]: ']);
	const accounts = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')).accounts as {name: string}[];
	assert.deepEqual(accounts.map(a => a.name), ['token', 'mine']);
	const other = await setup({
		env: {},
		login: {probe: async () => undefined, readSecret: () => KEY, readName: () => 'env-key'},
	});
	await assert.rejects(async () => other.command.run(['auth', 'add'], {...other.ctx, suspend: term.suspend}), /environment variable account/);
});

const LOGGED_OUT = 'Every stored account removed (keys, tokens and logins). Environment variables are not touched. "claude auth remove <account>" removes one.';

test('auth logout removes every stored account', async () => {
	const {command, ctx, printed, dataDir} = await setup({env: {}});
	await command.run(['auth', 'logout'], ctx);
	assert.deepEqual(printed, ['No stored account.']);
	printed.length = 0;
	await storeSecret(dataDir, OAUTH);
	await storeSecret(dataDir, KEY);
	printed.length = 0;
	await command.run(['auth', 'logout'], ctx);
	assert.deepEqual(printed, [LOGGED_OUT]);
	assert.ok(!(await readdir(dataDir)).includes('accounts.json'));
});

test('auth login needs a terminal handoff', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['auth', 'login'], ctx), /needs an interface that can hand over the terminal/);
});

test('claude memory opens an md file through the terminal handoff', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['memory'], ctx), /hand over the terminal/);
	const opened: string[] = [];
	const handoff = {...ctx, suspend: async <T,>(fn: () => T | Promise<T>) => (opened.push('suspend'), fn())};
	await assert.rejects(async () => command.run(['memory', '../x.md'], handoff), /md directory/);
	assert.deepEqual(opened, []);
});

const codeSetup = async (status: number | undefined, wrapper = true) => {
	const moduleDir = await mkdtemp(join(tmpdir(), 'claude-code-'));
	if (wrapper) {
		await mkdir(join(moduleDir, 'bin'));
		await writeFile(join(moduleDir, 'bin', 'claude'), '#!/bin/sh\n', {mode: 0o755});
	}
	const calls: Array<{bin: string; args: string[]}> = [];
	const waits: string[] = [];
	const s = await setup({
		moduleDir,
		runCode: (bin, args) => (calls.push({bin, args}), status),
		login: {probe: async () => undefined, wait: m => waits.push(m)},
	});
	const ctx = (headless: boolean): CommandContext => ({...s.ctx, headless, suspend: async <T,>(fn: () => T | Promise<T>) => fn()});
	return {...s, plain: s.ctx, moduleDir, calls, waits, ctx};
};

test('claude code runs bin/claude with the arguments as given', async () => {
	const s = await codeSetup(0);
	await s.command.run(['code', '-p', 'a b', '$(x)'], s.ctx(false));
	assert.deepEqual(s.calls, [{bin: join(s.moduleDir, 'bin', 'claude'), args: ['-p', 'a b', '$(x)']}]);
	assert.deepEqual(s.waits, []);
});

test('claude code needs a terminal handoff and an executable wrapper', async () => {
	const s = await codeSetup(0);
	await assert.rejects(async () => s.command.run(['code'], s.plain), /hand over the terminal/);
	const missing = await codeSetup(0, false);
	await assert.rejects(async () => missing.command.run(['code'], missing.ctx(false)), /bin\/install/);
	assert.deepEqual(missing.calls, []);
});

test('claude code reports a failing exit and waits for Enter only outside headless mode', async () => {
	const s = await codeSetup(3);
	await assert.rejects(async () => s.command.run(['code'], s.ctx(true)), {message: 'Claude Code exited with status 3'});
	assert.deepEqual(s.waits, []);
	await assert.rejects(async () => s.command.run(['code'], s.ctx(false)), {message: 'Claude Code exited with status 3'});
	assert.equal(s.waits.length, 1);
	const killed = await codeSetup(undefined);
	await assert.rejects(async () => killed.command.run(['code'], killed.ctx(true)), /did not run to completion/);
});

test('auth without or with unknown subcommand fails with usage', async () => {
	const {command, ctx} = await setup();
	for (const args of [['auth'], ['auth', 'nope']]) {
		await assert.rejects(async () => command.run(args, ctx), {message: 'Usage: claude auth <status|login|add|order|use|remove|logout>'});
	}
});

const listSources = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	for (const entry of await readdir(dir, {withFileTypes: true})) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listSources(full)));
		else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
	}
	return out;
};

test('no source file mentions the removed .token file', async () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
	const offenders: string[] = [];
	for (const file of await listSources(dir)) {
		const text = await readFile(file, 'utf8');
		if (/\.token\b|tokenFile|legacy-file/.test(text)) offenders.push(file.slice(dir.length + 1));
	}
	assert.deepEqual(offenders, []);
});

test('only credentials.ts reads credential env values or credential files', async () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
	const names = 'ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN';
	const envReads = [
		new RegExp(`process\\.env(\\.|\\[\\s*['"\`])(${names})`),
		new RegExp(`\\benv\\.(${names})\\b`),
		new RegExp(`\\benv\\[\\s*['"\`](${names})`),
	];
	const fileReader = /\b(readFile|readFileSync|createReadStream|open|openSync)\b/;
	const tokenRef = /credentials\.json|credentialsFile|storedFile/;
	const allowed = [new RegExp(`delete\\s+\\w+\\.(${names})\\b`), new RegExp(`\\b\\w+\\.(${names})\\s*=[^=]`)];
	const offenders: string[] = [];
	for (const file of await listSources(dir)) {
		const name = file.slice(dir.length + 1);
		// The accounts store and its front end are the two places that handle credentials.
		if (name === 'credentials.ts' || name === 'accounts.ts') continue;
		const lines = (await readFile(file, 'utf8')).split('\n');
		lines.forEach((line, i) => {
			const code = line.replace(/\/\/.*$/, '');
			if (allowed.some(re => re.test(code))) return;
			const readsEnv = envReads.some(re => re.test(code));
			const readsTokenFile = fileReader.test(code) && tokenRef.test(code);
			if (readsEnv || readsTokenFile) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
		});
	}
	assert.deepEqual(offenders, []);
});

test('ask output is sanitized and redacted before printing', async () => {
	const evil = `ok \x1b]52;c;QUJD\x07 \x1b]8;;http://x\x07link\x1b]8;;\x07 \x1b[31mred\x1b[0m ‮flip ${KEY}`;
	const q = makeQuery(() => okMsgs(SID1, evil));
	const {command, ctx, printed} = await setup({loadQuery: async () => q.query});
	await command.run(['ask', 'x'], ctx);
	const out = printed.join('\n');
	assert.equal(/\x1b|‮|\x07/.test(out), false);
	assert.equal(out.includes(KEY), false);
	assert.ok(out.includes('link'));
});

test('commands carry agent policies', async () => {
	const {command} = await setup();
	assert.equal(command.agent, 'deny');
	const by = Object.fromEntries(command.subcommands!.map(s => [s.name, s.agent]));
	for (const n of ['session', 'tasks', 'mcp']) assert.equal(by[n], 'safe', n);
	for (const n of ['ping', 'rename', 'export', 'auth']) assert.equal(by[n], 'confirm', n);
	for (const n of ['ask', 'chat', 'new', 'resume', 'rewind', 'fork', 'copy', 'memory', 'code']) assert.equal(by[n], 'deny', n);
	const auth = command.subcommands!.find(s => s.name === 'auth')!;
	const authBy = Object.fromEntries(auth.subcommands!.map(s => [s.name, s.agent]));
	assert.deepEqual(authBy, {status: 'confirm', login: 'deny', add: 'confirm', order: 'confirm', use: 'confirm', remove: 'confirm', logout: 'confirm'});
	const reconnect = command.subcommands!.find(s => s.name === 'mcp')!.subcommands!.find(s => s.name === 'reconnect')!;
	assert.equal(reconnect.agent, undefined);
});

test('the claude, chat and fix commands pass the documentation check', async () => {
	const {command} = await setup();
	assert.deepEqual(checkCommandDocs(command), []);
	const cmds = createClaudeCommands({dataDir: '/tmp/x', env: {}, loadQuery: async () => (() => { throw new Error('unused'); }) as never});
	for (const c of cmds) assert.deepEqual(checkCommandDocs(c), [], c.name);
});

test('the top-level chat command is denied to agents', async () => {
	const {createClaudeCommands} = await import('../src/commands.js');
	const cmds = createClaudeCommands({dataDir: '/tmp/x', env: {}, loadQuery: async () => (() => { throw new Error('unused'); }) as never});
	assert.equal(cmds.find(c => c.name === 'chat')?.agent, 'deny');
});

test('chat is listed in the subcommands', async () => {
	const {command} = await setup();
	assert.ok(command.subcommands?.some(s => s.name === 'chat' && s.usage === 'claude chat [--new]'));
});

test('ask footer and session output never carry control bytes or the secret', async () => {
	const evilModel = `m\x1b]0;x\x07\x1b]52;c;QUJD\x07${OAUTH}`;
	const q = makeQuery(() => [
		{type: 'system', subtype: 'init', session_id: SID1, model: evilModel, apiKeySource: 'x'},
		{type: 'result', subtype: 'success', is_error: false, result: 'fine', session_id: SID1},
	]);
	const {command, ctx, printed} = await setup({env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, loadQuery: async () => q.query});
	await command.run(['ask', 'x'], ctx);
	await command.run(['session'], ctx);
	const out = printed.join('\n');
	assert.equal(/[\x1b\x07]/.test(out), false);
	assert.equal(out.includes(OAUTH), false);
});

const SENTINELS = ['PROMPT-SENTINEL-1', 'ASSISTANT-SENTINEL-2', 'TOOLIN-SENTINEL-3', 'TOOLOUT-SENTINEL-4'];

test('ask logs lifecycle with labels only, registers the redactor first, and leaks nothing', async () => {
	const log = makeFakeLog();
	const q = makeQuery(() => [
		{type: 'system', subtype: 'init', session_id: SID1, model: 'claude-test-1', apiKeySource: 'x'},
		{
			type: 'assistant',
			message: {content: [{type: 'text', text: SENTINELS[1]}, {type: 'tool_use', id: 't1', name: 'Read', input: {path: SENTINELS[2]}}]},
		},
		{type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't1', content: SENTINELS[3]}]}},
		{type: 'result', subtype: 'success', is_error: false, result: SENTINELS[1], session_id: SID1, num_turns: 2},
	]);
	const {command, ctx} = await setup({log, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH}, loadQuery: async () => q.query});
	await command.run(['ask', SENTINELS[0]!], ctx);
	await command.run(['ask', SENTINELS[0]!], ctx);

	const out = serialized(log);
	for (const secret of [...SENTINELS, OAUTH, 'sk-ant']) assert.equal(out.includes(secret), false, secret);
	assert.equal(log.redactors.length, 1);
	assert.equal(log.trail[0], '<addRedactor>');
	assert.equal(log.redactors[0]!(`x ${OAUTH}`), 'x [redacted]');
	const find = (msg: string) => log.records.filter(r => r.msg === msg);
	assert.deepEqual(find('credential resolved')[0]!.fields, {kind: 'oauth', source: 'env'});
	assert.deepEqual(find('ask started')[0]!.fields, {fresh: false, promptChars: SENTINELS[0]!.length});
	const done = find('ask finished')[0]!;
	assert.equal(done.level, 'info');
	assert.equal(done.fields.outcome, 'ok');
	assert.equal(done.fields.model, 'claude-test-1');
	assert.equal(done.fields.numTurns, 2);
	assert.equal(done.fields.session8, SID1.slice(0, 8));
	assert.equal(typeof done.fields.ms, 'number');
});

test('ask failure logs a redacted, capped reason at warn', async () => {
	const log = makeFakeLog();
	const q = makeQuery(() => new Error(`${'x'.repeat(400)} ${KEY}`));
	const {command, ctx} = await setup({log, loadQuery: async () => q.query});
	await assert.rejects(async () => command.run(['ask', 'hi'], ctx));
	const failed = log.records.find(r => r.msg === 'ask failed')!;
	assert.equal(failed.level, 'warn');
	assert.equal(failed.fields.outcome, 'error');
	assert.equal(failed.fields.errClass, 'TurnFailure');
	assert.ok((failed.fields.reason as string).length <= 301);
	assert.equal(serialized(log).includes(KEY), false);
	assert.ok(log.records.some(r => r.msg === 'query threw' && r.level === 'warn'));
});

test('ask timeout logs the timer and a timeout outcome', async () => {
	const log = makeFakeLog();
	let release!: () => void;
	const hang = (() => ({
		[Symbol.asyncIterator]: () => ({
			next: () => new Promise<IteratorResult<never>>(resolve => (release = () => resolve({done: true, value: undefined}))),
		}),
		close: () => release(),
	})) as unknown as QueryFn;
	const {command, ctx} = await setup({log, loadQuery: async () => hang, timeoutMs: 30});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /timed out/);
	assert.deepEqual(log.records.find(r => r.msg === 'ask timed out'), {level: 'warn', scope: '', msg: 'ask timed out', fields: {timeoutMs: 30}});
	assert.equal(log.records.find(r => r.msg === 'ask failed')!.fields.outcome, 'timeout');
});

test('ask without credentials logs a warning', async () => {
	const log = makeFakeLog();
	const {command, ctx} = await setup({log, env: {}});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /No credentials found/);
	assert.ok(log.records.some(r => r.level === 'warn' && r.msg === 'no credential'));
	assert.equal(log.redactors.length, 0);
});

test('a missing SDK logs an error with missingModule', async () => {
	const log = makeFakeLog();
	const {command, ctx} = await setup({
		log,
		loadQuery: async () => {
			throw Object.assign(new Error('Cannot find package'), {code: 'ERR_MODULE_NOT_FOUND'});
		},
	});
	await assert.rejects(async () => command.run(['ask', 'x'], ctx), /not installed/);
	const rec = log.records.find(r => r.level === 'error')!;
	assert.equal(rec.fields.missingModule, true);
});

test('auth status, key and logout are logged with labels only', async () => {
	const log = makeFakeLog();
	const {command, ctx, dataDir} = await setup({log});
	await command.run(['auth', 'status'], ctx);
	const status = log.records.find(r => r.msg === 'auth status')!;
	assert.equal(status.level, 'info');
	assert.deepEqual(status.fields, {kind: 'api-key', source: 'env', accounts: 1, limited: 0});

	await command.run(['auth', 'logout'], ctx);
	assert.deepEqual(log.records.find(r => r.msg === 'stored credential removed')!.fields, {removed: false});

	const added = createClaudeCommand({dataDir, env: {}, loadQuery: async () => (() => []) as unknown as QueryFn, log, login: {promptSecret: async () => KEY}});
	await added.run(['auth', 'add'], ctx);
	assert.deepEqual(log.records.find(r => r.msg === 'credential stored')!.fields, {type: 'key'});
	assert.equal(serialized(log).includes(KEY), false);
});

test('ask limit failure logs the failure kind and no reason', async () => {
	const log = makeFakeLog();
	const msgs = [
		{type: 'system', subtype: 'init', session_id: SID1, model: 'claude-test-1', apiKeySource: 'x'},
		{type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: "You've hit your limit · resets 3pm"}]}},
		{type: 'result', subtype: 'success', is_error: true, result: 'x', session_id: SID1},
	];
	const {command, ctx} = await setup({log, loadQuery: async () => makeQuery(() => msgs).query});
	await assert.rejects(async () => command.run(['ask', 'hi'], ctx), /Usage limit reached/);
	const failed = log.records.find(r => r.msg === 'ask failed')!;
	assert.equal(failed.fields.failure, 'usage-limit');
	assert.equal('reason' in failed.fields, false);
	assert.ok(!JSON.stringify(log.records).includes('hit your limit'));
});

test('ask at a usage limit goes on with the next account in the same session', async () => {
	const OAUTH2 = 'sk-ant-oat-SECONDVALUE0123456789abcdef';
	const limited = [
		{type: 'system', subtype: 'init', session_id: SID1, model: 'claude-test-1', apiKeySource: 'x'},
		{type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour'}},
		{type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: "You've hit your limit · resets 3pm"}]}},
		{type: 'result', subtype: 'success', is_error: true, result: 'x', session_id: SID1},
	];
	const q = makeQuery((_c, n) => (n === 1 ? limited : okMsgs(SID1, 'answer')));
	const {command, ctx, printed, dataDir} = await setup({env: {}, loadQuery: async () => q.query});
	await storeSecret(dataDir, OAUTH, 'work');
	await storeSecret(dataDir, OAUTH2, 'spare');
	await command.run(['ask', 'hi'], ctx);
	assert.ok(printed.includes('Account "work" reached its usage limit; continuing with "spare".'));
	assert.ok(printed.includes('answer'));
	assert.equal(q.calls.length, 2);
	assert.equal((q.calls[0]!.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, OAUTH);
	assert.equal((q.calls[1]!.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, OAUTH2);
	assert.equal(q.calls[1]!.options.resume, SID1);
	assert.equal(q.calls[1]!.prompt, CONTINUE_TEXT);
	const file = JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8'));
	assert.equal(file.limits.work.reason, 'usage-limit');
	// The next ask starts on the account that still has quota.
	await command.run(['ask', 'again'], ctx);
	assert.equal((q.calls[2]!.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, OAUTH2);
});

const EMAIL = 'owner.person@example.com';

const loginSetup = async (over: {env?: NodeJS.ProcessEnv; status?: LoginStatus; runOk?: boolean; afterRun?: LoginStatus; logoutOk?: boolean; token?: string; log?: ReturnType<typeof makeFakeLog>} = {}) => {
	const moduleDir = await mkdtemp(join(tmpdir(), 'claude-mod-'));
	const pkg = join(moduleDir, '.runtime', 'node_modules', '@anthropic-ai', 'claude-code');
	await mkdir(pkg, {recursive: true});
	await writeFile(join(pkg, 'package.json'), '{"version":"9.9.9"}');
	const runs: Array<{bin: string; args: string[]; env: NodeJS.ProcessEnv}> = [];
	const logouts: Array<{bin: string; env: Record<string, string | undefined>}> = [];
	let status: LoginStatus | undefined = over.status;
	let probes = 0;
	// What Claude Code's login leaves in its config dir (yena reads it to keep the login as an account).
	const signIn = async (dataDir: string) => {
		await mkdir(join(dataDir, 'config'), {recursive: true});
		await writeFile(join(dataDir, 'config', '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'LOGIN-ACCESS', refreshToken: 'LOGIN-REFRESH'}}));
		await writeFile(join(dataDir, 'config', '.claude.json'), JSON.stringify({oauthAccount: {emailAddress: EMAIL, accountUuid: 'uuid-1'}}));
	};
	let pendingSignIn = false;
	const s = await setup({
		env: over.env ?? {},
		moduleDir,
		...(over.log && {log: over.log}),
		login: {
			probe: async () => (probes++, status),
			run: (bin, args, env) => {
				runs.push({bin, args, env});
				if (over.runOk !== false && over.afterRun) {
					status = over.afterRun;
					pendingSignIn = args[0] === 'auth';
				}
				return over.runOk !== false;
			},
			wait: () => {},
			readSecret: () => over.token ?? '',
			readName: () => '',
			logout: async (bin, env) => {
				logouts.push({bin, env});
				if (over.logoutOk !== false) status = {loggedIn: false};
				return over.logoutOk !== false;
			},
		},
	});
	if (over.status?.loggedIn) await signIn(s.dataDir);
	const suspended: string[] = [];
	const ctx: CommandContext = {
		...s.ctx,
		suspend: async <T,>(fn: () => T | Promise<T>) => {
			suspended.push('s');
			const out = await fn();
			if (pendingSignIn) await signIn(s.dataDir);
			pendingSignIn = false;
			return out;
		},
	};
	return {...s, ctx, plain: s.ctx, runs, logouts, suspended, probes: () => probes, moduleDir};
};

const SIGNED_IN: LoginStatus = {loggedIn: true, method: 'claude.ai', subscriptionType: 'max', email: EMAIL};

test('auth login argument errors show without a terminal handoff', async () => {
	const s = await loginSetup();
	await assert.rejects(async () => s.command.run(['auth', 'login', '--bogus'], s.plain), /Unknown option "--bogus"\. Usage: claude auth login/);
	await assert.rejects(async () => s.command.run(['auth', 'login', '--token'], s.plain), /Unknown option "--token"/);
	await assert.rejects(async () => s.command.run(['auth', 'login', '--sso'], s.plain), /needs an interface that can hand over the terminal/);
	assert.equal(s.runs.length, 0);
});

test('browser login success passes exact args and a credential-free env', async () => {
	const log = makeFakeLog();
	const s = await loginSetup({env: {ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: OAUTH, PATH: '/bin'}, afterRun: SIGNED_IN, log});
	await s.command.run(['auth', 'login', '--console', '--sso', '--email', EMAIL], s.ctx);
	assert.equal(s.runs.length, 1);
	assert.deepEqual(s.runs[0]!.args, ['auth', 'login', '--console', '--sso', '--email', EMAIL]);
	assert.equal(s.runs[0]!.bin, join(s.moduleDir, '.runtime', 'node_modules', '.bin', 'claude'));
	for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(s.runs[0]!.env[name], undefined);
	assert.equal(s.runs[0]!.env.CLAUDE_CONFIG_DIR, join(s.dataDir, 'config'));
	assert.equal(s.runs[0]!.env.DISABLE_AUTOUPDATER, '1');
	const out = s.printed.join('\n');
	assert.match(out, /Signed in with Claude Code \(claude\.ai\) as account "owner\.person@example\.com"/);
	assert.ok(out.includes(join(s.dataDir, 'config', '.credentials.json')));
	assert.match(out, /Note: "owner\.person@example\.com" is used after API key \(from environment\) in priority order/);
	assert.deepEqual(log.records.find(r => r.msg === 'claude login started')!.fields, {method: 'console', sso: true, email: true});
	assert.deepEqual(log.records.find(r => r.msg === 'claude login finished')!.fields, {
		exitOk: true,
		loggedIn: true,
		method: 'claude.ai',
		subscriptionType: 'max',
	});
	assert.ok(!serialized(log).includes(EMAIL));
	assert.ok(!serialized(log).includes(KEY));
});

test('browser login without an env source makes the login active and shows the notice', async () => {
	const s = await loginSetup({afterRun: SIGNED_IN});
	await s.command.run(['auth', 'login'], s.ctx);
	assert.deepEqual(s.runs[0]!.args, ['auth', 'login']);
	assert.ok(s.printed.some(l => l.startsWith('Signed in with Claude Code (claude.ai) as account "owner.person@example.com"')));
	assert.ok(!s.printed.some(l => l.startsWith('Note:')));
	assert.equal(s.printed.filter(l => l.startsWith('Notice:')).length, 1);
	const slot = JSON.parse(await readFile(join(s.dataDir, 'accounts', EMAIL, 'login.json'), 'utf8'));
	assert.equal(slot.credentials.claudeAiOauth.accessToken, 'LOGIN-ACCESS');
	s.printed.length = 0;
	await s.command.run(['auth', 'status'], s.plain);
	assert.equal(s.printed[0], `Active credential: account "${EMAIL}": Claude subscription (Claude Code login)`);
});

test('browser login that does not finish changes nothing', async () => {
	const log = makeFakeLog();
	const s = await loginSetup({runOk: false, log});
	await s.command.run(['auth', 'login'], s.ctx);
	assert.ok(s.printed.includes('Login did not complete; nothing was changed.'));
	assert.deepEqual(log.records.find(r => r.msg === 'claude login finished')!.fields, {
		exitOk: false,
		loggedIn: false,
		method: undefined,
		subscriptionType: undefined,
	});
});

test('auth logout runs the CLI logout only when a login exists', async () => {
	const none = await loginSetup();
	await none.command.run(['auth', 'logout'], none.ctx);
	assert.equal(none.logouts.length, 0);

	const s = await loginSetup({status: SIGNED_IN, env: {PATH: '/bin', ANTHROPIC_API_KEY: KEY}});
	await storeSecret(s.dataDir, KEY);
	await s.command.run(['auth', 'logout'], s.ctx);
	assert.equal(s.logouts.length, 1);
	assert.equal(s.logouts[0]!.env.ANTHROPIC_API_KEY, undefined);
	assert.equal(s.logouts[0]!.env.CLAUDE_CONFIG_DIR, join(s.dataDir, 'config'));
	await assert.rejects(readFile(join(s.dataDir, 'credentials.json'), 'utf8'));
	assert.ok(s.printed.includes('Claude Code login removed.'));
});

test('auth logout warns when Claude Code still reports a login', async () => {
	const s = await loginSetup({status: SIGNED_IN, logoutOk: false});
	await s.command.run(['auth', 'logout'], s.ctx);
	assert.ok(s.printed.some(l => l.startsWith('Warning: Claude Code still reports a login')));
	assert.equal(s.logouts.length, 1);
});

test('auth logout with extra arguments is a usage error and changes nothing', async () => {
	const s = await loginSetup({status: SIGNED_IN});
	await assert.rejects(async () => s.command.run(['auth', 'logout', 'now'], s.ctx), {message: 'Usage: claude auth logout'});
	assert.equal(s.logouts.length, 0);
});

test('auth status shows the login with subscription and email on screen only', async () => {
	const log = makeFakeLog();
	const s = await loginSetup({status: SIGNED_IN, log});
	await storeSecret(s.dataDir, OAUTH);
	await s.command.run(['auth', 'status'], s.ctx);
	assert.equal(s.printed[0], `Active credential: account "${EMAIL}": Claude subscription (Claude Code login)`);
	assert.ok(s.printed.some(l => l.includes(`Claude Code login (subscription, ${EMAIL})`)));
	assert.ok(s.printed.some(l => /^ {2}2\. token +subscription token$/.test(l)));
	const rec = log.records.find(r => r.msg === 'auth status')!;
	assert.deepEqual(rec.fields, {kind: 'oauth', source: 'claude-login', accounts: 2, limited: 0});
	assert.ok(!serialized(log).includes(EMAIL));
});

test('auth status names the login among other sources when an env key has priority', async () => {
	const s = await loginSetup({status: SIGNED_IN, env: {ANTHROPIC_API_KEY: KEY}});
	await s.command.run(['auth', 'status'], s.ctx);
	assert.ok(s.printed.some(l => /^ {2}2\. owner\.person@example\.com +Claude Code login/.test(l)));
});

test('auth add notes that a login shadows the stored key', async () => {
	const s = await loginSetup({status: SIGNED_IN, token: KEY});
	await s.command.run(['auth', 'add'], s.ctx);
	assert.ok(s.printed.some(l => l.startsWith(`Note: "key" is used after account "${EMAIL}": Claude subscription (Claude Code login)`)));
});

test('ask with a login source: env without credentials, footer says subscription login', async () => {
	const s = await loginSetup({status: SIGNED_IN, env: {PATH: '/bin'}});
	await s.command.run(['ask', 'hi'], s.plain);
	const env = s.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	assert.equal(s.printed.filter(l => l.startsWith('[session')).at(-1), '[session 11111111 · model claude-test-1 · subscription login]');
});

test('auth lists its subcommands with their own usages and options', () => {
	const command = createClaudeCommand({dataDir: '/nonexistent', env: {}, loadQuery: async () => (() => []) as unknown as QueryFn});
	const auth = command.subcommands!.find(x => x.name === 'auth')!;
	assert.equal(auth.usage, 'claude auth <subcommand>');
	assert.deepEqual(auth.subcommands!.map(s => s.name), ['status', 'login', 'add', 'order', 'use', 'remove', 'logout']);
	const login = auth.subcommands!.find(s => s.name === 'login')!;
	assert.deepEqual(login.options!.map(o => o.name), ['--name', '--console', '--claudeai', '--sso', '--email']);
	assert.ok(!JSON.stringify(auth).match(/--token|--from-file/));
	for (const s of [auth, ...auth.subcommands!]) assert.ok(s.description.length <= 70, s.name);
});

test('auth add from the terminal never runs the Claude Code CLI', async () => {
	const s = await loginSetup({token: OAUTH});
	await s.command.run(['auth', 'add'], {...s.ctx, headless: true});
	assert.equal(s.runs.length, 0);
	const body = JSON.parse(await readFile(join(s.dataDir, 'accounts.json'), 'utf8')).accounts[0];
	assert.deepEqual([body.kind, body.value], ['oauth', OAUTH]);
	assert.ok(!s.printed.join('\n').includes(OAUTH));
});
