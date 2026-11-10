import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {Command, CommandContext} from '../../../src/api.js';
import {CHAT_DISALLOWED_TOOLS, CHAT_TOOLS} from '../src/policy.js';
import type {ClaudeDeps} from '../src/commands.js';
import {shimClaude, type Props} from './helpers/claude-shim.js';
import {resolvePaths} from '../src/config.js';
import {checkCommandDocs} from '../src/kit.js';
import type {ChatQueryFn, QueryFn} from '../src/types.js';
import {makeFakeLog, serialized} from './helpers/fake-log.js';
import {fakeCredentials, seed} from './helpers/fake-credentials.js';
import {API_KEY_ONLY} from '../src/credentials.js';
import {hostVault} from '../src/vault.js';

const OAUTH = 'sk-ant-oat01-TESTVALUE0123456789abcdef';
const KEY = 'sk-ant-api03-SCHEDVALUE0123456789abcdef';
const SID1 = '11111111-aaaa-4bbb-8ccc-222222222222';
const SID2 = '33333333-aaaa-4bbb-8ccc-444444444444';


const makeChatQuery = (failFirst = false, failMessage = 'boom') => {
	const calls: Array<{options: Record<string, unknown>}> = [];
	let closed = 0;
	const query = ((arg: {prompt: AsyncIterable<unknown>; options: Record<string, unknown>}) => {
		calls.push({options: arg.options});
		const gen = (async function* () {
			for await (const _ of arg.prompt) {
				yield {type: 'system', subtype: 'init', session_id: SID2, model: 'claude-test-1', apiKeySource: 'x'};
				if (failFirst) {
					yield {type: 'result', subtype: 'error_during_execution', is_error: true, errors: [failMessage], session_id: SID2};
				} else {
					yield {type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: SID2};
				}
			}
		})();
		return Object.assign(gen, {close: () => void closed++, interrupt: async () => {}});
	}) as unknown as ChatQueryFn;
	return {query, calls, closed: () => closed};
};

const turnDone = (props: Props): Promise<void> =>
	new Promise(resolve => {
		props.controller.subscribe(e => {
			if (e.type === 'turn-end') resolve();
		});
	});

const setup = async (opts: {mount?: boolean; failFirst?: boolean; failMessage?: string; run?: (p: Props) => Promise<void>; deps?: Partial<ClaudeDeps>} = {}) => {
	const dataDir = await mkdtemp(join(tmpdir(), 'claude-chat-'));
	const printed: string[] = [];
	const props: Props[] = [];
	let mounts = 0;
	const ctx: CommandContext = {print: t => printed.push(t), clear: () => {}, exit: () => {}};
	if (opts.mount !== false) {
		ctx.mount = async build => {
			mounts++;
			const el = build({close: () => {}});
			assert.equal(typeof el, 'object');
			await opts.run?.(props[props.length - 1]!);
		};
	}
	const q = makeChatQuery(opts.failFirst, opts.failMessage);
	const aborts: AbortController[] = [];
	let unregistered = 0;
	const real = shimClaude({
		dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => q.query,
		registerAbort: c => {
			aborts.push(c);
			return () => void unregistered++;
		},
		login: {probe: async () => undefined},
		loadRetired: async () => undefined,
		...opts.deps,
	}, {onProps: p => props.push(p)}).claude;
	const command = {run: async (args: string[], c: CommandContext) => real.run(args, c)};
	return {command, dataDir, printed, ctx, q, props, aborts, mounts: () => mounts, unregistered: () => unregistered};
};

const createClaudeCommands = (deps: ClaudeDeps & {onProps?: (p: Props) => void}) => {
	const {onProps, ...rest} = deps;
	const sh = shimClaude(rest, onProps ? {onProps} : {});
	return [sh.chat, sh.claude] as const;
};

const readState = async (dir: string) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;

test('missing credential throws before mount', async () => {
	const {command, ctx, mounts} = await setup({deps: {env: {}}});
	await assert.rejects(command.run(['chat'], ctx), /No credentials found\./);
	assert.equal(mounts(), 0);
});

