import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {CommandContext} from '../../../../src/api.js';
import {CHAT_DISALLOWED_TOOLS, CHAT_TOOLS} from '../../src/policy.js';
import {createClaudeCommand, createClaudeCommands, type ClaudeDeps} from '../../src/commands.js';
import {resolvePaths} from '../../src/config.js';
import type {ChatQueryFn, QueryFn} from '../../src/types.js';
import type {ChatUi} from '../../src/chat/command.js';
import {makeFakeLog, serialized} from '../helpers/fake-log.js';

const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const SID1 = '11111111-aaaa-4bbb-8ccc-222222222222';
const SID2 = '33333333-aaaa-4bbb-8ccc-444444444444';

type Props = Parameters<ChatUi['createChatElement']>[0];

const makeChatQuery = (failFirst = false) => {
	const calls: Array<{options: Record<string, unknown>}> = [];
	let closed = 0;
	const query = ((arg: {prompt: AsyncIterable<unknown>; options: Record<string, unknown>}) => {
		calls.push({options: arg.options});
		const gen = (async function* () {
			for await (const _ of arg.prompt) {
				yield {type: 'system', subtype: 'init', session_id: SID2, model: 'claude-test-1', apiKeySource: 'x'};
				if (failFirst) {
					yield {type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: SID2};
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

const setup = async (opts: {mount?: boolean; failFirst?: boolean; run?: (p: Props) => Promise<void>; deps?: Partial<ClaudeDeps>} = {}) => {
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
	const q = makeChatQuery(opts.failFirst);
	const aborts: AbortController[] = [];
	let unregistered = 0;
	const real = createClaudeCommand({
		dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => q.query,
		loadUi: async () => ({
			createChatElement: p => {
				props.push(p);
				return {};
			},
		}),
		registerAbort: c => {
			aborts.push(c);
			return () => void unregistered++;
		},
		...opts.deps,
	});
	const command = {run: async (args: string[], c: CommandContext) => real.run(args, c)};
	return {command, dataDir, printed, ctx, q, props, aborts, mounts: () => mounts, unregistered: () => unregistered};
};

const readState = async (dir: string) => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;

test('chat without mount throws', async () => {
	const {command, ctx} = await setup({mount: false});
	await assert.rejects(command.run(['chat'], ctx), {message: '"claude chat" needs an interface that can show views'});
});

test('chat rejects unknown arguments', async () => {
	const {command, ctx, mounts} = await setup();
	await assert.rejects(command.run(['chat', '--bogus'], ctx), {message: 'Usage: claude chat [--new]'});
	await assert.rejects(command.run(['chat', 'text'], ctx), {message: 'Usage: claude chat [--new]'});
	assert.equal(mounts(), 0);
});

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

test('missing ink or react maps to the host dependency error before mount', async () => {
	const {command, ctx, mounts} = await setup({
		deps: {
			loadUi: async () => {
				throw Object.assign(new Error("Cannot find package 'ink' imported from /app/modules/claude/src/ui/ChatView.tsx"), {
					code: 'ERR_MODULE_NOT_FOUND',
				});
			},
		},
	});
	await assert.rejects(command.run(['chat'], ctx), {
		message: 'The chat interface dependencies (ink, react) are not installed in the yena host. Run "make install".',
	});
	assert.equal(mounts(), 0);
});

test('a missing module that names the SDK keeps the SDK message even when ink is mentioned', async () => {
	const {command, ctx } = await setup({
		deps: {
			loadUi: async () => {
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
	const s = await setup({run: async p => assert.equal(p.credentialLabel, 'subscription token')});
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

test('a failed first turn does not write state', async () => {
	const s = await setup({
		failFirst: true,
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	await s.command.run(['chat'], s.ctx);
	assert.equal((await readState(s.dataDir)).lastSessionId, undefined);
});

test('finally closes the session, unregisters, and prints the closing line', async () => {
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
	assert.equal(s.printed.at(-1), '[chat closed · session 33333333 · model claude-test-1]');
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

test('an open chat blocks ask, and opening another chat replaces it', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	let closes = 0;
	const s = await setup({run: () => gate});
	s.ctx.mount = async build => {
		build({
			close: () => {
				closes++;
				release();
			},
		});
		await gate;
	};
	const running = s.command.run(['chat'], s.ctx);
	await new Promise(r => setTimeout(r, 20));
	await assert.rejects(s.command.run(['ask', 'x'], s.ctx), {message: 'A chat is already open'});
	const second = s.command.run(['chat'], s.ctx);
	await running;
	await second;
	assert.equal(closes, 1);
});

test('closing line carries no control bytes or secret from the model name', async () => {
	const s = await setup({
		run: async p => {
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	});
	const evil = `m\x1b]0;x\x07\x1b]52;c;QUJD\x07${OAUTH}`;
	const q = ((arg: {prompt: AsyncIterable<unknown>}) =>
		Object.assign(
			(async function* () {
				for await (const _ of arg.prompt) {
					yield {type: 'system', subtype: 'init', session_id: SID2, model: evil, apiKeySource: 'x'};
					yield {type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: SID2};
				}
			})(),
			{close: () => {}},
		)) as unknown as ChatQueryFn;
	const cmd = createClaudeCommand({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => q,
		loadUi: async () => ({createChatElement: p => (s.props.push(p), {})}),
	});
	const ctx: CommandContext = {
		print: t => s.printed.push(t),
		clear: () => {},
		exit: () => {},
		mount: async build => {
			build({close: () => {}});
			const p = s.props.at(-1)!;
			const done = turnDone(p);
			p.controller.send('hello');
			await done;
		},
	};
	await cmd.run(['chat'], ctx);
	const out = s.printed.join('\n');
	assert.equal(/[\x1b\x07]/.test(out), false);
	assert.equal(out.includes(OAUTH), false);
	assert.ok(s.printed.at(-1)!.startsWith('[chat closed'));
});

test('chat logs start and close with labels only, registers the redactor first, and leaks nothing', async () => {
	const log = makeFakeLog();
	const s = await setup({
		deps: {log},
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
		kind: 'oauth',
		source: 'env',
		resuming: false,
		model: 'default',
	});
	assert.equal(find('turn ended').fields.outcome, 'ok');
	const closed = find('chat closed');
	assert.equal(closed.level, 'info');
	assert.equal(closed.fields.session8, SID2.slice(0, 8));
	assert.equal(closed.fields.model, 'claude-test-1');
	const out = serialized(log);
	for (const secret of ['PROMPT-SENTINEL-1', OAUTH, 'sk-ant']) assert.equal(out.includes(secret), false, secret);
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

const setupChat = async (opts: Parameters<typeof setup>[0] = {}) => {
	const s = await setup(opts);
	const [, chat] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
		}),
	});
	return {...s, chat: chat!};
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

test('top-level chat rejects bad model ids and extra arguments before mounting', async () => {
	const s = await setupChat();
	await assert.rejects(async () => s.chat.run(['bad model\x1b'], s.ctx), /Invalid model/);
	await assert.rejects(async () => s.chat.run(['a', 'b'], s.ctx), {message: 'Usage: chat [model]'});
	assert.equal(s.mounts(), 0);
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

test('the chat view gets the host and the print of the mount control', async () => {
	const s = await setupChat();
	const printed: string[] = [];
	const host = {
		isFocused: () => true,
		columns: () => 40,
		subscribe: () => () => {},
		move: () => false,
		isHostKey: () => false,
	};
	s.ctx.mount = async build => {
		build({close: () => {}, print: t => printed.push(t), host});
	};
	await s.chat.run([], s.ctx);
	assert.equal(s.props[0]!.host, host);
	s.props[0]!.print('x');
	assert.deepEqual(printed, ['x']);
});

test('the Claude tab offers permission mode, model, effort, thinking, fast mode and output style', async () => {
	const s = await setupChat();
	assert.deepEqual(
		s.chat.settings!.settings.map(x => x.key),
		['chatPermissionMode', 'chatModel', 'chatEffort', 'chatThinking', 'chatFastMode', 'chatOutputStyle'],
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

test('the permission mode setting starts new chats in that mode and switches the open chat at once', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s = await setupChat({run: () => gate});
	const mode = s.chat.settings!.settings.find(x => x.key === 'chatPermissionMode')!;
	await mode.set('acceptEdits');
	assert.equal((await readState(s.dataDir)).chatPermissionMode, 'acceptEdits');
	const running = s.chat.run([], s.ctx);
	await new Promise(r => setTimeout(r, 20));
	const controller = s.props[0]!.controller;
	assert.equal(controller.mode, 'acceptEdits');
	await mode.set('auto');
	assert.equal(controller.mode, 'auto');
	await mode.set('');
	assert.equal(controller.mode, 'default');
	assert.equal('chatPermissionMode' in (await readState(s.dataDir)), false);
	await assert.rejects(Promise.resolve(mode.set('bypassPermissions')), /Unknown option/);
	release();
	await running;
	await mode.set('auto');
});

test('claude <command> runs a Claude Code command in the open chat', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s = await setupChat({run: () => gate});
	const [claude, chat] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
		}),
	});
	const running = chat!.run([], s.ctx);
	await new Promise(r => setTimeout(r, 20));
	const props = s.props.at(-1)!;
	const sent: string[] = [];
	props.controller.subscribe(e => {
		if (e.type === 'sent') sent.push(e.text);
	});
	const done = turnDone(props);
	await claude!.run(['compact', 'keep', 'the', 'plan'], s.ctx);
	await done;
	assert.deepEqual(sent, ['/compact keep the plan']);
	assert.ok(s.printed.includes('Sent /compact to the chat'));
	release();
	await running;
	await assert.rejects(async () => claude!.run(['compact'], s.ctx), /No chat is open/);
});

test('claude hints list Claude Code commands from the session, or from the config dir before one starts', async () => {
	const s = await setupChat();
	await mkdir(join(s.dataDir, 'config', 'commands'), {recursive: true});
	await writeFile(join(s.dataDir, 'config', 'commands', 'pipeline.md'), '---\ndescription: Run the pipeline\nargument-hint: <request>\n---\nbody');
	await mkdir(join(s.dataDir, 'config', 'skills', 'deploy'), {recursive: true});
	await writeFile(join(s.dataDir, 'config', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy it\n---\n');
	const [claude] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
	});
	const subs = claude!.subcommands!;
	assert.ok(subs.some(x => x.name === 'ping'));
	const pipeline = subs.find(x => x.name === 'pipeline')!;
	assert.equal(pipeline.usage, 'claude pipeline <request>');
	assert.match(pipeline.description, /Run the pipeline/);
	assert.ok(subs.some(x => x.name === 'deploy'));
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

const claudeWithPicker = (s: Awaited<ReturnType<typeof setupChat>>, pick?: (p: {sessions: {sessionId: string}[]; onPick: (id: string) => void; close: () => void}) => void) =>
	createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => s.q.query,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
			createPickerElement: p => {
				pick?.(p);
				return {};
			},
		}),
	})[0]!;

test('claude resume <id> continues that session and shows its earlier messages', async () => {
	const printed: string[] = [];
	const s = await setupChat({run: async () => {}});
	await writeTranscript(s.dataDir, SID1, [
		{type: 'user', message: {content: 'old question'}},
		{type: 'assistant', message: {id: 'a', content: [{type: 'text', text: 'old answer'}]}},
	]);
	s.ctx.mount = async build => {
		build({close: () => {}, print: t => printed.push(t)});
		await new Promise(r => setTimeout(r, 30));
	};
	const claude = claudeWithPicker(s);
	await claude.run(['resume', SID1.slice(0, 6)], s.ctx);
	assert.equal(s.props.at(-1)!.initialSessionId, SID1);
	const joined = printed.join('\n');
	assert.match(joined, /old question/);
	assert.match(joined, /old answer/);
	assert.match(joined, /Resumed/);
	await assert.rejects(async () => claude.run(['resume', 'ffff'], s.ctx), /No earlier chat matches "ffff"/);
	await assert.rejects(async () => claude.run(['resume', 'a', 'b'], s.ctx), {message: 'Usage: claude resume [session]'});
});

test('claude resume without an id opens the picker in the console and resumes the pick', async () => {
	const s = await setupChat({run: async () => {}});
	await writeTranscript(s.dataDir, SID1, [{type: 'user', message: {content: 'first'}}]);
	const targets: unknown[] = [];
	s.ctx.mount = async (build, options) => {
		targets.push(options?.target ?? 'main');
		build({close: () => {}});
	};
	const claude = claudeWithPicker(s, p => {
		assert.deepEqual(p.sessions.map(x => x.sessionId), [SID1]);
		p.onPick(SID1);
		p.close();
	});
	await claude.run(['resume'], s.ctx);
	assert.deepEqual(targets, ['panel', 'main']);
	assert.equal(s.props.at(-1)!.initialSessionId, SID1);
});

test('claude new starts a fresh chat', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({lastSessionId: SID1}));
	const claude = claudeWithPicker(s);
	await claude.run(['new'], s.ctx);
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
	const [, chat] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => wrapped,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
		}),
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
