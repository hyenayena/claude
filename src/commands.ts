import {constants} from 'node:fs';
import {appendFile, lstat, mkdir, open, realpath, stat, writeFile} from 'node:fs/promises';
import path, {join, resolve} from 'node:path';
import type {Command, CommandContext, Logger, SettingsTab, Subcommand} from '../../../src/api.js';
import {chatSettings, tuningFromState, type LivePatch} from './chat-prefs.js';
import {isCommandName, type SlashCommandInfo} from './chat/chat-session.js';
import type {ChatHandle} from './chat/handle.js';
import {clockTime} from './clock-time.js';
import {runnerSocketPath} from './runner/spawn.js';
import {diskCommands} from './disk-commands.js';
import {listPrompts, listSessions, readHistory} from './chat/history.js';
import {readSessionTitle, transcriptFile} from './chat/title.js';
import {ago, type PickerItem} from './ui/picker-model.js';
import {buildEnv, buildOptions, cliEnv, ensureMdLinks, resolvePaths, runtimeInfo} from './config.js';
import {LOGIN_USAGE, parseLoginArgs, probeLogin, runLogout, type LoginProbe, type LoginRequest, type LoginStatus} from './claude-login.js';
import {
	describeCredential,
	inspectFileMode,
	isSubscription,
	listCredentialSources,
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
import {openChat, runChat, type ChatOpen, type ChatRoute, type ChatRouteRequest, type ChatRunDeps, type ChatUi} from './chat/command.js';
import {makeScrub} from './chat/scrub.js';
import {runTurn, TurnFailure} from './session.js';
import {queryStatus, serveControl, type ControlServer, type ControlStatus} from './sessions/control.js';
import {acquireLock, isSessionId, readHolder, type LockInfo, type LockKind, type SessionLock} from './sessions/lock.js';
import {stopHolder} from './sessions/stop.js';
import {createStore, isModelId} from './store.js';
import type {ChatQueryFn, Credential, CredentialInfo, QueryFn} from './types.js';

const LIMIT_KINDS = new Set(['usage-limit', 'rate-limit', 'billing', 'context']);
const limitKind = (err: unknown): string | undefined =>
	err instanceof TurnFailure && err.kind !== undefined && LIMIT_KINDS.has(err.kind) ? err.kind : undefined;

export type ClaudeDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	loadQuery: () => Promise<QueryFn>;
	loadChatQuery?: () => Promise<ChatQueryFn>;
	loadConsoleSdk?: ChatRunDeps['loadConsoleSdk'];
	shellTmp?: ChatRunDeps['shellTmp'];
	// Starts the background runner for a chat; without it the chat always runs in this process.
	spawnRunner?: ChatRunDeps['spawnRunner'];
	// Timing overrides for waiting on another session and for the runner connection (tests).
	chatTiming?: Pick<ChatRunDeps, 'waitPollMs' | 'remote'>;
	loadUi?: () => Promise<ChatUi>;
	moduleDir?: string;
	// Private directory for the single-session lock and control socket; absent or throwing means no global lock.
	sessionDir?: () => string;
	log?: Logger;
	timeoutMs?: number;
	registerAbort?: (c: AbortController) => () => void;
	// Claude Code's own login: status probe, interactive run and non-interactive logout.
	login?: {
		probe?: LoginProbe;
		run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => boolean;
		logout?: (bin: string, env: Record<string, string | undefined>) => Promise<boolean>;
		// Terminal prompts, replaceable so tests never read the real terminal.
		wait?: (message: string) => void;
		readSecret?: (prompt: string) => string;
	};
};

const USAGE = 'Usage: claude <ping|ask|chat|new|resume|rewind|fork|rename|export|copy|memory|tasks|mcp|session|sessions|stop|auth|<Claude Code command>>';
const RESUME_USAGE = 'Usage: claude resume [session]';
const NO_CHAT = 'No chat is open. Claude Code commands run in the open chat; start one with "chat".';
const ASK_USAGE = 'Usage: claude ask [--new] <text>';
const AUTH_USAGE = 'Usage: claude auth <status|key|logout|login>';
const KEY_USAGE = 'Usage: claude auth key --from-file <path>';
const CHAT_NEW_USAGE = 'Usage: chat [model]';
const MAX_KEY_FILE_BYTES = 4096;
const STOP_USAGE = 'Usage: claude stop [session]';