test('missing SDK maps to the friendly error before mount', async () => {
	const {command, ctx, mounts} = await setup({
		deps: {
			loadChatQuery: async () => {
				throw Object.assign(new Error('Cannot find package'), {code: 'ERR_MODULE_NOT_FOUND'});
			},
		},
	});
	await assert.rejects(command.run(['chat'], ctx), {message: 'The Claude Agent SDK is not installed. Run modules/claude/bin/install.'});
	assert.equal(mounts(), 0);
});

test('a missing module that names the SDK keeps the SDK message even when ink is mentioned', async () => {
	const {command, ctx } = await setup({
		deps: {
			loadChatQuery: async () => {
				throw Object.assign(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk' imported from ink-wrapper.ts"), {
					code: 'ERR_MODULE_NOT_FOUND',
				});
			},
		},
	});
	await assert.rejects(command.run(['chat'], ctx), {
		message: 'The Claude Agent SDK is not installed. Run modules/claude/bin/install.',
	});
});

test('mounts once, passes props without the secret, prints the subscription notice once', async () => {
	const s = await setup({run: async () => {}});
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.mounts(), 1);
	assert.equal(s.printed.filter(l => l.startsWith('Notice:')).length, 1);
	assert.equal(JSON.stringify(s.printed).includes(OAUTH), false);
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.printed.filter(l => l.startsWith('Notice:')).length, 1);
});

test('first successful turn persists state; resume and --new', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.q.calls[0]!.options.resume, undefined);
	assert.equal(s.q.calls[0]!.options.includePartialMessages, true);
	assert.equal(s.q.calls[0]!.options.permissionMode, 'default');
	const st = await readState(s.dataDir);
	assert.equal(st.lastSessionId, SID2);
	assert.equal(st.lastModel, 'claude-test-1');

	await s.command.run(['chat'], s.ctx);
	assert.equal(s.props[1]!.initialSessionId, SID2);
	await s.command.run(['chat', '--new'], s.ctx);
	assert.equal(s.props[2]!.initialSessionId, undefined);
});

test('an open chat keeps its state in YENA_STATUS_DIR/<pid> for ./yena kill and removes it when it closes', async () => {
	const statusDir = join(await mkdtemp(join(tmpdir(), 'claude-status-')), 'status');
	const file = join(statusDir, String(process.pid));
	const seen: string[] = [];
	const s = await setup({
		deps: {env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, YENA_STATUS_DIR: statusDir}},
		run: async p => {
			seen.push(await readFile(file, 'utf8'));
			p.controller.subscribe(e => {
				if (e.type === 'state' && e.state === 'running') seen.push(readFileSync(file, 'utf8'));
			});
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
			seen.push(await readFile(file, 'utf8'));
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.deepEqual(seen, ['chat new: idle\n', 'chat new: working\n', 'chat 33333333: idle\n']);
	assert.equal(existsSync(file), false);
});

test('resume uses lastSessionId on the first send', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.q.calls[1]!.options.resume, SID2);
	await s.command.run(['chat', '--new'], s.ctx);
	assert.equal(s.q.calls[2]!.options.resume, undefined);
});

