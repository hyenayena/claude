import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmod, mkdtemp, readdir, readFile, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import type {CommandContext} from '../../../src/api.js';
import {storeOauthToken} from '../src/credentials.js';
import {createClaudeCommand, type ClaudeDeps} from '../src/commands.js';
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
	assert.deepEqual(printed, ['Asking Claude…', 'answer', '[session 11111111 · model claude-test-1 · API key]']);
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
	await assert.rejects(async () => command.run(['ask'], ctx), {message: 'Usage: claude ask [--new] <text>'});
	await assert.rejects(async () => command.run(['ask', '--new'], ctx), {message: 'Usage: claude ask [--new] <text>'});
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
			'No credentials found. Set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>" to store an API key. See "claude auth status".',
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

test('auth status warns on a world-readable legacy file and reports no secret', async () => {
	const {command, ctx, printed, dataDir} = await setup({env: {}});
	await writeFile(join(dataDir, '.token'), OAUTH);
	await chmod(join(dataDir, '.token'), 0o644);
	await command.run(['auth', 'status'], ctx);
	const out = printed.join('\n');
	assert.match(out, /subscription token \(from legacy file \.token\)/);
	assert.match(out, /Warning: \.token is readable by other users/);
	assert.ok(!out.includes(OAUTH));
});

test('auth status without credentials prints the missing message', async () => {
	const {command, ctx, printed} = await setup({env: {}});
	await command.run(['auth', 'status'], ctx);
	assert.match(printed[0]!, /^No credentials found/);
});

test('auth status lists other sources by name only', async () => {
	const {command, ctx, printed, dataDir} = await setup();
	await command.run(['auth', 'status'], ctx);
	assert.ok(!printed.some(l => l.startsWith('Other available')));
	await writeFile(join(dataDir, '.token'), OAUTH, {mode: 0o600});
	printed.length = 0;
	await command.run(['auth', 'status'], ctx);
	assert.ok(printed.includes('Other available sources: legacy file (.token)'));
});

const keyFile = async (content: string) => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-keyfile-'));
	const file = join(dir, 'key.txt');
	await writeFile(file, content);
	return {dir, file};
};

test('auth key --from-file stores the key at 0600 and never echoes it', async () => {
	const {command, ctx, printed, dataDir} = await setup({env: {}});
	const {file} = await keyFile(` ${KEY}\n`);
	await command.run(['auth', 'key', '--from-file', file], ctx);
	assert.equal(printed[0], `API key stored in ${join(dataDir, 'credentials.json')} (mode 0600). Source file left untouched; delete it yourself.`);
	assert.ok(!printed.join('\n').includes(KEY));
	assert.equal((await stat(join(dataDir, 'credentials.json'))).mode & 0o777, 0o600);
	assert.equal(await readFile(file, 'utf8'), ` ${KEY}\n`);
	printed.length = 0;
	await command.run(['auth', 'status'], ctx);
	assert.equal(printed[0], 'Active credential: API key (stored by yena)');
});

test('auth key follows a symlink to a regular file', async () => {
	const {command, ctx, dataDir} = await setup({env: {}});
	const {dir, file} = await keyFile(KEY);
	const link = join(dir, 'link');
	await symlink(file, link);
	await command.run(['auth', 'key', '--from-file', link], ctx);
	assert.ok((await readdir(dataDir)).includes('credentials.json'));
});

test('auth key rejects a fifo without hanging', async () => {
	const {command, ctx, dataDir} = await setup({env: {}});
	const dir = await mkdtemp(join(tmpdir(), 'claude-fifo-'));
	const fifo = join(dir, 'pipe');
	execFileSync('mkfifo', [fifo]);
	await assert.rejects(
		Promise.race([
			command.run(['auth', 'key', '--from-file', fifo], ctx),
			new Promise((_, reject) => setTimeout(() => reject(new Error('hung on fifo')), 3000).unref()),
		]),
		/not a regular file/,
	);
	assert.ok(!(await readdir(dataDir)).includes('credentials.json'));
});

