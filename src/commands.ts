import {constants} from 'node:fs';
import {lstat, open, realpath, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {Command, CommandContext, Logger, Subcommand} from '../../../src/api.js';
import {chatSettings, tuningFromState, type LivePatch} from './chat-prefs.js';
import {isCommandName, type ChatSession, type SlashCommandInfo} from './chat/chat-session.js';
import {diskCommands} from './disk-commands.js';
import {listSessions} from './chat/history.js';
import {buildEnv, buildOptions, resolvePaths, runtimeInfo} from './config.js';
import {
	describeCredential,
	inspectFileMode,
	isSubscription,
	makeRedactor,
	registerLogRedaction,
	removeStored,
	requireCredential,
	resolveCredential,
	storeApiKey,
} from './credentials.js';
import {clip, errClass, noopLog} from './log.js';
import {openChat, runChat, type ChatRunDeps, type ChatUi} from './chat/command.js';
import {makeScrub} from './chat/scrub.js';
import {runTurn} from './session.js';
import {createStore, isModelId} from './store.js';
import type {ChatQueryFn, Credential, CredentialInfo, QueryFn} from './types.js';

export type ClaudeDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	loadQuery: () => Promise<QueryFn>;
	loadChatQuery?: () => Promise<ChatQueryFn>;
	loadUi?: () => Promise<ChatUi>;
	moduleDir?: string;
	log?: Logger;
	timeoutMs?: number;
	registerAbort?: (c: AbortController) => () => void;
};

const USAGE = 'Usage: claude <ping|ask|chat|new|resume|session|auth|<Claude Code command>>';
const RESUME_USAGE = 'Usage: claude resume [session]';
const NO_CHAT = 'No chat is open. Claude Code commands run in the open chat; start one with "chat".';
const ASK_USAGE = 'Usage: claude ask [--new] <text>';
const AUTH_USAGE = 'Usage: claude auth <status|key|logout|login>';
const KEY_USAGE = 'Usage: claude auth key --from-file <path>';
const CHAT_NEW_USAGE = 'Usage: chat [model]';
const MAX_KEY_FILE_BYTES = 4096;

export {MODEL_OPTIONS} from './chat-prefs.js';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SUBSCRIPTION_NOTICE =
	"Notice: you are using a Claude subscription token (OAuth). Anthropic's terms say third-party products built on the Agent SDK may not offer claude.ai login. This is a personal tool and use of your own subscription was approved by you; see README \"Policy caveat\". Prefer ANTHROPIC_API_KEY.";

const kindLabel = (info: CredentialInfo): string => (isSubscription(info) ? 'subscription token' : 'API key');

const isMissingModule = (err: unknown): boolean => {
	const code = (err as {code?: unknown} | null)?.code;
	return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
};

const readKeyFile = async (rawPath: string): Promise<string> => {
	const requested = resolve(process.cwd(), rawPath);
	let real: string;
	try {
		const link = await lstat(requested);
		real = link.isSymbolicLink() ? await realpath(requested) : requested;
		if (!(await stat(real)).isFile()) throw new Error('not a regular file');
	} catch (err) {
		if (err instanceof Error && err.message === 'not a regular file') {
			throw new Error(`"${rawPath}" is not a regular file`);
		}
		throw new Error(`Cannot read "${rawPath}": file not found or not accessible`);
	}
	// O_NONBLOCK so a file swapped for a fifo after the check cannot hang the UI
	const handle = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`"${rawPath}" is not a regular file`);
		if (info.size > MAX_KEY_FILE_BYTES) {
			throw new Error(`"${rawPath}" is larger than ${MAX_KEY_FILE_BYTES} bytes; an API key file must be small`);
		}
		const buf = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
		const {bytesRead} = await handle.read(buf, 0, buf.length, 0);
		if (bytesRead > MAX_KEY_FILE_BYTES) throw new Error(`"${rawPath}" is larger than ${MAX_KEY_FILE_BYTES} bytes`);
		return buf.toString('utf8', 0, bytesRead).replace(/[ \n\r]/g, '');
	} finally {
		await handle.close();
	}
};