test('a failed first turn still persists the session it created', async () => {
	const s = await setup({
		failFirst: true,
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	const st = await readState(s.dataDir);
	assert.equal(st.lastSessionId, SID2);
	assert.equal(st.lastModel, 'claude-test-1');
});

test('a first turn that hits the usage limit persists the session and the next send reuses the same query', async () => {
	const calls: Array<{options: Record<string, unknown>}> = [];
	let sent = 0;
	const query = ((arg: {prompt: AsyncIterable<unknown>; options: Record<string, unknown>}) => {
		calls.push({options: arg.options});
		const gen = (async function* () {
			for await (const _ of arg.prompt) {
				sent++;
				yield {type: 'system', subtype: 'init', session_id: SID2, model: 'claude-test-1', apiKeySource: 'x'};
				if (sent === 1) {
					yield {
						type: 'rate_limit_event',
						rate_limit_info: {status: 'rejected', rateLimitType: 'five_hour', resetsAt: Date.now() / 1000 + 3600},
					};
					yield {type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: "You've hit your limit"}]}, session_id: SID2};
					yield {type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id: SID2};
				} else {
					yield {type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: SID2};
				}
			}
		})();
		return Object.assign(gen, {interrupt: async () => {}, close: () => {}});
	}) as unknown as ChatQueryFn;
	const outcomes: string[] = [];
	const s = await setup({
		deps: {loadChatQuery: async () => query},
		run: async p => {
			p.controller.subscribe(e => {
				if (e.type === 'turn-end') outcomes.push(e.outcome);
			});
			const first = turnDone(p);
			p.controller.send('first');
			await first;
			assert.equal(p.controller.state, 'idle');
			for (let i = 0; i < 50 && sent === 1; i++) {
				const st = await readState(s.dataDir).catch(() => ({}) as Record<string, unknown>);
				if (st.lastSessionId) break;
				await new Promise(r => setTimeout(r, 5));
			}
			assert.equal((await readState(s.dataDir)).lastSessionId, SID2);
			const second = turnDone(p);
			p.controller.send('second');
			await second;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.deepEqual(outcomes, ['limit', 'ok']);
	assert.equal(calls.length, 1);
	assert.equal(sent, 2);
	assert.equal((await readState(s.dataDir)).lastSessionId, SID2);
});

test('a turn that needs a new session does not write state', async () => {
	const s = await setup({
		failFirst: true,
		failMessage: 'No conversation found with session ID: x',
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal((await readState(s.dataDir)).lastSessionId, undefined);
});

test('flushing closes the session and unregisters', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.q.closed(), 1);
	assert.equal(s.unregistered(), 1);
	assert.equal(s.props[0]!.controller.state, 'closed');
});

test('aborting the lifetime controller closes the session', async () => {
	const s = await setup({
		run: async p => {
			s.aborts[0]!.abort();
			assert.equal(p.controller.state, 'closed');
		},
	});
	await s.command.run(['chat'], s.ctx);
});

test('chat logs its start with labels only, registers the redactor first, and leaks nothing', async () => {
	const log = makeFakeLog();
	const s = await setup({
		deps: {log, env: {ANTHROPIC_API_KEY: KEY}},
		run: async p => {
			const done = turnDone(p);
			p.controller.send('PROMPT-SENTINEL-1');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal(log.trail[0], '<addRedactor>');
	assert.equal(log.redactors.length, 1);
	const find = (m: string) => log.records.find(r => r.msg === m)!;
	assert.deepEqual(find('chat starting').fields, {
		fresh: false,
		kind: 'api-key',
		source: 'env',
		resuming: false,
		model: 'default',
	});
	assert.equal(find('turn ended').fields.outcome, 'ok');
	const out = serialized(log);
	for (const secret of ['PROMPT-SENTINEL-1', KEY, 'sk-ant']) assert.equal(out.includes(secret), false, secret);
});

test('a chat on the env subscription token passes the variable through: no value, no redactor, nothing logged', async () => {
	const log = makeFakeLog();
	const s = await setup({
		deps: {log, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY, PATH: '/bin'}},
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	const env = s.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env.ANTHROPIC_API_KEY, KEY, 'the key comes first in the order');
	const only = await setup({
		deps: {log, env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, PATH: '/bin'}},
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await only.command.run(['chat'], only.ctx);
	const env2 = only.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env2.CLAUDE_CODE_OAUTH_TOKEN, OAUTH, 'kept by name through the chat env scrub');
	assert.equal(env2.ANTHROPIC_API_KEY, undefined);
	assert.equal(only.props.at(-1)!.initialAccount, 'env-token');
});

test('chat with a missing SDK logs an error with missingModule', async () => {
	const log = makeFakeLog();
	const s = await setup({
		deps: {
			log,
			loadChatQuery: async () => {
				throw Object.assign(new Error('Cannot find package claude-agent-sdk'), {code: 'ERR_MODULE_NOT_FOUND'});
			},
		},
	});
	await assert.rejects(async () => s.command.run(['chat'], s.ctx), /not installed/);
	const rec = log.records.find(r => r.level === 'error')!;
	assert.equal(rec.fields.missingModule, true);
});

test('chat builds its options with the chat toolset and a canUseTool, without bypass flags', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	const o = s.q.calls[0]!.options;
	assert.deepEqual(o.tools, CHAT_TOOLS);
	assert.deepEqual(o.disallowedTools, CHAT_DISALLOWED_TOOLS);
	assert.equal(o.permissionMode, 'default');
	assert.equal(typeof o.canUseTool, 'function');
	assert.equal('allowedTools' in o, false);
	assert.equal('allowDangerouslySkipPermissions' in o, false);
	assert.notEqual(o.permissionMode, 'bypassPermissions');
	assert.equal(o.includePartialMessages, true);
});

test('chat passes reveal and the project directory to the view', async () => {
	const s = await setup({
		run: async p => {
			assert.equal(typeof p.reveal, 'function');
			const shown = p.reveal!(`a\u001b[31m b ${OAUTH}`);
			assert.equal(shown.includes('\u001b'), false);
			assert.equal(shown.includes('\\x1b'), true);
			assert.equal(shown.includes(OAUTH), false);
			assert.equal(typeof p.projectDir, 'string');
			assert.equal(p.controller.mode, 'default');
			assert.deepEqual(p.controller.pendingPermissions, []);
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal(s.props.length, 1);
});

test('the chat permission bridge asks through the session instead of allowing silently', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
			const canUseTool = s.q.calls[0]!.options.canUseTool as (
				name: string,
				input: Record<string, unknown>,
				opts: Record<string, unknown>,
			) => Promise<{behavior: string}>;
			const pending = canUseTool('Bash', {command: 'echo hi'}, {signal: new AbortController().signal, toolUseID: 't1', suggestions: []});
			await new Promise(r => setTimeout(r, 20));
			assert.equal(p.controller.pendingPermissions.length, 1);
			assert.equal(p.controller.pendingPermissions[0]!.kind, 'tool');
			p.controller.answerPermission(p.controller.pendingPermissions[0]!.id, {kind: 'allow'});
			assert.equal((await pending).behavior, 'allow');
		},
	});
	await s.command.run(['chat'], s.ctx);
});

test('the shipped bridge gets the real preview and highlight builders', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-wire-'));
	const projectDir = dir;
	await mkdir(join(dir, 'modules', 'claude'), {recursive: true});
	const file = join(projectDir, 'a.txt');
	await writeFile(file, 'one\ntwo\nthree\n');
	let canUse!: (name: string, input: Record<string, unknown>, opts: Record<string, unknown>) => Promise<unknown>;
	const query = ((arg: {prompt: AsyncIterable<unknown>; options: Record<string, unknown>}) => {
		canUse = arg.options.canUseTool as typeof canUse;
		const gen = (async function* () {
			for await (const _ of arg.prompt) {
				yield {type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: SID2};
			}
		})();
		return Object.assign(gen, {close: () => {}, interrupt: async () => {}});
	}) as unknown as ChatQueryFn;
	const s = await setup({
		deps: {
			moduleDir: join(dir, 'modules', 'claude'),
			loadChatQuery: async () => query,
		},
		run: async p => {
			const done = turnDone(p);
			p.controller.send('go');
			await done;
			const opts = (id: string) => ({signal: new AbortController().signal, toolUseID: id, suggestions: []});
			void canUse('Edit', {file_path: file, old_string: 'two', new_string: '2'}, opts('e1'));
			void canUse('Bash', {command: 'rm -rf x'}, opts('b1'));
			await new Promise(r => setTimeout(r, 200));
			const edit = p.controller.pendingPermissions.find(r => r.kind === 'tool' && r.toolName === 'Edit');
			const bash = p.controller.pendingPermissions.find(r => r.kind === 'tool' && r.toolName === 'Bash');
			assert.equal(edit?.kind, 'tool');
			assert.ok(edit.kind === 'tool' && edit.preview && edit.preview.rows.length > 0, 'edit preview rows');
			assert.ok(bash?.kind === 'tool' && bash.highlights.some(h => h.level === 'warn'), 'bash warn highlight');
		},
	});
	await s.command.run(['chat'], s.ctx);
});

const setupChat = async (opts: Parameters<typeof setup>[0] = {}, extra: Partial<Parameters<typeof createClaudeCommands>[0]> = {}) => {
	const s = await setup(opts);
	const shimmed = shimClaude({
		...extra,
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
	}, {onProps: p => s.props.push(p)});
	return {...s, chat: shimmed.chat, shimmed};
};

const sendOnce = async (p: Props) => {
	const done = turnDone(p);
	p.controller.send('hi');
	await done;
};

test('top-level chat starts a fresh chat with the model from the settings', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({lastSessionId: SID1, chatModel: 'opus'}));
	await s.chat.run([], s.ctx);
	assert.equal(s.q.calls[0]!.options.model, 'opus');
	assert.equal(s.q.calls[0]!.options.resume, undefined);
	assert.equal(s.props[0]!.initialModel, 'opus');
});