export {MODEL_OPTIONS} from './chat-prefs.js';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const SUBSCRIPTION_NOTICE =
	"Notice: you are using your Claude subscription (OAuth), through Claude Code's own claude.ai login or a setup-token. Anthropic's terms say third-party products built on the Agent SDK may not offer claude.ai login; yena runs that login for your own personal use only, as you approved. Do not share or redistribute this setup; see README \"Policy caveat\". Prefer ANTHROPIC_API_KEY.";

const kindLabel = (info: CredentialInfo): string => {
	if (info.source === 'claude-login') return isSubscription(info) ? 'subscription login' : 'API key (login)';
	return isSubscription(info) ? 'subscription token' : 'API key';
};

const SOURCE_LABELS: Record<CredentialInfo['source'], string> = {
	env: 'environment variable',
	'claude-login': 'Claude Code login',
	stored: 'stored credential (credentials.json)',
};

const LOGOUT_USAGE = 'Usage: claude auth logout';

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
	const loginPaths = () => resolvePaths(dataDir, deps.moduleDir);
	const cliBin = (): string | undefined => {
		const paths = loginPaths();
		return runtimeInfo(paths).cli ? paths.runtimeBin : undefined;
	};
	const probe: LoginProbe =
		deps.login?.probe ??
		(async () => {
			const bin = cliBin();
			return bin ? probeLogin({bin, env: cliEnv(env, loginPaths())}) : undefined;
		});
	const runCli = deps.login?.run ?? ((bin, args, e) => runInteractive(bin, args, e));
	const wait = deps.login?.wait ?? waitForEnter;
	const readSecret = deps.login?.readSecret ?? readHidden;
	const logoutCli = deps.login?.logout ?? ((bin, e) => runLogout({bin, env: e}));
	let busy: 'ask' | 'chat' | undefined;
	let askAbort: (() => void) | undefined;

	const sessionsDir = (): string | undefined => {
		if (!deps.sessionDir) return undefined;
		try {
			return deps.sessionDir();
		} catch (err) {
			log.warn('session directory unavailable', {error: errClass(err)});
			return undefined;
		}
	};

	const busyMessage = (holder: LockInfo | undefined): string => {
		if (!holder) return 'A session is starting. Wait a moment or run "claude sessions".';
		const what = holder.sessionId ? `${holder.kind} ${holder.sessionId.slice(0, 8)}` : holder.kind;
		return `A session is running (${what} since ${clockTime(holder.startedAt)}). Wait for it or run "claude stop".`;
	};

	// What the control socket reports for the chat or ask that lives in this process.
	const localStatus = (kind: LockKind, startedAt: number): ControlStatus => {
		const s = kind === 'chat' && openSession && openSession.state !== 'closed' ? openSession : undefined;
		const pending = s?.pendingPermissions.length ?? 0;
		const id = s?.sessionId;
		return {
			kind,
			where: 'local',
			state: pending > 0 ? 'waiting-permission' : kind === 'ask' || s?.state === 'running' ? 'running' : 'idle',
			startedAt,
			pending,
			queued: 0,
			attached: true,
			...(s?.title && {title: s.title}),
			...(id && {sessionId8: id.slice(0, 8)}),
		};
	};

	const claimBusy = (kind: LockKind): (() => void) => {
		busy = kind;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (busy === kind) busy = undefined;
		};
	};

	type Acquired = {ok: true; release: () => void} | {ok: false; holder?: LockInfo; unknown?: true};

	// One chat or ask at a time across every yena on this machine; the in-process flag stays the fast path.
	const tryAcquire = (kind: LockKind): Acquired => {
		if (busy === 'ask') throw new Error('An ask is already running');
		if (busy === 'chat') throw new Error('A chat is already open');
		const dir = sessionsDir();
		let lock: SessionLock | undefined;
		if (dir) {
			try {
				const got = acquireLock({dir, kind, where: 'local', log});
				if (!got.ok) return {ok: false, ...(got.holder && {holder: got.holder}), ...(got.unknown && {unknown: true as const})};
				lock = got.lock;
			} catch (err) {
				log.warn('session lock unavailable', {error: errClass(err)});
			}
		}
		const unbusy = claimBusy(kind);
		let released = false;
		let server: ControlServer | undefined;
		if (dir && lock) {
			const held = lock;
			const syncId = (): void => {
				const id = kind === 'chat' ? openSession?.sessionId : undefined;
				if (id && isSessionId(id) && id !== held.info.sessionId) held.update({sessionId: id});
			};
			void serveControl({
				dir,
				log,
				handlers: {
					status: () => {
						syncId();
						return localStatus(kind, held.info.startedAt);
					},
					stop: async () => {
						if (kind === 'ask') return askAbort?.();
						await openSession?.interrupt().catch(() => {});
						openHandle?.close();
					},
				},
			}).then(
				s => {
					if (released) void s.close();
					else {
						server = s;
						held.update({socket: s.path});
					}
				},
				err => log.warn('control socket unavailable', {error: errClass(err)}),
			);
		}
		return {
			ok: true,
			release: () => {
				if (released) return;
				released = true;
				unbusy();
				void server?.close();
				lock?.release();
			},
		};
	};

	const acquireShared = (kind: LockKind): (() => void) => {
		const got = tryAcquire(kind);
		if (!got.ok) throw new Error(busyMessage(got.holder));
		return got.release;
	};

	// Like acquireShared, but a refusal names the session by its title when it answers on its control socket.
	const acquireAsk = async (): Promise<() => void> => {
		const got = tryAcquire('ask');
		if (got.ok) return got.release;
		const dir = sessionsDir();
		const status = dir && got.holder ? await queryStatus(dir, 500).catch(() => undefined) : undefined;
		const title = status?.title ? makeScrub(s => s)(status.title).slice(0, 80) : '';
		throw new Error(title ? `A session is running (${title}). Wait for it or run "claude stop".` : busyMessage(got.holder));
	};

	// Where the next chat runs, given who holds the one-session lock.
	const routeChat = (req: ChatRouteRequest): ChatRoute => {
		if (busy === 'ask') throw new Error('An ask is already running');
		if (busy === 'chat') throw new Error('A chat is already open');
		const dir = sessionsDir();
		if (dir) {
			let seen: ReturnType<typeof readHolder> = {};
			try {
				seen = readHolder(dir);
			} catch (err) {
				log.warn('session lock unreadable', {error: errClass(err)});
			}
			const h = seen.holder;
			if (h) {
				if (req.attach && h.where === 'runner' && h.kind === 'chat' && h.socket) {
					return {kind: 'attach', socketPath: runnerSocketPath(dir), release: claimBusy('chat')};
				}
				return {kind: 'wait', message: busyMessage(h)};
			}
			if (seen.unknown) return {kind: 'wait', message: busyMessage(undefined)};
			if (req.keep && deps.spawnRunner) return {kind: 'spawn', sessionDir: dir, release: claimBusy('chat')};
		}
		const got = tryAcquire('chat');
		return got.ok ? {kind: 'local', release: got.release} : {kind: 'wait', message: busyMessage(got.holder)};
	};

	// One look at the lock while an open waits for it.
	const peekLock = async (): Promise<{free: boolean; title?: string}> => {
		const dir = sessionsDir();
		if (!dir) return {free: true};
		let seen: ReturnType<typeof readHolder>;
		try {
			seen = readHolder(dir);
		} catch {
			return {free: false};
		}
		const h = seen.holder;
		if (!h) return seen.unknown ? {free: false} : {free: true};
		const status = await queryStatus(dir, 500).catch(() => undefined);
		const title = status?.title ?? (h.sessionId ? `${h.kind} ${h.sessionId.slice(0, 8)}` : h.kind);
		return {free: false, title: makeScrub(s => s)(title).slice(0, 80)};
	};

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
		const release = await acquireAsk();
		try {
			await runAsk(text, fresh, ctx);
		} finally {
			release();
		}
	};

	const runAsk = async (text: string, fresh: boolean, ctx: CommandContext): Promise<void> => {
		let cred: Credential;
		try {
			cred = await requireCredential({env, dataDir, probeLogin: probe});
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
		askAbort = () => controller.abort();
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
				// A failed turn (limit, timeout) can still have created a session worth resuming.
				if (err instanceof TurnFailure && err.sessionId && err.kind !== 'resume') {
					await store
						.update({lastSessionId: err.sessionId, ...(err.model && {lastModel: err.model})})
						.catch(() => log.warn('ask state save failed'));
				}
				log.warn('ask failed', {
					outcome: timedOut ? 'timeout' : 'error',
					ms: Date.now() - startedAt,
					errClass: errClass(failure),
					...(limitKind(err) !== undefined
						? {failure: limitKind(err)}
						: {reason: clip(scrub(failure instanceof Error ? failure.message : String(failure)))}),
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
			askAbort = undefined;
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
		...(deps.loadConsoleSdk && {loadConsoleSdk: deps.loadConsoleSdk}),
		...(deps.shellTmp && {shellTmp: deps.shellTmp}),
		loadUi: deps.loadUi ?? unavailable,
		registerAbort: deps.registerAbort,
		store,
		showNoticeOnce,
		kindLabel,
		probeLogin: probe,
		isMissingModule,
		onMount,
		onSession: s => {
			openSession = s;
		},
		route: routeChat,
		peek: peekLock,
		...(deps.spawnRunner && {spawnRunner: deps.spawnRunner}),
		...deps.chatTiming,
		onLive: apply => {
			applyOpenChat = apply;
		},
		onRulesChanged: () => void refreshRules(),
		inputMode: () => inputMode,
		acquire: () => acquireShared('chat'),
	});

	let openHandle: {close: () => void; done: Promise<void>} | undefined;
	let openSession: ChatHandle | undefined;
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
	const replaceChat = async (start: (d: ChatRunDeps) => Promise<void>, endIdleRemote = true): Promise<void> => {
		if (busy === 'ask') throw new Error('An ask is already running');
		// Opening a different chat ends an idle background chat; a busy one is waited for.
		if (endIdleRemote && openSession?.state === 'idle') openSession.end?.();
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

	const chat = (args: string[], ctx: CommandContext): Promise<void> => replaceChat(d => runChat(args, ctx, d), args.includes('--new'));

	const newChat = async (args: string[], ctx: CommandContext, attach = false): Promise<void> => {
		if (args.length > 1) throw new Error(CHAT_NEW_USAGE);
		const requested = args[0];
		if (requested !== undefined && !isModelId(requested)) {
			throw new Error(`Invalid model "${makeScrub(s => s)(requested).slice(0, 100)}". ${CHAT_NEW_USAGE}`);
		}
		const state = await store.read();
		const model = requested ?? state.chatModel;
		await replaceChat(d => openChat({fresh: true, attach, ...(model && {model}), tuning: tuningFromState(state)}, ctx, d), !attach);
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
		let memo: Promise<LoginStatus | undefined> | undefined;
		const once: LoginProbe = () => (memo ??= probe());
		const sources = await listCredentialSources({env, dataDir, probeLogin: once});
		const active = sources[0];
		const login = await once().catch(() => undefined);
		if (!active) {
			try {
				await requireCredential({env, dataDir, probeLogin: once});
			} catch (err) {
				ctx.print(err instanceof Error ? err.message : String(err));
			}
		} else {
			ctx.print(`Active credential: ${describeCredential(active)}`);
		}
		if (login?.loggedIn && login.method) {
			const scrub = makeScrub(active ? makeRedactor(active) : s => s);
			const detail = [login.method, login.subscriptionType, login.email].filter(Boolean).join(', ');
			ctx.print(scrub(`Claude Code login: signed in (${detail})`));
		}
		const others = [...new Set(sources.filter(c => c.source !== active?.source).map(c => SOURCE_LABELS[c.source]))];
		log.info('auth status', {kind: active?.kind, source: active?.source, others, login: login?.loggedIn ? login.method : undefined});
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
		const active = await resolveCredential({env, dataDir, probeLogin: probe});
		if (active && active.source !== 'stored') {
			ctx.print(`Note: the stored key is not used while another source has priority (${describeCredential(active)}).`);
		}
	};

	// A login counts as present when Claude Code reports one, or, if it cannot be asked, its file exists.
	const loginPresent = async (): Promise<boolean> =>
		(await listCredentialSources({env: {}, dataDir, probeLogin: probe})).some(c => c.source === 'claude-login');

	const authLogout = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error(LOGOUT_USAGE);
		const removed = await removeStored(dataDir);
		log.info('stored credential removed', {removed});
		ctx.print(
			removed
				? 'Stored credential removed. Environment variables are not touched.'
				: 'No stored credential.',
		);
		if (await loginPresent()) {
			const bin = cliBin();
			const ok = bin ? await logoutCli(bin, cliEnv(env, loginPaths())) : false;
			const still = await loginPresent();
			log.info('claude logout', {ok, stillLoggedIn: still});
			if (still) {
				ctx.print('Warning: Claude Code still reports a login. Run "claude auth logout" in the Claude Code CLI, or remove it from the Claude Code config directory.');
			} else {
				ctx.print('Claude Code login removed.');
				if (busy === 'chat') ctx.print('The open chat keeps running with its credentials until you close it.');
			}
		}
		await printActive(ctx);
	};

	const authLogin = async (args: string[], ctx: CommandContext): Promise<void> => {
		const request = parseLoginArgs(args);
		if (!ctx.suspend) throw new Error('"claude auth login" needs an interface that can hand over the terminal');
		const bin = cliBin();
		if (!bin) throw new Error('Claude Code is not installed for this module. Run modules/claude/bin/install.');
		if (request.kind === 'token') return authLoginToken(bin, ctx);
		return authLoginBrowser(bin, request, ctx);
	};

	// Runs Claude Code's "setup-token" on the terminal, then asks for the token it printed (hidden input)
	// and saves it to credentials.json; the token never passes through arguments, history or logs.
	const authLoginToken = async (bin: string, ctx: CommandContext): Promise<void> => {
		const paths = loginPaths();
		const token = await ctx.suspend!(() => {
			const ok = runCli(bin, ['setup-token'], cliEnv(env, paths) as NodeJS.ProcessEnv);
			if (!ok) {
				wait('\n"claude setup-token" did not finish. Press Enter to return to yena. ');
				return '';
			}
			return readSecret('\nPaste the token printed above (input hidden) and press Enter: ');
		});
		if (token.trim() === '') {
			ctx.print('Login cancelled; nothing was saved.');
			return;
		}
		await storeOauthToken(dataDir, token);
		log.info('subscription token stored');
		ctx.print(`Subscription token stored in ${join(dataDir, 'credentials.json')} (mode 0600), replacing any stored API key. New chats use it unless an environment variable or a Claude Code login takes priority.`);
		await printActive(ctx);
	};

	// Claude Code's own browser login; yena never sees the tokens, it only asks the CLI afterwards.
	const authLoginBrowser = async (
		bin: string,
		request: Extract<LoginRequest, {kind: 'browser'}>,
		ctx: CommandContext,
	): Promise<void> => {
		const paths = loginPaths();
		const {meta} = request;
		log.info('claude login started', {method: meta.console ? 'console' : 'claude.ai', sso: meta.sso, email: meta.email});
		const ok = await ctx.suspend!(() => {
			const done = runCli(bin, ['auth', 'login', ...request.cliArgs], cliEnv(env, paths) as NodeJS.ProcessEnv);
			if (!done) wait('\n"claude auth login" did not finish. Press Enter to return to yena. ');
			return done;
		});
		const status = await probe().catch(() => undefined);
		log.info('claude login finished', {
			exitOk: ok,
			loggedIn: status?.loggedIn === true,
			method: status?.method,
			subscriptionType: status?.subscriptionType,
		});
		if (!status?.loggedIn || !status.method) {
			ctx.print('Login did not complete; nothing was changed.');
			return;
		}
		ctx.print(
			status.method === 'claude.ai'
				? `Signed in with Claude Code (claude.ai). The login is kept in ${paths.loginFile} (mode 0600) and refreshed automatically.`
				: `Signed in with Claude Code (Console account). Claude Code keeps the key in ${join(paths.configDir, '.claude.json')}.`,
		);
		const active = await resolveCredential({env, dataDir, probeLogin: async () => status});
		if (active) ctx.print(`Active credential: ${describeCredential(active)}`);
		if (active && active.source !== 'claude-login') {
			ctx.print(`Note: the login is not used while another source has priority (${describeCredential(active)}).`);
		}
		await showNoticeOnce({kind: status.method === 'claude.ai' ? 'oauth' : 'api-key', source: 'claude-login'}, ctx);
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
				return authLogout(rest, ctx);
			case 'login':
				return authLogin(rest, ctx);
			default:
				throw new Error(AUTH_USAGE);
		}
	};

	// Lists the session that holds the global lock (at most one), asking it over its control socket.
	const sessionsCmd = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude sessions');
		const dir = sessionsDir();
		if (!dir) throw new Error('Session control is not available (no private run directory)');
		const {holder, unknown} = readHolder(dir);
		if (!holder) {
			ctx.print(unknown ? 'A session is starting.' : 'No session is running.');
			return;
		}
		const scrub = makeScrub(s => s);
		const status = await queryStatus(dir).catch(() => undefined);
		const id8 = status?.sessionId8 ?? holder.sessionId?.slice(0, 8);
		const parts = [
			`${holder.kind} (${holder.where === 'runner' ? 'background' : 'in yena'})`,
			status ? status.state : 'unresponsive',
			...(status?.title ? [`"${scrub(status.title).slice(0, 80)}"`] : []),
			...(id8 ? [`session ${id8}`] : []),
			`since ${clockTime(holder.startedAt)}`,
			`pid ${holder.pid}`,
		];
		if (status && status.pending > 0) parts.push(`${status.pending} permission${status.pending === 1 ? '' : 's'} waiting`);
		if (status && status.queued > 0) parts.push(`${status.queued} queued`);
		if (status && holder.where === 'runner') parts.push(status.attached ? 'attached' : 'detached');
		ctx.print(parts.join(' · '));
	};

	const stopCmd = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error(STOP_USAGE);
		const dir = sessionsDir();
		if (!dir) throw new Error('Session control is not available (no private run directory)');
		const {holder} = readHolder(dir);
		if (!holder) {
			ctx.print('No session is running.');
			return;
		}
		const wanted = args[0]?.toLowerCase();
		if (wanted !== undefined && !(holder.sessionId ?? '').startsWith(wanted)) {
			throw new Error(`No running session matches "${makeScrub(s => s)(args[0]!).slice(0, 40)}". ${STOP_USAGE}`);
		}
		const result = await stopHolder(dir, holder, {log});
		if (result.ok) ctx.print(`Stopped the ${holder.kind} (${result.via === 'socket' ? 'asked to stop' : 'process ended'}).`);
		else if (holder.where === 'local') throw new Error(`The ${holder.kind} runs in another yena (pid ${holder.pid}) and did not stop; close that yena.`);
		else throw new Error(`The background ${holder.kind} (pid ${holder.pid}) did not stop.`);
	};

	const OWN_SUBCOMMANDS: Subcommand[] = [
		{name: 'ping', usage: 'claude ping', description: 'Check that the claude module is loaded', agent: 'confirm'},
		{name: 'ask', usage: 'claude ask [--new] <text>', description: 'Ask Claude a question (continues the last session)', agent: 'deny'},
		{name: 'chat', usage: 'claude chat [--new]', description: 'Open an interactive chat (continues the last session)', agent: 'deny'},
		{name: 'new', usage: 'claude new [model]', description: 'Start a new chat', agent: 'deny'},
		{name: 'resume', usage: 'claude resume [session]', description: 'Continue an earlier chat (pick from a list, or give an id prefix)', agent: 'deny'},
		{name: 'rewind', usage: 'claude rewind', description: 'Go back to before one of your messages (files and conversation)', agent: 'deny'},
		{name: 'fork', usage: 'claude fork', description: 'Continue the current chat on a new branch', agent: 'deny'},
		{name: 'rename', usage: 'claude rename <name>', description: 'Name the current chat', agent: 'confirm'},
		{name: 'export', usage: 'claude export [file]', description: 'Save the current chat as Markdown', agent: 'confirm'},
		{name: 'copy', usage: 'claude copy [N]', description: "Copy Claude's last (or Nth last) answer to the clipboard", agent: 'deny'},
		{name: 'memory', usage: 'claude memory [file]', description: 'Edit CLAUDE.md (or another md instruction file) in your editor', agent: 'deny'},
		{name: 'tasks', usage: 'claude tasks', description: 'Background tasks and subagents of the chat; pick one to stop it', agent: 'safe'},
		{name: 'mcp', usage: 'claude mcp [reconnect <server>]', description: 'MCP servers of the chat and their status', agent: 'safe'},
		{name: 'session', usage: 'claude session', description: 'Show the current session, model and runtime', agent: 'safe'},
		{name: 'sessions', usage: 'claude sessions', description: 'Show the running chat or ask, in any yena or in the background', agent: 'safe'},
		{name: 'stop', usage: 'claude stop [session]', description: 'Stop the running chat or ask', agent: 'confirm'},
		{
			name: 'auth',
			usage: 'claude auth <status|key|logout|login>',
			description: 'Manage credentials: login [--console|--sso|--email <address>|--token], key --from-file <path>, status, logout',
			agent: 'confirm',
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
		agent: 'deny',
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
				case 'sessions':
					return sessionsCmd(args, ctx);
				case 'stop':
					return stopCmd(args, ctx);
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
		agent: 'deny',
		autostart: true,
		settings: {
			title: 'Claude',
			settings: chatSettings(store, isModelId, log, {
				applyMode: mode => {
					if (openSession && openSession.state !== 'closed') openSession.setMode(mode);
				},
				applyLive: patch => applyOpenChat?.(patch),
				applyKeep: keep => openSession?.setKeep?.(keep),
				applyInputMode: mode => {
					inputMode = mode;
				},
			}),
		},
		run: (args, ctx) => newChat(args, ctx, args.length === 0),
	};

	// `chat` first: its Claude tab leads the settings screen, before claude's Permissions tab.
	return [chatCommand, claude];
};