export const createClaudeCommand = (deps: ClaudeDeps): Command => createClaudeCommands(deps)[0]!;

/** The `claude` command and the top-level `chat` command, sharing one chat slot. */
export const createClaudeCommands = (deps: ClaudeDeps): Command[] => {
	const {dataDir, env} = deps;
	const log = deps.log ?? noopLog;
	const store = createStore(dataDir, log);
	let busy: 'ask' | 'chat' | undefined;

	const showNoticeOnce = async (cred: CredentialInfo, ctx: CommandContext): Promise<void> => {
		if (!isSubscription(cred)) return;
		if ((await store.read()).subscriptionNoticeShown) return;
		ctx.print(SUBSCRIPTION_NOTICE);
		await store.update({subscriptionNoticeShown: true});
	};

	const ask = async (args: string[], ctx: CommandContext): Promise<void> => {
		let fresh = false;
		let i = 0;
		for (; i < args.length; i++) {
			const a = args[i]!;
			if (a === '--') {
				i++;
				break;
			}
			if (a === '--new') fresh = true;
			else if (a.startsWith('--')) throw new Error(`Unknown option "${a}". Use "--" before text that starts with "--". ${ASK_USAGE}`);
			else break;
		}
		const text = args.slice(i).join(' ').trim();
		if (!text) throw new Error(ASK_USAGE);
		if (text.startsWith('/')) throw new Error('Slash commands are not supported in "claude ask"');
		if (busy === 'ask') throw new Error('An ask is already running');
		if (busy === 'chat') throw new Error('A chat is already open');
		busy = 'ask';
		try {
			await runAsk(text, fresh, ctx);
		} finally {
			busy = undefined;
		}
	};

	const runAsk = async (text: string, fresh: boolean, ctx: CommandContext): Promise<void> => {
		let cred: Credential;
		try {
			cred = await requireCredential({env, dataDir});
		} catch (err) {
			log.warn('no credential');
			throw err;
		}
		registerLogRedaction(log, cred);
		log.info('credential resolved', {kind: cred.kind, source: cred.source});
		const redact = makeRedactor(cred);
		const scrub = makeScrub(redact);
		await showNoticeOnce(cred, ctx);
		ctx.print('Asking Claude…');
		log.info('ask started', {fresh, promptChars: text.length});

		let query: QueryFn;
		try {
			query = await deps.loadQuery();
		} catch (err) {
			const reason = scrub(err instanceof Error ? err.message : String(err));
			if (isMissingModule(err)) {
				log.error('sdk load failed', {missingModule: true, err: clip(reason)});
				throw new Error('The Claude Agent SDK is not installed. Run modules/claude/bin/install.');
			}
			log.error('sdk load failed', {missingModule: false, err: clip(reason)});
			throw new Error(`Claude request failed: ${reason}`);
		}

		const state = await store.read();
		const controller = new AbortController();
		const unregister = deps.registerAbort?.(controller);
		const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			log.warn('ask timed out', {timeoutMs});
			controller.abort();
		}, timeoutMs);
		timer.unref();
		const startedAt = Date.now();

		try {
			const paths = resolvePaths(dataDir, deps.moduleDir);
			const resume = fresh ? undefined : state.lastSessionId;
			const options = buildOptions({paths, cred, abortController: controller, resume, env: buildEnv(env, paths, cred)});
			let result;
			try {
				result = await runTurn({query, prompt: text, options, signal: controller.signal, redact, log});
			} catch (err) {
				const failure = timedOut ? new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`) : err;
				log.warn('ask failed', {
					outcome: timedOut ? 'timeout' : 'error',
					ms: Date.now() - startedAt,
					errClass: errClass(failure),
					reason: clip(scrub(failure instanceof Error ? failure.message : String(failure))),
				});
				throw failure;
			}
			await store.update({lastSessionId: result.sessionId, ...(result.model && {lastModel: result.model})});
			ctx.print(scrub(result.text));
			const model = result.model ?? 'unknown';
			ctx.print(scrub(`[session ${result.sessionId.slice(0, 8)} · model ${model} · ${kindLabel(cred)}]`));
			log.info('ask finished', {
				outcome: 'ok',
				ms: Date.now() - startedAt,
				model,
				numTurns: result.numTurns,
				session8: result.sessionId.slice(0, 8),
			});
		} finally {
			clearTimeout(timer);
			unregister?.();
		}
	};

	const unavailable = async (): Promise<never> => {
		throw new Error('The chat is not available in this build');
	};

	const chatDeps = (onMount: (close: () => void) => void): ChatRunDeps => ({
		dataDir,
		env,
		moduleDir: deps.moduleDir,
		log,
		loadChatQuery: deps.loadChatQuery ?? unavailable,
		loadUi: deps.loadUi ?? unavailable,
		registerAbort: deps.registerAbort,
		store,
		showNoticeOnce,
		kindLabel,
		isMissingModule,
		onMount,
		onSession: s => {
			openSession = s;
		},
		onLive: apply => {
			applyOpenChat = apply;
		},
		acquire: () => {
			if (busy === 'ask') throw new Error('An ask is already running');
			if (busy === 'chat') throw new Error('A chat is already open');
			busy = 'chat';
			return () => {
				busy = undefined;
			};
		},
	});

	let openHandle: {close: () => void; done: Promise<void>} | undefined;
	let openSession: ChatSession | undefined;
	let applyOpenChat: ((patch: LivePatch) => void) | undefined;

	// Opening a chat replaces the one that is open.
	const replaceChat = async (start: (d: ChatRunDeps) => Promise<void>): Promise<void> => {
		if (busy === 'ask') throw new Error('An ask is already running');
		const previous = openHandle;
		if (previous) {
			previous.close();
			await previous.done.catch(() => {});
		}
		let close: (() => void) | undefined;
		let closeRequested = false;
		const done = start(
			chatDeps(c => {
				close = c;
				// Deferred: the host registers the view only after `build` returns.
				if (closeRequested) queueMicrotask(c);
			}),
		);
		const handle = {
			close: () => {
				closeRequested = true;
				close?.();
			},
			done,
		};
		openHandle = handle;
		try {
			await done;
		} finally {
			if (openHandle === handle) openHandle = undefined;
		}
	};

	const chat = (args: string[], ctx: CommandContext): Promise<void> => replaceChat(d => runChat(args, ctx, d));

	const newChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error(CHAT_NEW_USAGE);
		const requested = args[0];
		if (requested !== undefined && !isModelId(requested)) {
			throw new Error(`Invalid model "${makeScrub(s => s)(requested).slice(0, 100)}". ${CHAT_NEW_USAGE}`);
		}
		const state = await store.read();
		const model = requested ?? state.chatModel;
		await replaceChat(d => openChat({fresh: true, ...(model && {model}), tuning: tuningFromState(state)}, ctx, d));
	};

	// Continues an earlier chat of this project: by id prefix, or picked from a list in the console.
	const resumeChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error(RESUME_USAGE);
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const sessions = await listSessions(paths.configDir, paths.projectDir);
		const start = async (sessionId: string) => {
			const state = await store.read();
			log.info('chat resume requested', {session8: sessionId.slice(0, 8)});
			await replaceChat(d =>
				openChat(
					{fresh: false, resume: sessionId, ...(state.chatModel && {model: state.chatModel}), tuning: tuningFromState(state)},
					ctx,
					d,
				),
			);
		};
		const wanted = args[0];
		if (wanted !== undefined) {
			const matches = sessions.filter(s => s.sessionId.startsWith(wanted.toLowerCase()));
			if (matches.length === 0) throw new Error(`No earlier chat matches "${makeScrub(s => s)(wanted).slice(0, 40)}". ${RESUME_USAGE}`);
			if (matches.length > 1) throw new Error(`"${wanted}" matches ${matches.length} chats; type more of the id.`);
			return start(matches[0]!.sessionId);
		}
		if (!ctx.mount) throw new Error('"claude resume" needs an interface that can show views');
		const ui = await (deps.loadUi ?? unavailable)();
		if (!ui.createPickerElement) throw new Error('The chat interface cannot show the session list');
		const scrub = makeScrub(s => s);
		let picked: string | undefined;
		await ctx.mount(
			control =>
				ui.createPickerElement!({
					sessions,
					scrub,
					onPick: id => {
						picked = id;
					},
					close: control.close,
					...(control.host && {host: control.host}),
				}),
			{target: 'panel'},
		);
		if (picked) await start(picked);
	};

	const session = async (ctx: CommandContext): Promise<void> => {
		const state = await store.read();
		const rt = runtimeInfo(resolvePaths(dataDir, deps.moduleDir));
		const active = await resolveCredential({env, dataDir});
		const scrub = makeScrub(active ? makeRedactor(active) : s => s);
		ctx.print(scrub(`Session: ${state.lastSessionId ?? '(none)'}`));
		ctx.print(scrub(`Model: ${state.lastModel ?? '(unknown)'}`));
		ctx.print(scrub(`Chat model: ${state.chatModel ?? 'default'}`));
		ctx.print(scrub(`Claude Code runtime: ${rt.cli ?? '(not installed)'}`));
		ctx.print(scrub(`Agent SDK: ${rt.sdk}`));
		ctx.print(scrub(`Binary in use: ${rt.binary}`));
	};

	const printActive = async (ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential({env, dataDir});
		if (active) ctx.print(`Active credential: ${describeCredential(active)}`);
	};

	const authStatus = async (ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential({env, dataDir});
		if (!active) {
			try {
				await requireCredential({env, dataDir});
			} catch (err) {
				ctx.print(err instanceof Error ? err.message : String(err));
			}
		} else {
			ctx.print(`Active credential: ${describeCredential(active)}`);
		}
		// Probes isolate one source group at a time so no credential name is read here.
		const envOnly = await resolveCredential({env, dataDir: join(dataDir, '.absent')});
		const filesOnly = await resolveCredential({env: {}, dataDir});
		const others: string[] = [];
		if (envOnly && active?.source !== 'env') others.push('environment variable');
		if (filesOnly && filesOnly.source !== active?.source) {
			others.push(filesOnly.source === 'stored' ? 'stored key (credentials.json)' : 'legacy file (.token)');
		}
		log.info('auth status', {kind: active?.kind, source: active?.source, others});
		if (others.length > 0) ctx.print(`Other available sources: ${others.join(', ')}`);
		for (const warning of await inspectFileMode(dataDir)) ctx.print(`Warning: ${warning}`);
		if (active) await showNoticeOnce(active, ctx);
	};

	const authKey = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args[0] !== '--from-file') {
			throw new Error(
				`API keys are not accepted as command arguments because they would stay in the scrollback and history. ${KEY_USAGE}`,
			);
		}
		const rest = args.slice(1);
		if (rest.length === 0) throw new Error(KEY_USAGE);
		if (rest.length > 1) {
			throw new Error('Paths with spaces are not supported by "claude auth key --from-file"; move the file to a path without spaces.');
		}
		const value = await readKeyFile(rest[0]!);
		try {
			await storeApiKey(dataDir, value);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Invalid API key format')) {
				throw new Error('The file does not contain a valid Anthropic API key');
			}
			throw err;
		}
		log.info('api key stored');
		ctx.print(
			`API key stored in ${join(dataDir, 'credentials.json')} (mode 0600). Source file left untouched; delete it yourself.`,
		);
		const active = await resolveCredential({env, dataDir});
		if (active && active.source !== 'stored') {
			ctx.print(`Note: the stored key is not used while another source has priority (${describeCredential(active)}).`);
		}
	};

	const authLogout = async (ctx: CommandContext): Promise<void> => {
		const removed = await removeStored(dataDir);
		log.info('stored credential removed', {removed});
		ctx.print(
			removed
				? 'Stored credential removed. Environment variables and the legacy file .token are not touched.'
				: 'No stored credential.',
		);
		await printActive(ctx);
	};

	const auth = async (args: string[], ctx: CommandContext): Promise<void> => {
		const [sub, ...rest] = args;
		switch (sub) {
			case 'status':
				return authStatus(ctx);
			case 'key':
				return authKey(rest, ctx);
			case 'logout':
				return authLogout(ctx);
			case 'login':
				ctx.print(
					`"claude auth login" is not available yet; it needs terminal handoff (planned). Use ANTHROPIC_API_KEY, "claude auth key --from-file <path>", or run "claude setup-token" in a shell and save the token to ${join(dataDir, '.token')}.`,
				);
				return;
			default:
				throw new Error(AUTH_USAGE);
		}
	};

	const OWN_SUBCOMMANDS: Subcommand[] = [
		{name: 'ping', usage: 'claude ping', description: 'Check that the claude module is loaded'},
		{name: 'ask', usage: 'claude ask [--new] <text>', description: 'Ask Claude a question (continues the last session)'},
		{name: 'chat', usage: 'claude chat [--new]', description: 'Open an interactive chat (continues the last session)'},
		{name: 'new', usage: 'claude new [model]', description: 'Start a new chat'},
		{name: 'resume', usage: 'claude resume [session]', description: 'Continue an earlier chat (pick from a list, or give an id prefix)'},
		{name: 'session', usage: 'claude session', description: 'Show the current session, model and runtime'},
		{
			name: 'auth',
			usage: 'claude auth <status|key|logout|login>',
			description: 'Manage credentials (key takes --from-file <path>)',
		},
	];
	const ownNames = new Set(OWN_SUBCOMMANDS.map(s => s.name));

	const claudeCodeSubcommands = (): Subcommand[] => {
		const known: SlashCommandInfo[] =
			openSession && openSession.state !== 'closed' && openSession.commands.length > 0
				? [...openSession.commands]
				: diskCommands(resolvePaths(dataDir, deps.moduleDir).configDir);
		return known
			.filter(c => !ownNames.has(c.name))
			.map(c => ({
				name: c.name,
				usage: `claude ${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
				description: c.description ? `Claude Code: ${c.description}` : 'Claude Code command (runs in the open chat)',
			}));
	};

	// Runs a Claude Code command in the open chat, as if typed there with a leading slash.
	const runClaudeCodeCommand = async (name: string, args: string[], ctx: CommandContext): Promise<void> => {
		if (!isCommandName(name)) throw new Error(`Unknown subcommand "${makeScrub(s => s)(name).slice(0, 64)}". ${USAGE}`);
		const session = openSession;
		if (!session || session.state === 'closed') throw new Error(NO_CHAT);
		const known = session.commands;
		if (known.length > 0 && !known.some(c => c.name === name)) {
			throw new Error(`Unknown Claude Code command "${name}". Type "claude " in the console to see the list.`);
		}
		if (session.state === 'running') throw new Error('Claude is still answering; wait or press Esc in the chat.');
		session.send(`/${name}${args.length > 0 ? ` ${args.join(' ')}` : ''}`, {command: true});
		log.info('claude code command sent', {command: name, args: args.length});
		ctx.print(`Sent /${name} to the chat`);
	};

	const claude: Command = {
		name: 'claude',
		description: 'Claude Code integration',
		usage: 'claude <ping|ask|chat|new|resume|session|auth|command> [args…]',
		get subcommands() {
			return [...OWN_SUBCOMMANDS, ...claudeCodeSubcommands()];
		},
		run: async ([sub, ...args], ctx) => {
			switch (sub) {
				case undefined:
					throw new Error(USAGE);
				case 'ping':
					ctx.print('pong');
					return;
				case 'ask':
					return ask(args, ctx);
				case 'chat':
					return chat(args, ctx);
				case 'new':
					return newChat(args, ctx);
				case 'resume':
					return resumeChat(args, ctx);
				case 'session':
					return session(ctx);
				case 'auth':
					return auth(args, ctx);
				default:
					return runClaudeCodeCommand(sub, args, ctx);
			}
		},
	};

	const chatCommand: Command = {
		name: 'chat',
		description: 'Start a new chat with the assistant',
		usage: 'chat [model]',
		autostart: true,
		settings: {
			title: 'Claude',
			settings: chatSettings(store, isModelId, log, {
				applyMode: mode => {
					if (openSession && openSession.state !== 'closed') openSession.setMode(mode);
				},
				applyLive: patch => applyOpenChat?.(patch),
			}),
		},
		run: newChat,
	};

	return [claude, chatCommand];
};
