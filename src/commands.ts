import {constants} from 'node:fs';
import {appendFile, lstat, mkdir, open, realpath, stat, writeFile} from 'node:fs/promises';
import path, {join, resolve} from 'node:path';
import type {Command, CommandContext, Logger, SettingsTab, Subcommand} from '../../../src/api.js';
import {chatSettings, tuningFromState, type LivePatch} from './chat-prefs.js';
import {isCommandName, type ChatSession, type SlashCommandInfo} from './chat/chat-session.js';
import {diskCommands} from './disk-commands.js';
import {listPrompts, listSessions, readHistory} from './chat/history.js';
import {readSessionTitle, transcriptFile} from './chat/title.js';
import {ago, type PickerItem} from './ui/picker-model.js';
import {buildEnv, buildOptions, ensureMdLinks, resolvePaths, runtimeInfo} from './config.js';
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
	storeOauthToken,
} from './credentials.js';
import {editFile, readHidden, runInteractive, waitForEnter} from './terminal.js';
import {clip, errClass, noopLog} from './log.js';
import {openChat, runChat, type ChatOpen, type ChatRunDeps, type ChatUi} from './chat/command.js';
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

const USAGE = 'Usage: claude <ping|ask|chat|new|resume|rewind|fork|rename|export|copy|memory|tasks|mcp|session|auth|<Claude Code command>>';
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