test('auth key rejects bad input without echoing content', async () => {
	const {command, ctx, printed} = await setup({env: {}});
	const run = (args: string[]) => command.run(['auth', 'key', ...args], ctx);

	await assert.rejects(async () => run([KEY]), (e: Error) => /--from-file/.test(e.message) && !e.message.includes(KEY));
	await assert.rejects(async () => run([]), /--from-file/);
	await assert.rejects(async () => run(['--from-file']), /Usage: claude auth key/);
	await assert.rejects(async () => run(['--from-file', '/a', 'b/c']), /Paths with spaces are not supported/);

	const dir = await mkdtemp(join(tmpdir(), 'claude-keydir-'));
	await assert.rejects(async () => run(['--from-file', dir]), /not a regular file/);
	await assert.rejects(async () => run(['--from-file', join(dir, 'missing')]), /Cannot read/);

	const big = await keyFile(KEY + ' '.repeat(5000));
	await assert.rejects(async () => run(['--from-file', big.file]), /larger than 4096 bytes/);

	const junk = await keyFile('not-a-key-SECRETISH');
	await assert.rejects(
		async () => run(['--from-file', junk.file]),
		(e: Error) => e.message === 'The file does not contain a valid Anthropic API key',
	);

	const oauth = await keyFile(OAUTH);
	await assert.rejects(
		async () => run(['--from-file', oauth.file]),
		(e: Error) => /subscription \(OAuth\) token/.test(e.message) && !e.message.includes(OAUTH),
	);
	assert.deepEqual(printed, []);
});

test('auth logout removes only the stored credential', async () => {
	const {command, ctx, printed, dataDir} = await setup({env: {}});
	await command.run(['auth', 'logout'], ctx);
	assert.deepEqual(printed, ['No stored credential.']);
	printed.length = 0;
	await writeFile(join(dataDir, '.token'), OAUTH, {mode: 0o600});
	const {file} = await keyFile(KEY);
	await command.run(['auth', 'key', '--from-file', file], ctx);
	printed.length = 0;
	await command.run(['auth', 'logout'], ctx);
	assert.equal(printed[0], 'Stored credential removed. Environment variables and the legacy file .token are not touched.');
	assert.equal(printed[1], 'Active credential: subscription token (from legacy file .token)');
	assert.equal(await readFile(join(dataDir, '.token'), 'utf8'), OAUTH);
});

test('auth login needs a terminal handoff; the token goes to .token only when it looks right', async () => {
	const {command, ctx, dataDir} = await setup();
	await assert.rejects(async () => command.run(['auth', 'login'], ctx), /needs an interface that can hand over the terminal/);
	await assert.rejects(storeOauthToken(dataDir, 'sk-ant-api03-notatoken'), /not a subscription token/);
	await storeOauthToken(dataDir, `  ${OAUTH}\n`);
	assert.equal(await readFile(join(dataDir, '.token'), 'utf8'), `${OAUTH}\n`);
	assert.equal((await stat(join(dataDir, '.token'))).mode & 0o777, 0o600);
});

test('claude memory opens an md file through the terminal handoff', async () => {
	const {command, ctx} = await setup();
	await assert.rejects(async () => command.run(['memory'], ctx), /hand over the terminal/);
	const opened: string[] = [];
	const handoff = {...ctx, suspend: async <T,>(fn: () => T | Promise<T>) => (opened.push('suspend'), fn())};
	await assert.rejects(async () => command.run(['memory', '../x.md'], handoff), /md directory/);
	assert.deepEqual(opened, []);
});

test('auth without or with unknown subcommand fails with usage', async () => {
	const {command, ctx} = await setup();
	for (const args of [['auth'], ['auth', 'nope']]) {
		await assert.rejects(async () => command.run(args, ctx), {message: 'Usage: claude auth <status|key|logout|login>'});
	}
});

test('only credentials.ts reads credential env values or the token file', async () => {
	const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
	const names = 'ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN';
	const envReads = [
		new RegExp(`process\\.env(\\.|\\[\\s*['"\`])(${names})`),
		new RegExp(`\\benv\\.(${names})\\b`),
		new RegExp(`\\benv\\[\\s*['"\`](${names})`),
	];
	const fileReader = /\b(readFile|readFileSync|createReadStream|open|openSync)\b/;
	const tokenRef = /\.token\b|tokenFile/;
	const allowed = [new RegExp(`delete\\s+\\w+\\.(${names})\\b`), new RegExp(`\\b\\w+\\.(${names})\\s*=[^=]`)];
	const offenders: string[] = [];
	for (const name of await readdir(dir)) {
		if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'credentials.ts') continue;
		const lines = (await readFile(join(dir, name), 'utf8')).split('\n');
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
	assert.deepEqual(status.fields, {kind: 'api-key', source: 'env', others: []});

	await command.run(['auth', 'logout'], ctx);
	assert.deepEqual(log.records.find(r => r.msg === 'stored credential removed')!.fields, {removed: false});

	const keyFile = join(dataDir, 'key.txt');
	await writeFile(keyFile, KEY);
	await command.run(['auth', 'key', '--from-file', keyFile], ctx);
	assert.ok(log.records.some(r => r.msg === 'api key stored'));
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