test('top-level chat takes a model argument that overrides the setting for that chat only', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({chatModel: 'opus'}));
	await s.chat.run(['haiku'], s.ctx);
	assert.equal(s.q.calls[0]!.options.model, 'haiku');
	assert.equal((await readState(s.dataDir)).chatModel, 'opus');
});

test('top-level chat without a setting leaves the model to the account default', async () => {
	const s = await setupChat({run: sendOnce});
	await s.chat.run([], s.ctx);
	assert.equal('model' in s.q.calls[0]!.options, false);
});

test('the Claude settings tab reads and writes the chat model', async () => {
	const s = await setupChat();
	const setting = s.chat.settings!.settings.find(x => x.key === 'chatModel')!;
	assert.equal(await setting.get(), '');
	await setting.set('sonnet');
	assert.equal(await setting.get(), 'sonnet');
	assert.equal((await readState(s.dataDir)).chatModel, 'sonnet');
	await setting.set('');
	assert.equal('chatModel' in (await readState(s.dataDir)), false);
	await assert.rejects(Promise.resolve(setting.set('no spaces allowed')), /Invalid model id/);
	assert.ok(setting.options.some(o => o.value === ''));
});

test('the Claude tab offers router, tiers, model, effort, thinking, fast mode and output style', async () => {
	const s = await setupChat();
	assert.deepEqual(
		s.chat.settings!.settings.map(x => x.key),
		[
			'chatRouter',
			'chatClassifier',
			'tierLightModel',
			'tierLightEffort',
			'tierStandardModel',
			'tierStandardEffort',
			'tierStrongModel',
			'tierStrongEffort',
			'tierMaxModel',
			'tierMaxEffort',
			'chatModel',
			'chatEffort',
			'chatThinking',
			'chatFastMode',
			'chatOutputStyle',
			'chatMcp',
			'chatHooks',
		],
	);
});