export const createClaudeCommand = (deps: ClaudeDeps): Command => createClaudeCommands(deps).find(c => c.name === 'claude')!;

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
			ensureMdLinks(paths);
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
		onRulesChanged: () => void refreshRules(),
		inputMode: () => inputMode,
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

	// Chat input editing, cached so every key can read it.
	let inputMode: 'normal' | 'vim' = 'normal';
	void store.read().then(
		s => {
			inputMode = s.chatInputMode === 'vim' ? 'vim' : 'normal';
		},
		() => {},
	);

	// Saved "always" rules, cached so the settings tab can be built synchronously.
	let rules: string[] = [];
	const refreshRules = async (): Promise<void> => {
		try {
			rules = (await store.read()).allowedCommands ?? [];
		} catch {
			rules = [];
		}
	};
	void refreshRules();

	const permissionsTab = (): SettingsTab | undefined => {
		if (rules.length === 0) return undefined;
		return {
			title: 'Permissions',
			settings: rules.map((rule, i) => ({
				key: `rule:${i}`,
				label: rule.length > 80 ? `${rule.slice(0, 79)}…` : rule,
				description: 'Bash command allowed with "always"',
				options: [
					{value: 'keep', label: 'Allowed'},
					{value: 'remove', label: 'Remove', description: 'ask again next time'},
				],
				get: () => (rules.includes(rule) ? 'keep' : 'remove'),
				set: async value => {
					if (value !== 'remove') return;
					const now = (await store.read()).allowedCommands ?? [];
					await store.update({allowedCommands: now.filter(c => c !== rule)});
					openSession?.forget(rule);
					log.info('permission rule removed');
					await refreshRules();
				},
			})),
		};
	};

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

	// Shows a list in the console panel and resolves with the picked id (undefined on Esc).
	const pick = async (
		ctx: CommandContext,
		what: {title: string; empty: string; action: string; items: PickerItem[]},
	): Promise<string | undefined> => {
		if (!ctx.mount) throw new Error('This command needs an interface that can show views');
		const ui = await (deps.loadUi ?? unavailable)();
		if (!ui.createPickerElement) throw new Error('The chat interface cannot show lists');
		let picked: string | undefined;
		await ctx.mount(
			control =>
				ui.createPickerElement!({
					...what,
					scrub: makeScrub(s => s),
					onPick: id => {
						picked = id;
					},
					close: control.close,
					...(control.host && {host: control.host}),
				}),
			{target: 'panel'},
		);
		return picked;
	};

	// Opens a chat with the current settings plus the given resume options.
	const openWith = async (ctx: CommandContext, open: Omit<ChatOpen, 'model' | 'tuning'>): Promise<void> => {
		const state = await store.read();
		await replaceChat(d =>
			openChat({...open, ...(state.chatModel && {model: state.chatModel}), tuning: tuningFromState(state)}, ctx, d),
		);
	};

	// The session the chat commands act on: the open chat's, else the last one.
	const currentSessionId = async (): Promise<string | undefined> =>
		(openSession && openSession.state !== 'closed' ? openSession.sessionId : undefined) ?? (await store.read()).lastSessionId;

	const transcriptOf = (sessionId: string): string => {
		const paths = resolvePaths(dataDir, deps.moduleDir);
		return transcriptFile(paths.configDir, paths.projectDir, sessionId);
	};

	// Continues an earlier chat of this project: by id prefix, or picked from a list in the console.
	const resumeChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error(RESUME_USAGE);
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const sessions = await listSessions(paths.configDir, paths.projectDir);
		const start = (sessionId: string) => {
			log.info('chat resume requested', {session8: sessionId.slice(0, 8)});
			return openWith(ctx, {fresh: false, resume: sessionId});
		};
		const wanted = args[0];
		if (wanted !== undefined) {
			const matches = sessions.filter(s => s.sessionId.startsWith(wanted.toLowerCase()));
			if (matches.length === 0) throw new Error(`No earlier chat matches "${makeScrub(s => s)(wanted).slice(0, 40)}". ${RESUME_USAGE}`);
			if (matches.length > 1) throw new Error(`"${wanted}" matches ${matches.length} chats; type more of the id.`);
			return start(matches[0]!.sessionId);
		}
		const now = Date.now();
		const picked = await pick(ctx, {
			title: 'Resume a chat',
			empty: 'No earlier chats in this project',
			action: 'resume',
			items: sessions.map(x => ({id: x.sessionId, label: x.title, meta: `${ago(x.modified, now)} · ${x.prompts} msg`})),
		});
		if (picked) await start(picked);
	};

	// Opens a branch of the current chat: same history, new session; the original stays as it was.
	const forkChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude fork');
		const id = await currentSessionId();
		if (!id) throw new Error('There is no chat to fork yet; send a message first.');
		log.info('chat fork requested', {session8: id.slice(0, 8)});
		await openWith(ctx, {fresh: false, resume: id, fork: true});
	};

	// Goes back to before one of your messages: files Claude changed since then are restored and the
	// conversation continues on a branch from that point, with that message back in the input.
	const rewindChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude rewind');
		const session = openSession && openSession.state !== 'closed' ? openSession : undefined;
		const id = session?.sessionId;
		if (!session || !id) throw new Error('There is no open chat to rewind yet.');
		if (session.state === 'running') throw new Error('Claude is still answering; wait or press Esc in the chat.');
		const prompts = (await listPrompts(transcriptOf(id))).reverse();
		const picked = await pick(ctx, {
			title: 'Rewind to before…',
			empty: 'Nothing to rewind to yet',
			action: 'rewind',
			items: prompts.map((p, i) => ({id: p.uuid, label: p.text, meta: i === 0 ? 'latest' : `${i + 1} back`})),
		});
		const target = prompts.find(p => p.uuid === picked);
		if (!target) return;
		const files = await session.rewindFiles(target.uuid).catch((err: unknown) => ({
			canRewind: false,
			error: err instanceof Error ? err.message : String(err),
		}));
		const scrub = makeScrub(s => s);
		ctx.print(
			files.canRewind
				? `Rewound: files restored${'filesChanged' in files && files.filesChanged ? ` (${files.filesChanged.length} changed)` : ''}`
				: `Rewound the conversation; files were not restored: ${scrub(files.error ?? 'unknown reason').slice(0, 200)}`,
		);
		log.info('chat rewind', {session8: id.slice(0, 8), files: files.canRewind});
		if (target.parentUuid === null) await openWith(ctx, {fresh: true, draft: target.text});
		else await openWith(ctx, {fresh: false, resume: id, fork: true, resumeAt: target.parentUuid, historyUntil: target.uuid, draft: target.text});
	};

	// Names the chat: a custom-title entry in the transcript, as Claude Code's /rename writes it.
	const renameChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		const name = args.join(' ').trim();
		if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Usage: claude rename <name> (up to 120 characters)');
		const id = await currentSessionId();
		if (!id) throw new Error('There is no chat to rename yet; send a message first.');
		await appendFile(transcriptOf(id), `${JSON.stringify({type: 'custom-title', customTitle: name, sessionId: id})}\n`);
		if (openSession?.sessionId === id) openSession.setTitle(name);
		ctx.print(`Renamed the chat to "${name}"`);
	};

	// Writes the conversation (prompts and answers) as Markdown.
	const exportChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error('Usage: claude export [file]');
		const id = await currentSessionId();
		if (!id) throw new Error('There is no chat to export yet.');
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
		const target = args[0]
			? path.resolve(paths.projectDir, args[0])
			: path.join(dataDir, 'exports', `${stamp}-${id.slice(0, 8)}.md`);
		const inside = [paths.projectDir, dataDir].some(root => target.startsWith(path.resolve(root) + path.sep));
		if (!inside) throw new Error('Export files go inside the project or the claude data directory');
		const file = transcriptOf(id);
		const messages = await readHistory(file, Number.MAX_SAFE_INTEGER);
		if (messages.length === 0) throw new Error('The chat has no messages to export yet.');
		const title = (await readSessionTitle(file)) ?? 'Chat';
		const body = [`# ${title}`, '', `Session \`${id}\`, exported ${new Date().toISOString()}.`, ''];
		for (const m of messages) body.push(m.role === 'user' ? '## You' : '## Claude', '', m.text, '');
		await mkdir(path.dirname(target), {recursive: true});
		await writeFile(target, body.join('\n'), {flag: 'wx'}).catch((err: unknown) => {
			if ((err as {code?: unknown}).code === 'EEXIST') throw new Error(`"${target}" already exists`);
			throw err;
		});
		ctx.print(`Exported ${messages.length} messages to ${target}`);
	};

	// Copies Claude's latest answer (or the Nth latest) to the clipboard of your terminal.
	const copyAnswer = async (args: string[], ctx: CommandContext): Promise<void> => {
		const n = args[0] === undefined ? 1 : Number(args[0]);
		if (args.length > 1 || !Number.isInteger(n) || n < 1) throw new Error('Usage: claude copy [N]');
		if (!ctx.copyToClipboard) throw new Error('This interface cannot reach the clipboard');
		const id = await currentSessionId();
		if (!id) throw new Error('There is no answer to copy yet.');
		const answers = (await readHistory(transcriptOf(id), Number.MAX_SAFE_INTEGER)).filter(m => m.role === 'assistant');
		const answer = answers.at(-n);
		if (!answer) throw new Error(n === 1 ? 'There is no answer to copy yet.' : `There are only ${answers.length} answers.`);
		if (!ctx.copyToClipboard(answer.text)) throw new Error('The answer is too long for the terminal clipboard');
		ctx.print(`Copied ${n === 1 ? 'the last answer' : `answer ${n} back`} (${answer.text.length} characters)`);
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

	// Runs Claude Code's "setup-token" on the terminal, then asks for the token it printed (hidden input)
	// and saves it to .token; the token never passes through arguments, history or logs.
	const authLogin = async (ctx: CommandContext): Promise<void> => {
		if (!ctx.suspend) throw new Error('"claude auth login" needs an interface that can hand over the terminal');
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const bin = runtimeInfo(paths).cli ? paths.runtimeBin : undefined;
		if (!bin) throw new Error('Claude Code is not installed for this module. Run modules/claude/bin/install.');
		const token = await ctx.suspend(() => {
			const ok = runInteractive(bin, ['setup-token'], {...process.env, CLAUDE_CONFIG_DIR: paths.configDir});
			if (!ok) {
				waitForEnter('\n"claude setup-token" did not finish. Press Enter to return to yena. ');
				return '';
			}
			return readHidden('\nPaste the token printed above (input hidden) and press Enter: ');
		});
		if (token.trim() === '') {
			ctx.print('Login cancelled; nothing was saved.');
			return;
		}
		await storeOauthToken(dataDir, token);
		log.info('subscription token stored');
		ctx.print(`Subscription token saved to ${join(dataDir, '.token')} (mode 0600). New chats use it unless an environment variable takes priority.`);
		await printActive(ctx);
	};

	// Lists the chat's tasks (background Bash, subagents); picking a running one stops it.
	const tasksCmd = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude tasks');
		const session = openSession && openSession.state !== 'closed' ? openSession : undefined;
		if (!session) throw new Error(NO_CHAT);
		const now = Date.now();
		const tasks = [...session.tasks].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'));
		const picked = await pick(ctx, {
			title: 'Tasks (Enter stops a running one)',
			empty: 'No tasks in this chat yet',
			action: 'stop',
			items: tasks.map(t => ({
				id: t.id,
				label: t.description,
				meta: `${t.status}${t.background ? ' · background' : ''} · ${ago(t.startedAt, now)}`,
			})),
		});
		const task = tasks.find(t => t.id === picked);
		if (!task) return;
		if (task.status !== 'running') {
			ctx.print(`That task already ${task.status}${task.summary ? `: ${makeScrub(s => s)(task.summary).slice(0, 200)}` : ''}`);
			return;
		}
		await session.stopTask(task.id);
		ctx.print(`Stopping "${makeScrub(s => s)(task.description).slice(0, 80)}"`);
	};

	// Shows the MCP servers of the open chat, or reconnects one.
	const mcpCmd = async (args: string[], ctx: CommandContext): Promise<void> => {
		const session = openSession && openSession.state !== 'closed' ? openSession : undefined;
		const scrub = makeScrub(s => s);
		if (args[0] === 'reconnect') {
			if (args.length !== 2) throw new Error('Usage: claude mcp [reconnect <server>]');
			if (!session) throw new Error(NO_CHAT);
			await session.reconnectMcp(args[1]!);
			ctx.print(`Reconnected ${scrub(args[1]!)}`);
			return;
		}
		if (args.length > 0) throw new Error('Usage: claude mcp [reconnect <server>]');
		const status = session ? await session.mcpStatus().catch(() => undefined) : undefined;
		if (!status) {
			ctx.print('MCP servers connect when a chat sends its first message; send one and run "claude mcp" again.');
			return;
		}
		if (status.length === 0) {
			ctx.print('No MCP servers are configured for Claude Code (config/.claude.json or the project .mcp.json).');
			return;
		}
		for (const s of status) ctx.print(`${scrub(s.name)}: ${scrub(s.status)}${s.error ? ` (${scrub(s.error).slice(0, 120)})` : ''}`);
	};

	// Opens one of the md instruction files (CLAUDE.md by default) in the editor.
	const memory = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error('Usage: claude memory [file]');
		if (!ctx.suspend) throw new Error('"claude memory" needs an interface that can hand over the terminal');
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const name = args[0] ?? 'CLAUDE.md';
		if (!/^[\w.-]+\.md$/.test(name)) throw new Error('Give a file name in the md directory, such as CLAUDE.md or SOUL.md');
		const file = join(paths.mdDir, name);
		const ok = await ctx.suspend(() => editFile(file, process.env));
		ctx.print(ok ? `Edited ${file}; new chats read it.` : `The editor did not finish; ${file} may be unchanged.`);
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
				return authLogin(ctx);
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
		{name: 'rewind', usage: 'claude rewind', description: 'Go back to before one of your messages (files and conversation)'},
		{name: 'fork', usage: 'claude fork', description: 'Continue the current chat on a new branch'},
		{name: 'rename', usage: 'claude rename <name>', description: 'Name the current chat'},
		{name: 'export', usage: 'claude export [file]', description: 'Save the current chat as Markdown'},
		{name: 'copy', usage: 'claude copy [N]', description: "Copy Claude's last (or Nth last) answer to the clipboard"},
		{name: 'memory', usage: 'claude memory [file]', description: 'Edit CLAUDE.md (or another md instruction file) in your editor'},
		{name: 'tasks', usage: 'claude tasks', description: 'Background tasks and subagents of the chat; pick one to stop it'},
		{name: 'mcp', usage: 'claude mcp [reconnect <server>]', description: 'MCP servers of the chat and their status'},
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
		usage: 'claude <command> [args…]',
		get subcommands() {
			return [...OWN_SUBCOMMANDS, ...claudeCodeSubcommands()];
		},
		get settings() {
			return permissionsTab();
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
				case 'rewind':
					return rewindChat(args, ctx);
				case 'fork':
					return forkChat(args, ctx);
				case 'rename':
					return renameChat(args, ctx);
				case 'export':
					return exportChat(args, ctx);
				case 'copy':
					return copyAnswer(args, ctx);
				case 'memory':
					return memory(args, ctx);
				case 'tasks':
					return tasksCmd(args, ctx);
				case 'mcp':
					return mcpCmd(args, ctx);
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
				applyInputMode: mode => {
					inputMode = mode;
				},
			}),
		},
		run: newChat,
	};

	// `chat` first: its Claude tab leads the settings screen, before claude's Permissions tab.
	return [chatCommand, claude];
};
