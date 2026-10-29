import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {CommandContext} from '../../../../src/api.js';
import {CHAT_DISALLOWED_TOOLS, CHAT_TOOLS} from '../../src/policy.js';
import {createClaudeCommand, createClaudeCommands, type ClaudeDeps} from '../../src/commands.js';
import {resolvePaths} from '../../src/config.js';
import {checkCommandDocs} from '../../src/kit.js';
import type {ChatQueryFn, QueryFn} from '../../src/types.js';
import type {ChatUi} from '../../src/chat/command.js';
import {makeFakeLog, serialized} from '../helpers/fake-log.js';

const OAUTH = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const SID1 = '11111111-aaaa-4bbb-8ccc-222222222222';
const SID2 = '33333333-aaaa-4bbb-8ccc-444444444444';

type Props = Parameters<ChatUi['createChatElement']>[0];

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
		login: {probe: async () => undefined},
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
		message: 'The chat interface dependencies (ink, react) are not installed in the yena host. Run "./yena install".',
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

test('an idle open chat does not block ask, and opening another chat replaces it', async () => {
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
	// Not refused: the ask gets as far as the (unused) SDK of this fixture.
	await assert.rejects(s.command.run(['ask', 'x'], s.ctx), (err: Error) => err.message !== 'A chat is already open' && /unused/.test(err.message));
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
	// The banner and notices are styled with SGR sequences; anything else would come from the model name.
	const out = s.printed.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
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

const setupChat = async (opts: Parameters<typeof setup>[0] = {}, extra: Partial<Parameters<typeof createClaudeCommands>[0]> = {}) => {
	const s = await setup(opts);
	const [chat] = createClaudeCommands({
		...extra,
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
	assert.equal(printed.length, 2);
	assert.match(printed[0]!, /╭/);
	assert.equal(printed[1], 'x');
});

test('a new chat opens with the yena banner sized to the view; a resumed one does not', async () => {
	const build = {version: '9.9.9', modules: [{name: 'claude', version: '1.2.3'}]};
	const s = await setupChat({run: async () => {}}, {build});
	const printed: string[] = [];
	const renders: ((width: number) => string)[] = [];
	const host = {isFocused: () => true, columns: () => 60, subscribe: () => () => {}, move: () => false, isHostKey: () => false};
	s.ctx.mount = async mount => {
		mount({
			close: () => {},
			print: (t, o) => {
				printed.push(t);
				// The banner renders plain text.
				if (o?.render) renders.push(o.render as (width: number) => string);
			},
			host,
		});
	};
	await s.chat.run([], s.ctx);
	const banner = printed.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
	assert.match(banner, /yena 9\.9\.9/);
	assert.match(banner, /claude 1\.2\.3/);
	assert.ok(banner.split('\n').every(row => row.length <= 60));
	// The transcript lays the banner out again for a new width.
	assert.equal(renders.length, 1);
	const narrow = renders[0]!(30).replace(/\x1b\[[0-9;]*m/g, '').split('\n');
	assert.ok(narrow.every(row => row.length === 30));
	assert.notEqual(renders[0]!(30), renders[0]!(60));

	printed.length = 0;
	await writeTranscript(s.dataDir, SID1, [{type: 'user', message: {content: 'old question'}}]);
	await claudeWithPicker(s).run(['resume', SID1.slice(0, 6)], s.ctx);
	assert.match(printed.join('\n'), /old question/);
	assert.doesNotMatch(printed.join('\n'), /╭|yena /);
});

test('the Claude tab offers permission mode, model, effort, thinking, fast mode and output style', async () => {
	const s = await setupChat();
	assert.deepEqual(
		s.chat.settings!.settings.map(x => x.key),
		['chatPermissionMode', 'chatModel', 'chatEffort', 'chatThinking', 'chatFastMode', 'chatOutputStyle', 'chatMcp', 'chatHooks', 'chatKeepRunning', 'chatInputMode'],
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
	const [chat, claude] = createClaudeCommands({
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
	const [, claude] = createClaudeCommands({
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

test('Claude Code commands with free-text hints and long descriptions still pass the documentation check', async () => {
	const s = await setupChat();
	await mkdir(join(s.dataDir, 'config', 'commands'), {recursive: true});
	await writeFile(join(s.dataDir, 'config', 'commands', 'review.md'), `---\ndescription: ${'Review the change carefully. '.repeat(6)}\nargument-hint: [--strict] pr number\n---\nbody`);
	await writeFile(join(s.dataDir, 'config', 'commands', 'fixit.md'), '---\ndescription: Fix it.\nargument-hint: <issue> [note…]\n---\nbody');
	await writeFile(join(s.dataDir, 'config', 'commands', 'help.md'), '---\ndescription: Not core help\n---\nbody');
	const [, claude] = createClaudeCommands({dataDir: s.dataDir, env: {}, loadQuery: async () => (() => []) as unknown as QueryFn});
	const subs = claude!.subcommands!;
	const review = subs.find(x => x.name === 'review')!;
	assert.equal(review.usage, 'claude review [args…]');
	assert.match(review.args![0]!.description, /\[--strict\] pr number/);
	assert.ok(review.description.length <= 90 && !review.description.endsWith('.'));
	const fixit = subs.find(x => x.name === 'fixit')!;
	assert.equal(fixit.usage, 'claude fixit <issue> [note…]');
	assert.deepEqual(fixit.args!.map(a => a.name), ['issue', 'note']);
	assert.equal(fixit.description, 'Claude Code: Fix it');
	assert.equal(subs.some(x => x.name === 'help'), false);
	assert.deepEqual(checkCommandDocs(claude!), []);
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

const claudeWithPicker = (s: Awaited<ReturnType<typeof setupChat>>, pick?: (p: {items: {id: string; label: string}[]; onPick: (id: string) => void; close: () => void}) => void) =>
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
	})[1]!;

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
		assert.deepEqual(p.items.map(x => x.id), [SID1]);
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
	const [chat] = createClaudeCommands({
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

test('a chat started in plan mode tells the SDK; saved "always" rules reach the next chat and can be removed', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({chatPermissionMode: 'plan'}));
	await s.chat.run([], s.ctx);
	assert.equal(s.q.calls[0]!.options.permissionMode, 'plan');
	const [, claude] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
	});
	assert.equal(claude!.settings, undefined, 'no Permissions tab without rules');
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
	assert.equal(tab.title, 'Permissions');
	assert.equal(tab.settings[0]!.label, 'npm test');
	assert.equal(await tab.settings[0]!.get(), 'keep');
	await tab.settings[0]!.set('remove');
	assert.equal('allowedCommands' in (await readState(s2.dataDir)), false);
	assert.equal(claude2!.settings, undefined);
});

const transcriptRows = [
	{type: 'user', uuid: 'u1', parentUuid: null, message: {content: 'first question'}},
	{type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: {id: 'm1', content: [{type: 'text', text: 'first answer'}]}},
	{type: 'user', uuid: 'u2', parentUuid: 'a1', message: {content: 'second question'}},
	{type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: {id: 'm2', content: [{type: 'text', text: 'second answer'}]}},
];

test('claude rename, export and copy work on the last chat', async () => {
	const s = await setupChat();
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({lastSessionId: SID1}));
	await writeTranscript(s.dataDir, SID1, transcriptRows);
	const claude = claudeWithPicker(s);
	await claude.run(['rename', 'My', 'chat'], s.ctx);
	assert.ok(s.printed.includes('Renamed the chat to "My chat"'));
	await assert.rejects(async () => claude.run(['rename'], s.ctx), /Usage: claude rename/);
	await claude.run(['export'], s.ctx);
	const exported = s.printed.at(-1)!.replace(/^Exported 4 messages to /, '');
	const md = await readFile(exported, 'utf8');
	assert.match(md, /^# My chat/);
	assert.match(md, /## You\n\nfirst question/);
	assert.match(md, /## yena\n\nsecond answer/);
	await assert.rejects(async () => claude.run(['export', '/etc/x.md'], s.ctx), /inside the project or the claude data directory/);
	const copied: string[] = [];
	s.ctx.copyToClipboard = t => (copied.push(t), true);
	await claude.run(['copy'], s.ctx);
	await claude.run(['copy', '2'], s.ctx);
	assert.deepEqual(copied, ['second answer', 'first answer']);
	await assert.rejects(async () => claude.run(['copy', '3'], s.ctx), /only 2 answers/);
});

test('claude fork opens a branch of the current chat with its history', async () => {
	const s = await setupChat({run: sendOnce});
	await writeFile(join(s.dataDir, 'state.json'), JSON.stringify({lastSessionId: SID1}));
	await writeTranscript(s.dataDir, SID1, transcriptRows);
	const claude = claudeWithPicker(s);
	await claude.run(['fork'], s.ctx);
	const o = s.q.calls[0]!.options;
	assert.equal(o.resume, SID1);
	assert.equal(o.forkSession, true);
	assert.equal(o.enableFileCheckpointing, true);
});

test('claude rewind restores files and reopens the chat before the picked message, with it in the input', async () => {
	const s = await setupChat();
	const rewound: string[] = [];
	const base = s.q.query;
	const query = ((arg: never) =>
		Object.assign(base(arg), {rewindFiles: async (id: string) => (rewound.push(id), {canRewind: true, filesChanged: ['a.ts']})})) as unknown as ChatQueryFn;
	const printed: string[] = [];
	const [chat, claude] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => query,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
			createPickerElement: p => {
				assert.deepEqual(p.items.map(i => i.id), ['u2', 'u1']);
				p.onPick('u2');
				p.close();
				return {};
			},
		}),
	}) as [typeof s.chat, typeof s.chat];
	s.ctx.print = t => printed.push(t);
	let mounts = 0;
	s.ctx.mount = async (build, options) => {
		if (options?.target === 'panel') {
			build({close: () => {}});
			return;
		}
		mounts++;
		let close!: () => void;
		const closed = new Promise<void>(r => (close = r));
		build({close});
		const p = s.props.at(-1)!;
		const done = turnDone(p);
		p.controller.send(mounts === 1 ? 'hi' : 'again');
		await done;
		if (mounts === 1) await closed;
	};
	const running = chat.run([], s.ctx);
	await new Promise(r => setTimeout(r, 40));
	await writeTranscript(s.dataDir, SID2, transcriptRows);
	await claude.run(['rewind'], s.ctx);
	await running;
	assert.deepEqual(rewound, ['u2']);
	assert.ok(printed.some(p => p.startsWith('Rewound: files restored (1 changed)')));
	assert.equal(s.props.at(-1)!.initialDraft, 'second question');
	const o = s.q.calls.at(-1)!.options;
	assert.equal(o.resume, SID2);
	assert.equal(o.forkSession, true);
	assert.equal(o.resumeSessionAt, 'a1');
});

test('claude tasks lists the chat tasks and stops the picked running one; claude mcp shows server status', async () => {
	let release!: () => void;
	const gate = new Promise<void>(r => (release = r));
	const s = await setupChat({run: async p => {
		const done = turnDone(p);
		p.controller.send('hi');
		await done;
		await gate;
	}});
	const stopped: string[] = [];
	const base = s.q.query;
	const query = ((arg: never) =>
		Object.assign(base(arg), {
			stopTask: async (id: string) => void stopped.push(id),
			mcpServerStatus: async () => [{name: 'github', status: 'connected'}, {name: 'db', status: 'failed', error: 'no socket'}],
		})) as unknown as ChatQueryFn;
	const [chat, claude] = createClaudeCommands({
		dataDir: s.dataDir,
		env: {CLAUDE_CODE_OAUTH_TOKEN: OAUTH},
		loadQuery: async () => (() => {
			throw new Error('unused');
		}) as unknown as QueryFn,
		loadChatQuery: async () => query,
		loadUi: async () => ({
			createChatElement: p => {
				s.props.push(p);
				return {};
			},
			createPickerElement: p => {
				assert.deepEqual(p.items.map(i => i.id), ['t1']);
				p.onPick('t1');
				p.close();
				return {};
			},
		}),
	}) as [typeof s.chat, typeof s.chat];
	await assert.rejects(async () => claude.run(['tasks'], s.ctx), /No chat is open/);
	const running = chat.run([], s.ctx);
	await new Promise(r => setTimeout(r, 40));
	const session = s.props.at(-1)!.controller as unknown as {_tasks: Map<string, unknown>};
	session._tasks.set('t1', {id: 't1', status: 'running', description: 'watch', background: true, startedAt: Date.now()});
	const chatMount = s.ctx.mount;
	s.ctx.mount = async build => void build({close: () => {}});
	await claude.run(['tasks'], s.ctx);
	s.ctx.mount = chatMount;
	assert.deepEqual(stopped, ['t1']);
	await claude.run(['mcp'], s.ctx);
	assert.ok(s.printed.includes('github: connected'));
	assert.ok(s.printed.includes('db: failed (no socket)'));
	release();
	await running;
});

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
	// The login Claude Code keeps in its config dir; yena takes it as an account.
	await mkdir(join(s.dataDir, 'config'), {recursive: true});
	await writeFile(join(s.dataDir, 'config', '.credentials.json'), JSON.stringify({claudeAiOauth: {accessToken: 'A', refreshToken: 'R'}}));
	await s.command.run(['chat'], s.ctx);
	assert.equal(runs, 1);
	const env = s.q.calls[0]!.options.env as Record<string, string | undefined>;
	assert.equal(env.ANTHROPIC_API_KEY, undefined);
	assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
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
	assert.equal((ok.q.calls[0]!.options.env as Record<string, string>).CLAUDE_CODE_TMPDIR, '/tmp/yena-claude-test');

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

test('claude start opens a new chat that sends the message and returns while the chat stays open', async () => {
	let release!: () => void;
	const hold = new Promise<void>(resolve => {
		release = resolve;
	});
	const s = await setup({run: () => hold});
	await s.command.run(['start', 'hello', 'there'], s.ctx);
	assert.equal(s.props.at(-1)!.initialSend, 'hello there');
	assert.ok(s.printed.includes('Started a new chat with the message.'));
	// An assistant or the scheduler (a context with a signal) needs the chat's own view.
	const s2 = await setup();
	const agent: CommandContext = {print: () => {}, clear: () => {}, exit: () => {}, signal: new AbortController().signal};
	await assert.rejects(s2.command.run(['start', 'x'], agent), /No chat view is available/);
	await assert.rejects(s2.command.run(['start'], s2.ctx), /Usage: claude start <message…>/);
	release();
});

test('claude send hands the message to the open chat view, or starts a chat when none is open', async () => {
	let release!: () => void;
	const hold = new Promise<void>(resolve => {
		release = resolve;
	});
	const s = await setup({run: () => hold});
	await s.command.run(['send', 'first'], s.ctx);
	assert.equal(s.props.at(-1)!.initialSend, 'first');
	assert.ok(s.printed.includes('Started a new chat with the message.'));
	const got: string[] = [];
	s.props.at(-1)!.onInbox!(text => void got.push(text));
	await s.command.run(['send', 'talk', 'about', 'TECH-1'], s.ctx);
	assert.deepEqual(got, ['talk about TECH-1']);
	assert.ok(s.printed.includes('Sent the message to the open chat.'));
	s.props.at(-1)!.onInbox!(() => {
		throw new Error('Wait for the answer or press Esc to interrupt');
	});
	await assert.rejects(s.command.run(['send', 'x'], s.ctx), /Wait for the answer/);
	await assert.rejects(s.command.run(['send'], s.ctx), /Usage: claude send <message…>/);
	release();
});