test('chat tuning settings are stored, validated and reach new chats', async () => {
	const s = await setupChat({run: sendOnce});
	const by = (k: string) => s.chat.settings!.settings.find(x => x.key === k)!;
	await by('chatEffort').set('high');
	await by('chatThinking').set('disabled');
	await by('chatFastMode').set('on');
	await by('chatOutputStyle').set('Learning');
	await assert.rejects(Promise.resolve(by('chatEffort').set('turbo')), /Unknown option/);
	assert.equal(await by('chatFastMode').get(), 'on');
	assert.deepEqual(await readState(s.dataDir), {
		chatEffort: 'high',
		chatThinking: 'disabled',
		chatFastMode: true,
		chatOutputStyle: 'Learning',
	});
	await s.chat.run([], s.ctx);
	const o = s.q.calls[0]!.options as Record<string, unknown> & {settings: Record<string, unknown>};
	assert.equal(o.effort, 'high');
	assert.deepEqual(o.thinking, {type: 'disabled'});
	assert.equal(o.settings.fastMode, true);
	assert.equal(o.settings.outputStyle, 'Learning');
	assert.ok(Array.isArray((o.settings.permissions as {deny: unknown}).deny));
	await by('chatFastMode').set('');
	assert.equal('chatFastMode' in (await readState(s.dataDir)), false);
});

