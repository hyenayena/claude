import {accessSync, constants} from 'node:fs';
import {appendFile, lstat, mkdir, open, realpath, stat, writeFile} from 'node:fs/promises';
import path, {join, resolve} from 'node:path';
import type {Command, CommandContext, Logger, SettingsTab, Subcommand} from '../../../src/api.js';
import {chatSettings, tuningFromState, type LivePatch} from './chat-prefs.js';
import {CONTINUE_TEXT, isCommandName, type SlashCommandInfo} from './chat/chat-session.js';
import {type AccountView, checkAccountName, chooseAccount, listAccounts, markLimited, removeAccount, setOrder, stashLogin, adoptLogin, useAccount} from './accounts.js';
import {formatReset, systemClock} from './chat/limits.js';
import type {ChatHandle} from './chat/handle.js';
import {usageLines} from './chat/usage.js';
import {clockTime} from './clock-time.js';
import {runnerSocketPath} from './runner/spawn.js';
import {diskCommands} from './disk-commands.js';
import {listPrompts, listSessions, readHistory} from './chat/history.js';
import {readSessionTitle, transcriptFile} from './chat/title.js';
import {ago, type PickerItem} from './ui/picker-model.js';
import {buildEnv, buildOptions, cliEnv, ensureMdLinks, resolvePaths, runtimeInfo, withProjects} from './config.js';
import {LOGIN_USAGE, parseLoginArgs, probeLogin, runLogout, type LoginProbe, type LoginRequest, type LoginStatus} from './claude-login.js';
import {
	accountsCtx,
	allSecrets,
	NO_CREDENTIALS,
	describeCredential,
	inspectFileMode,
	prepareCredential,
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
import {editFile, readHidden, runInteractive, runInteractiveStatus, waitForEnter} from './terminal.js';
import {clip, errClass, noopLog} from './log.js';
import {openChat, runChat, type ChatOpen, type ChatRoute, type ChatRouteRequest, type ChatRunDeps, type ChatUi} from './chat/command.js';
import {makeScrub} from './chat/scrub.js';
import {runTurn, TurnFailure} from './session.js';
import {queryStatus, serveControl, type ControlServer, type ControlStatus} from './sessions/control.js';
import {acquireLock, isSessionId, readHolder, type LockInfo, type LockKind, type SessionLock} from './sessions/lock.js';
import {createTurnLock, type TurnLock} from './sessions/turn-lock.js';
import {stopHolder} from './sessions/stop.js';
import {createStore, isModelId} from './store.js';
import type {ChatQueryFn, Credential, CredentialInfo, QueryFn} from './types.js';

const LIMIT_KINDS = new Set(['usage-limit', 'rate-limit', 'billing', 'context']);
const MAX_ASK_SWITCHES = 8;
const LIMIT_HOLD_S = 5 * 3600;
const BILLING_HOLD_S = 24 * 3600;

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
	// Runs bin/claude on the terminal for "claude code"; replaceable so tests never start the CLI.
	runCode?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => number | undefined;
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

const USAGE = 'Usage: claude <ping|ask|chat|new|start|resume|rewind|fork|rename|export|copy|memory|code|tasks|mcp|session|sessions|stop|auth|<Claude Code command>>';
const RESUME_USAGE = 'Usage: claude resume [session]';
const NO_CHAT = 'No chat is open. Claude Code commands run in the open chat; start one with "chat".';
const ASK_USAGE = 'Usage: claude ask [--new] <text>';
const AUTH_USAGE = 'Usage: claude auth <status|accounts|login|key|order|use|remove|logout>';
const ORDER_USAGE = 'Usage: claude auth order <account> [<account>…]';
const KEY_USAGE = 'Usage: claude auth key --from-file <path> [--name <account>]';
const CHAT_NEW_USAGE = 'Usage: chat [model]';
const START_USAGE = 'Usage: claude start <message…>';
const START_MAX = 20_000;
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

/** Takes "--name <account>" out of the arguments. */
const takeName = (args: string[]): {name: string | undefined; rest: string[]} => {
	const at = args.indexOf('--name');
	if (at < 0) return {name: undefined, rest: args};
	const name = args[at + 1];
	if (name === undefined || name.startsWith('--')) throw new Error('"--name" needs an account name');
	if (args.indexOf('--name', at + 1) >= 0) throw new Error('"--name" was given twice');
	return {name: checkAccountName(name), rest: [...args.slice(0, at), ...args.slice(at + 2)]};
};

const TYPE_LABELS: Record<AccountView['type'], string> = {
	env: 'environment variable',
	login: 'Claude Code login',
	key: 'API key',
	token: 'subscription token',
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
	const runCode = deps.runCode ?? runInteractiveStatus;
	const wait = deps.login?.wait ?? waitForEnter;
	const readSecret = deps.login?.readSecret ?? readHidden;
	const logoutCli = deps.login?.logout ?? ((bin, e) => runLogout({bin, env: e}));
	// In this process: a chat view is open, an ask is running (they may overlap while the chat is idle).
	let chatOpen = false;
	let askRunning = false;
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
		if (kind === 'chat') chatOpen = true;
		else askRunning = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (kind === 'chat') chatOpen = false;
			else askRunning = false;
		};
	};

	type Acquired = {ok: true; release: () => void} | {ok: false; holder?: LockInfo; unknown?: true};

	// One chat or ask at a time across every yena on this machine; the in-process flag stays the fast path.
	const tryAcquire = (kind: LockKind): Acquired => {
		if (askRunning) throw new Error('An ask is already running');
		if (kind === 'chat' && chatOpen) throw new Error('A chat is already open');
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
		if (askRunning) throw new Error('An ask is already running');
		if (chatOpen) throw new Error('A chat is already open');
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
		// The lock is taken per turn (chatTurnLock), so an idle chat here never blocks another terminal.
		return {kind: 'local', release: claimBusy('chat')};
	};

	const turnBusy = (holder: LockInfo | undefined): string =>
		`${busyMessage(holder).replace(/ Wait for it or run "claude stop"\.$/, '')} Your message stays in the input; send it when that session is done.`;

	// The one-session lock for a turn of the chat in this process, with the control socket for "claude stop".
	const chatTurnLock = (): TurnLock =>
		createTurnLock({
			dir: sessionsDir(),
			kind: 'chat',
			where: 'local',
			sessionId: () => openSession?.sessionId,
			status: startedAt => localStatus('chat', startedAt),
			stop: async () => {
				await openSession?.interrupt().catch(() => {});
			},
			busy: turnBusy,
			log,
		});

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

	// After a usage limit or billing error: the account is set aside until its reset and the next one is
	// prepared (swapped in, for a login); undefined when there is none left.
	const switchAfterLimit = (err: unknown, cred: Credential): Credential | undefined => {
		const kind = limitKind(err);
		if ((kind !== 'usage-limit' && kind !== 'billing') || cred.account === undefined) return undefined;
		const ctx = accountsCtx({env, dataDir});
		const now = Date.now() / 1000;
		const resetsAt = err instanceof TurnFailure ? err.rateLimit?.resetsAt : undefined;
		const until = kind === 'billing' ? now + BILLING_HOLD_S : resetsAt !== undefined && resetsAt > now ? resetsAt : now + LIMIT_HOLD_S;
		markLimited(ctx, cred.account, until, kind);
		const next = chooseAccount(ctx);
		log.info('account limited', {reason: kind, next: next !== undefined && next.limitedUntil === undefined && next.name !== cred.account});
		if (!next || next.limitedUntil !== undefined || next.name === cred.account) return undefined;
		return prepareCredential({env, dataDir});
	};

	const runAsk = async (text: string, fresh: boolean, ctx: CommandContext): Promise<void> => {
		let cred: Credential;
		try {
			// The ask lock is held: a login account can be swapped into the config dir.
			cred = prepareCredential({env, dataDir});
		} catch (err) {
			log.warn('no credential');
			throw err;
		}
		registerLogRedaction(log, cred);
		log.info('credential resolved', {kind: cred.kind, source: cred.source});
		const redact = makeRedactor(cred, allSecrets({env, dataDir}));
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
			const paths = await withProjects(resolvePaths(dataDir, deps.moduleDir));
			ensureMdLinks(paths);
			let resume = fresh ? undefined : state.lastSessionId;
			let prompt = text;
			let result;
			for (let switches = 0; ; switches++) {
			const options = buildOptions({paths, cred, abortController: controller, resume, env: buildEnv(env, paths, cred)});
			try {
				result = await runTurn({query, prompt, options, signal: controller.signal, redact, log});
				break;
			} catch (err) {
				// The account ran out: the next one in priority order takes the same session over.
				const next = !timedOut && switches < MAX_ASK_SWITCHES ? switchAfterLimit(err, cred) : undefined;
				if (next) {
					ctx.print(`Account "${cred.account}" ${limitKind(err) === 'billing' ? 'cannot be billed' : 'reached its usage limit'}; continuing with "${next.account}".`);
					if (err instanceof TurnFailure && err.sessionId) {
						resume = err.sessionId;
						prompt = CONTINUE_TEXT;
					}
					cred = next;
					registerLogRedaction(log, cred);
					continue;
				}
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
		turnLock: chatTurnLock,
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
	const replaceChat = async (start: (d: ChatRunDeps) => Promise<void>, endIdleRemote = true, onOpened?: () => void): Promise<void> => {
		if (askRunning) throw new Error('An ask is already running');
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
				onOpened?.();
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

	// The context of the chat's own command (autostart or typed): it can show the chat in the main area,
	// which a command run by an assistant or the scheduler cannot.
	let mainCtx: CommandContext | undefined;

	// "claude start <message…>": a new chat that sends the message at once. Returns when the chat is up,
	// so an assistant or the scheduler can call it; the chat itself stays open.
	const startChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		const text = args.join(' ').trim();
		if (text === '') throw new Error(START_USAGE);
		if (text.length > START_MAX) throw new Error(`The message is longer than ${START_MAX} characters`);
		if (openSession?.state === 'running') throw new Error('A chat is answering; start the new one when it is done (or press Esc in it).');
		const view = ctx.signal ? mainCtx : ctx;
		if (!view?.mount) throw new Error('No chat view is available; open the chat once with "chat".');
		const state = await store.read();
		let opened!: () => void;
		const up = new Promise<void>(resolve => {
			opened = resolve;
		});
		const running = replaceChat(
			d => openChat({fresh: true, ...(state.chatModel && {model: state.chatModel}), tuning: tuningFromState(state), send: text}, view, d),
			true,
			opened,
		);
		running.catch(err => log.warn('started chat failed', {errClass: errClass(err)}));
		await Promise.race([up, running]);
		log.info('chat started with a message', {chars: text.length, byCaller: ctx.signal !== undefined});
		ctx.print('Started a new chat with the message.');
	};

	const newChat = async (args: string[], ctx: CommandContext, attach = false): Promise<void> => {
		if (!ctx.signal) mainCtx = ctx;
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
		const usage = openSession && openSession.state !== 'closed' ? openSession.usage : undefined;
		if (usage) {
			ctx.print('Tokens in this chat (since it opened):');
			for (const line of usageLines(usage)) ctx.print(`  ${line}`);
		}
	};

	const printActive = async (ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential({env, dataDir});
		if (active) ctx.print(`Active credential: ${describeCredential(active)}`);
	};

	// A turn in progress anywhere (this yena or a background runner) holds the session lock.
	const chatRunning = (): boolean => {
		if (openSession?.state === 'running') return true;
		const dir = sessionsDir();
		return dir !== undefined && readHolder(dir).holder !== undefined;
	};

	// One line per account, in priority order: the one a new turn uses is marked.
	const accountLines = (list: AccountView[]): string[] => {
		const chosen = chooseAccount(accountsCtx({env, dataDir}));
		const scrub = makeScrub(makeRedactor(undefined, allSecrets({env, dataDir})));
		const width = Math.max(...list.map(a => a.name.length));
		return list.map((a, i) => {
			const what = a.type === 'login' ? `${TYPE_LABELS.login} (${a.kind === 'oauth' ? 'subscription' : 'Console'}${a.email ? `, ${a.email}` : ''})` : a.type === 'env' ? `${a.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'} (${TYPE_LABELS.env})` : TYPE_LABELS[a.type];
			const state =
				a.limitedUntil !== undefined
					? `${a.reason === 'billing' ? 'billing failed' : 'limit reached'}, back at ${formatReset(a.limitedUntil, systemClock)}`
					: '';
			const mark = chosen?.name === a.name ? '▸' : ' ';
			return scrub(`${mark} ${i + 1}. ${a.name.padEnd(width)}  ${what}${state ? `  · ${state}` : ''}`);
		});
	};

	const authAccounts = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude auth accounts');
		const list = listAccounts(accountsCtx({env, dataDir}));
		log.info('auth accounts', {count: list.length, limited: list.filter(a => a.limitedUntil !== undefined).length});
		if (list.length === 0) {
			ctx.print(NO_CREDENTIALS);
			return;
		}
		ctx.print('Accounts, in priority order (▸ is used next; when it reaches its limit, the next one takes over):');
		for (const line of accountLines(list)) ctx.print(line);
	};

	const authStatus = async (ctx: CommandContext): Promise<void> => {
		const list = listAccounts(accountsCtx({env, dataDir}));
		const active = await resolveCredential({env, dataDir});
		log.info('auth status', {kind: active?.kind, source: active?.source, accounts: list.length, limited: list.filter(a => a.limitedUntil !== undefined).length});
		if (!active) {
			ctx.print(NO_CREDENTIALS);
		} else {
			ctx.print(`Active credential: ${describeCredential(active)}`);
			if (list.length > 1) {
				ctx.print('Accounts, in priority order:');
				for (const line of accountLines(list)) ctx.print(line);
			}
		}
		for (const warning of await inspectFileMode(dataDir)) ctx.print(`Warning: ${warning}`);
		if (active) await showNoticeOnce(active, ctx);
	};

	const authOrder = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length === 0) throw new Error(ORDER_USAGE);
		const list = setOrder(accountsCtx({env, dataDir}), args);
		log.info('auth order', {count: list.length});
		for (const line of accountLines(list)) ctx.print(line);
	};

	const authUse = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 1) throw new Error('Usage: claude auth use <account>');
		const list = useAccount(accountsCtx({env, dataDir}), args[0]!);
		log.info('auth use', {count: list.length});
		ctx.print(`"${args[0]}" is first now and its limit is forgotten; new turns use it.`);
		for (const line of accountLines(list)) ctx.print(line);
	};

	const authRemove = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 1) throw new Error('Usage: claude auth remove <account>');
		const {wasInstalled} = removeAccount(accountsCtx({env, dataDir}), args[0]!);
		log.info('auth remove', {login: wasInstalled});
		ctx.print(`Account "${args[0]}" removed${wasInstalled ? '; Claude Code is signed out of it' : ''}.`);
		if (chatOpen) ctx.print('The open chat keeps its current account until Claude Code restarts.');
		await printActive(ctx);
	};

	const authKey = async (rawArgs: string[], ctx: CommandContext): Promise<void> => {
		const {name, rest: args} = takeName(rawArgs);
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
		let account;
		try {
			account = await storeApiKey(dataDir, value, name, env);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Invalid API key format')) {
				throw new Error('The file does not contain a valid Anthropic API key');
			}
			throw err;
		}
		log.info('api key stored');
		ctx.print(
			`API key stored as account "${account.name}" in ${join(dataDir, 'accounts.json')} (mode 0600). Source file left untouched; delete it yourself.`,
		);
		await noteIfShadowed(account.name, ctx);
	};

	// Says so when a new account is not the one used next.
	const noteIfShadowed = async (name: string, ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential({env, dataDir});
		if (active && active.account !== name) {
			ctx.print(`Note: "${name}" is used after ${describeCredential(active)} in priority order; "claude auth use ${name}" puts it first.`);
		}
	};

	// A login counts as present when Claude Code reports one, or, if it cannot be asked, its file exists.
	const loginPresent = async (): Promise<boolean> => {
		const status = await probe().catch(() => undefined);
		return status?.loggedIn === true;
	};

	const authLogout = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error(LOGOUT_USAGE);
		const removed = await removeStored(dataDir);
		log.info('stored credential removed', {removed});
		ctx.print(
			removed
				? 'Every stored account removed (keys, tokens and logins). Environment variables are not touched. "claude auth remove <account>" removes one.'
				: 'No stored account.',
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
				if (chatOpen) ctx.print('The open chat keeps running with its credentials until you close it.');
			}
		}
		await printActive(ctx);
	};

	// Runs the Claude Code CLI (bin/claude) on the terminal; arguments go to it as they are, without a shell.
	const code = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (!ctx.suspend) throw new Error('"claude code" needs an interface that can hand over the terminal');
		const bin = join(loginPaths().moduleDir, 'bin', 'claude');
		try {
			accessSync(bin, constants.X_OK);
		} catch {
			throw new Error('Claude Code wrapper not found or not executable. Run modules/claude/bin/install.');
		}
		const status = await ctx.suspend(() => runCode(bin, args, env));
		log.info('claude code finished', {args: args.length, status});
		if (status === 0) return;
		if (!ctx.headless) wait('\nClaude Code did not finish cleanly. Press Enter to return to yena. ');
		throw new Error(status === undefined ? 'Claude Code did not run to completion (it did not start or was stopped by a signal)' : `Claude Code exited with status ${status}`);
	};

	const authLogin = async (rawArgs: string[], ctx: CommandContext): Promise<void> => {
		const {name, rest: args} = takeName(rawArgs);
		const request = parseLoginArgs(args);
		if (!ctx.suspend) throw new Error('"claude auth login" needs an interface that can hand over the terminal');
		const bin = cliBin();
		if (!bin) throw new Error('Claude Code is not installed for this module. Run modules/claude/bin/install.');
		if (request.kind === 'token') return authLoginToken(bin, ctx, name);
		return authLoginBrowser(bin, request, ctx, name);
	};

	// Runs Claude Code's "setup-token" on the terminal, then asks for the token it printed (hidden input)
	// and saves it to credentials.json; the token never passes through arguments, history or logs.
	const authLoginToken = async (bin: string, ctx: CommandContext, name: string | undefined): Promise<void> => {
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
		const account = await storeOauthToken(dataDir, token, name, env);
		log.info('subscription token stored');
		ctx.print(`Subscription token stored as account "${account.name}" in ${join(dataDir, 'accounts.json')} (mode 0600).`);
		await noteIfShadowed(account.name, ctx);
	};

	// Claude Code's own browser login; yena never sees the tokens, it only asks the CLI afterwards.
	const authLoginBrowser = async (
		bin: string,
		request: Extract<LoginRequest, {kind: 'browser'}>,
		ctx: CommandContext,
		name: string | undefined,
	): Promise<void> => {
		const paths = loginPaths();
		const {meta} = request;
		if (chatRunning()) throw new Error('A chat is answering; wait for it (a sign-in replaces the login Claude Code is using)');
		// The login there now is kept in its account before Claude Code replaces it.
		stashLogin(accountsCtx({env, dataDir}));
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
		const account = adoptLogin(accountsCtx({env, dataDir}), name);
		ctx.print(
			status.method === 'claude.ai'
				? `Signed in with Claude Code (claude.ai) as account "${account.name}". Its login is kept in ${join(dataDir, 'accounts', account.name)} (mode 0600) and swapped into ${paths.loginFile} when it is used; Claude Code refreshes it.`
				: `Signed in with Claude Code (Console account) as account "${account.name}".`,
		);
		await noteIfShadowed(account.name, ctx);
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
			case 'accounts':
			case 'list':
				return authAccounts(rest, ctx);
			case 'order':
				return authOrder(rest, ctx);
			case 'use':
				return authUse(rest, ctx);
			case 'remove':
				return authRemove(rest, ctx);
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
		{name: 'start', usage: 'claude start <message…>', description: 'Start a new chat and send it the message (the open chat is saved)', agent: 'confirm'},
		{name: 'resume', usage: 'claude resume [session]', description: 'Continue an earlier chat (pick from a list, or give an id prefix)', agent: 'deny'},
		{name: 'rewind', usage: 'claude rewind', description: 'Go back to before one of your messages (files and conversation)', agent: 'deny'},
		{name: 'fork', usage: 'claude fork', description: 'Continue the current chat on a new branch', agent: 'deny'},
		{name: 'rename', usage: 'claude rename <name>', description: 'Name the current chat', agent: 'confirm'},
		{name: 'export', usage: 'claude export [file]', description: 'Save the current chat as Markdown', agent: 'confirm'},
		{name: 'copy', usage: 'claude copy [N]', description: "Copy Claude's last (or Nth last) answer to the clipboard", agent: 'deny'},
		{name: 'memory', usage: 'claude memory [file]', description: 'Edit CLAUDE.md (or another md instruction file) in your editor', agent: 'deny'},
		{name: 'code', usage: 'claude code [args…]', description: 'Run the Claude Code CLI in this terminal (bin/claude; arguments are passed on)', agent: 'deny'},
		{name: 'tasks', usage: 'claude tasks', description: 'Background tasks and subagents of the chat; pick one to stop it', agent: 'safe'},
		{name: 'mcp', usage: 'claude mcp [reconnect <server>]', description: 'MCP servers of the chat and their status', agent: 'safe'},
		{name: 'session', usage: 'claude session', description: 'Show the current session, model and runtime', agent: 'safe'},
		{name: 'sessions', usage: 'claude sessions', description: 'Show the running chat or ask, in any yena or in the background', agent: 'safe'},
		{name: 'stop', usage: 'claude stop [session]', description: 'Stop the running chat or ask', agent: 'confirm'},
		{
			name: 'auth',
			usage: 'claude auth <status|accounts|login|key|order|use|remove|logout>',
			description:
				'Accounts in priority order (the next takes over at a limit): accounts, login [--name <n>] [--console|--sso|--email <a>|--token], key --from-file <path>, order, use, remove, status, logout',
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
				case 'start':
					return startChat(args, ctx);
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
				case 'code':
					return code(args, ctx);
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