test('without tuning the chat options keep the Claude Code defaults', async () => {
	const s = await setupChat({run: sendOnce});
	await s.chat.run([], s.ctx);
	const o = s.q.calls[0]!.options;
	assert.equal('effort' in o, false);
	assert.equal('thinking' in o, false);
	assert.equal('fastMode' in (o.settings as object), false);
});

test('chat options carry the SDK permission mode and the policy hook', async () => {
	const s = await setupChat({run: sendOnce});
	await s.chat.run([], s.ctx);
	const o = s.q.calls[0]!.options as {permissionMode?: string; hooks?: {PreToolUse?: unknown[]}};
	assert.equal(o.permissionMode, 'default');
	assert.equal(o.hooks?.PreToolUse?.length, 1);
});

test('the chat is named after the first message, then after the title Claude Code writes', async () => {
	let check!: () => void;
	const checked = new Promise<void>(r => (check = r));
	const s = await setupChat({run: async p => {
		const done = turnDone(p);
		const dir = join(s.dataDir, 'config', 'projects', resolvePaths(s.dataDir).projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
		await mkdir(dir, {recursive: true});
		await writeFile(join(dir, `${SID2}.jsonl`), JSON.stringify({type: 'ai-title', aiTitle: 'Build fix'}) + '\n');
		p.controller.send('fix the build please');
		assert.equal(p.controller.title, 'fix the build please');
		await done;
		await new Promise(r => setTimeout(r, 30));
		assert.equal(p.controller.title, 'Build fix');
		check();
	}});
	await s.chat.run([], s.ctx);
	await checked;
});

const writeTranscript = async (dataDir: string, sessionId: string, rows: unknown[]) => {
	const dir = join(dataDir, 'config', 'projects', resolvePaths(dataDir).projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
	await mkdir(dir, {recursive: true});
	await writeFile(join(dir, `${sessionId}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
};

test('claude new starts a fresh chat', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({lastSessionId: SID1}));
	await s.shimmed.claude.run(['new'], s.ctx);
	assert.equal(s.q.calls[0]!.options.resume, undefined);
	assert.equal(s.props.at(-1)!.initialSessionId, undefined);
});

test('model, effort, thinking, fast mode and output style apply to the open chat at once and to its next query', async () => {
	const applied: Array<[string, unknown]> = [];
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s = await setupChat({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hi');
			await done;
			await gate;
		},
	});
	const base = s.q.query;
	const wrapped = ((arg: never) =>
		Object.assign(base(arg), {
			setModel: async (m?: string) => void applied.push(['model', m]),
			setMaxThinkingTokens: async (n: number | null) => void applied.push(['thinking', n]),
			applyFlagSettings: async (f: Record<string, unknown>) => void applied.push(['flags', f]),
		})) as unknown as ChatQueryFn;
	const [chat] = createClaudeCommands({
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => wrapped,
		onProps: p => s.props.push(p),
	});
	const running = chat!.run([], s.ctx);
	await new Promise(r => setTimeout(r, 40));
	const set = (k: string, v: string) => chat!.settings!.settings.find(x => x.key === k)!.set(v);
	await set('chatModel', 'haiku');
	await set('chatEffort', 'high');
	await set('chatThinking', 'disabled');
	await set('chatFastMode', 'on');
	await set('chatOutputStyle', 'Learning');
	await set('chatEffort', '');
	assert.deepEqual(applied, [
		['model', 'haiku'],
		['flags', {effortLevel: 'high'}],
		['thinking', 0],
		['flags', {fastMode: true}],
		['flags', {outputStyle: 'Learning'}],
		['flags', {effortLevel: null}],
	]);
	release();
	await running;
	await set('chatEffort', 'low');
	assert.equal(applied.length, 6, 'nothing is applied once the chat is closed');
});

test('a chat started in plan mode tells the SDK; saved "always" rules reach the next chat and can be removed', async () => {
	const s = await setupChat({run: sendOnce});
	await s.shimmed.open({fresh: true, mode: 'plan'}, s.ctx);
	assert.equal(s.q.calls[0]!.options.permissionMode, 'plan');
	const [, claude] = createClaudeCommands({
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
	});
	assert.equal(claude!.settings!.settings.some(x => x.key.startsWith('rule:')), false, 'no rule rows without rules');
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s2 = await setupChat({run: () => gate});
	const running = s2.chat.run([], s2.ctx);
	await new Promise(r => setTimeout(r, 20));
	const session = s2.props.at(-1)!.controller as unknown as {remember: (k: string) => void; hasApproved: (k: string) => boolean};
	session.remember('npm test');
	await new Promise(r => setTimeout(r, 30));
	assert.deepEqual((await readState(s2.dataDir)).allowedCommands, ['npm test']);
	release();
	await running;
	const [, claude2] = createClaudeCommands({
		dataDir: s2.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
	});
	await new Promise(r => setTimeout(r, 20));
	const tab = claude2!.settings!;
	assert.equal(tab.title, 'Claude');
	const rule = tab.settings.find(x => x.key.startsWith('rule:'))!;
	assert.equal(rule.label, 'npm test');
	assert.equal(await rule.get(), 'keep');
	await rule.set('remove');
	assert.equal('allowedCommands' in (await readState(s2.dataDir)), false);
	assert.equal(claude2!.settings!.settings.some(x => x.key.startsWith('rule:')), false);
});

const transcriptRows = [
	{type: 'user', uuid: 'u1', parentUuid: null, message: {content: 'first question'}},
	{type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: {id: 'm1', content: [{type: 'text', text: 'first answer'}]}},
	{type: 'user', uuid: 'u2', parentUuid: 'a1', message: {content: 'second question'}},
	{type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: {id: 'm2', content: [{type: 'text', text: 'second answer'}]}},
];

test('chat with a Claude Code login: no credentials in the child env', async () => {
	let runs = 0;
	const s = await setup({
		deps: {env: {PATH: '/bin'}, login: {probe: async () => ({loggedIn: true, method: 'claude.ai', subscriptionType: 'max'})}},
		run: async p => {
			runs++;
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal(runs, 1);
	const env = s.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	assert.equal(s.props.at(-1)!.initialAccount, 'login');
});

const consoleSdkFake = {
	tool: ((name: string) => ({name})) as never,
	createSdkMcpServer: ((o: {name: string}) => ({type: 'sdk', name: o.name})) as never,
	z: {string: () => ({})} as never,
};

for (const withBridge of [true, false]) {
	test(`chat ${withBridge ? 'registers' : 'omits'} the yena console server ${withBridge ? 'when' : 'without'} a command bridge`, async () => {
		const s = await setup({
			deps: {loadConsoleSdk: async () => consoleSdkFake},
			run: async p => {
				const done = turnDone(p);
				p.controller.send('hi');
				await done;
			},
		});
		if (withBridge) s.ctx.commandBridge = {list: () => [], run: async () => ({status: 'ok', output: '', truncated: false, ms: 0})};
		await s.command.run(['chat'], s.ctx);
		const servers = s.q.calls[0]!.options['mcpServers'] as Record<string, unknown>;
		assert.equal('yena' in servers, withBridge);
	});
}

test('the chat child gets the private shell tmp root, and a failure only logs', async () => {
	const log = makeFakeLog();
	const ok = await setup({deps: {shellTmp: () => '/tmp/yena-claude-test', log}, run: async p => {
		const done = turnDone(p);
		p.controller.send('hello');
		await done;
	}});
	await ok.command.run(['chat'], ok.ctx);
	const okEnv = ok.q.calls[0]!.options.env as Record<string, string>;
	assert.equal(okEnv.CLAUDE_CODE_TMPDIR, '/tmp/yena-claude-test');
	assert.equal(okEnv.npm_config_cache, `/tmp/yena-claude-test/claude-${process.getuid?.() ?? 0}/npm-cache`);
	assert.equal(okEnv.NODE_USE_ENV_PROXY, '1');

	const bad = await setup({deps: {shellTmp: () => { throw new Error('nope /private/path'); }, log}, run: async p => {
		const done = turnDone(p);
		p.controller.send('hello');
		await done;
	}});
	await bad.command.run(['chat'], bad.ctx);
	assert.notEqual((bad.q.calls[0]!.options.env as Record<string, string>).CLAUDE_CODE_TMPDIR, '/tmp/yena-claude-test');
	const rec = log.records.find(r => r.msg === 'shell tmp unavailable');
	assert.deepEqual(rec?.fields, {error: 'Error'});
});

test('auth use and auth auto refresh the pin watch of the open chat', async () => {
	let claude: Command | undefined;
	const seen: Array<string | undefined> = [];
	let notified = 0;
	const s = await setupChat({
		run: async p => {
			const pin = p.pin!;
			pin.subscribe(() => notified++);
			seen.push(pin.current());
			await claude!.run(['auth', 'use', 'env-token'], s.ctx);
			seen.push(pin.current());
			await claude!.run(['auth', 'auto'], s.ctx);
			seen.push(pin.current());
		},
	});
	const cmds = createClaudeCommands({
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		onProps: p => s.props.push(p),
	});
	claude = cmds[1]!;
	await cmds[0]!.run([], s.ctx);
	assert.deepEqual(seen, [undefined, 'env-token', undefined]);
	assert.equal(notified, 2);
});

test('claude tier pins the open chat, shows the pin, returns it to the router and is gone after close', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s = await setupChat({run: async p => {
		const done = turnDone(p);
		p.controller.send('hi');
		await done;
		await gate;
	}});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({chatRouter: 'on', chatClassifier: 'off'}));
	const [chat, claude] = createClaudeCommands({
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		onProps: p => s.props.push(p),
	}) as [typeof s.chat, typeof s.chat];
	const running = chat.run([], s.ctx);
	await new Promise(r => setTimeout(r, 60));
	const controller = s.props.at(-1)!.controller;
	await claude.run(['tier', 'MAX'], s.ctx);
	assert.deepEqual(controller.route, {outcome: 'pinned', main: 'max', pinned: 'max'});
	assert.match(s.printed.at(-1)!, /pinned to the max tier until "claude tier auto"/);
	await claude.run(['tier'], s.ctx);
	assert.equal(s.printed.at(-1), 'Pinned to the max tier.');
	await claude.run(['tier', 'auto'], s.ctx);
	assert.equal(controller.route?.pinned, undefined);
	release();
	await running;
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({chatRouter: 'on'}));
	await assert.rejects(async () => claude.run(['tier', 'max'], s.ctx), /No chat is open/);
});

test('a module-origin open without a command bridge never loads the console SDK and runs key-only', async () => {
	let sdkLoads = 0;
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hi');
			await done;
		},
	});
	const shimmed = shimClaude({
		dataDir: s.dataDir,
		loadRetired: async () => undefined,
		login: {probe: async () => undefined},
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH, ANTHROPIC_API_KEY: KEY},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		loadConsoleSdk: async () => {
			sdkLoads++;
			return consoleSdkFake;
		},
	}, {onProps: p => s.props.push(p)});
	await shimmed.open({origin: 'module', fresh: true, attach: false, keep: false}, s.ctx);
	assert.equal(sdkLoads, 0);
	const env = s.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env.ANTHROPIC_API_KEY, KEY);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	assert.equal('yena' in ((s.q.calls[0]!.options['mcpServers'] as Record<string, unknown> | undefined) ?? {}), false);
});
