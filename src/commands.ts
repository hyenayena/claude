import {accessSync, constants} from 'node:fs';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path, {join} from 'node:path';
import type {ArgumentDoc, BuildInfo, Command, CommandContext, DevFailure, Logger, OptionDoc, SettingsTab, Subcommand} from '../../../src/api.js';
import {createFixCommand} from './fix.js';
import {chatSettings, tuningFromState, type LivePatch} from './chat-prefs.js';
import {CONTINUE_TEXT, isCommandName, type SlashCommandInfo} from './chat/chat-session.js';
import {type AccountView, adoptLoginAccount, checkAccountName, chooseAccount, listAccounts, LoginUnsavedError, markLimited, newAccountNameProblem, removeAccount, setOrder, suggestSecretName, useAccount} from './accounts.js';
import {snapshotLogin} from './login-slot.js';
import {legacyCount} from './migrate.js';
import {degradedReason, type ClaudeVault} from './vault.js';
import {formatReset, systemClock} from './chat/limits.js';
import type {ChatHandle} from './chat/handle.js';
import {usageLines} from './chat/usage.js';
import {clockTime} from './clock-time.js';
import {runnerSocketPath} from './runner/spawn.js';
import {diskCommands} from './disk-commands.js';
import {listPrompts, listSessions, readHistory} from './chat/history.js';
import {readSessionTitle, transcriptFile} from './chat/title.js';
import {ago, type PickerItem} from './ui/picker-model.js';
import {buildEnv, buildOptions, cliEnv, ensureMdLinks, resolvePaths, restrictDataDirs, runtimeInfo, withProjects} from './config.js';
import {parseLoginArgs, probeLogin, runLogout, type LoginProbe, type LoginRequest, type LoginStatus} from './claude-login.js';
import {
	accountsCtx,
	allSecrets,
	type CredentialOpts,
	describeCredential,
	inspectFileMode,
	isSubscription,
	loadBundle,
	loginSyncOf,
	makeRedactor,
	noCredentials,
	prepareCredential,
	registerLogRedaction,
	removeStored,
	resolveCredential,
	storeSecret,
	vaultOf,
} from './credentials.js';
import {editFile, readHidden, readLine, runInteractive, runInteractiveStatus, waitForEnter} from './terminal.js';
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

// Saved "always" rules: a Bash command, or a prefixed key for an MCP tool, a console command or a fetched host.
const ruleKind = (rule: string): string =>
	rule.startsWith('mcp:')
		? 'MCP tool allowed with "always"'
		: rule.startsWith('cmd:')
			? 'Console command allowed with "always"'
			: rule.startsWith('web:')
				? 'Host WebFetch may reach without asking'
				: 'Bash command allowed with "always"';

const LIMIT_KINDS = new Set(['usage-limit', 'rate-limit', 'billing', 'context']);
const MAX_ASK_SWITCHES = 8;
const LIMIT_HOLD_S = 5 * 3600;
const BILLING_HOLD_S = 24 * 3600;

const limitKind = (err: unknown): string | undefined =>
	err instanceof TurnFailure && err.kind !== undefined && LIMIT_KINDS.has(err.kind) ? err.kind : undefined;

export type ClaudeDeps = {
	dataDir: string;
	// The host's record of a failed dev start, for `fix`; absent in older hosts.
	devFailure?: () => Promise<DevFailure | undefined>;
	// Versions of the host and modules, shown at the top of a new chat.
	build?: BuildInfo;
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
	// Stored Claude accounts (the host's credential channel); without it only the environment variables count.
	vault?: ClaudeVault;
	// The host's redactor (every module's registered secrets), applied after claude's own.
	redactExtra?: (text: string) => string;
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
		// Asks for a key or token with hidden input ('' when cancelled); replaceable so tests never mount a view.
		promptSecret?: (ctx: CommandContext, label: string) => Promise<string>;
		readName?: (prompt: string) => string;
		// Asks for the new account's name, prefilled with `initial` (undefined when cancelled).
		promptName?: (ctx: CommandContext, label: string, initial: string, validate: (value: string) => string | undefined) => Promise<string | undefined>;
	};
};

const USAGE = 'Usage: claude <ping|ask|chat|new|start|resume|rewind|fork|rename|export|copy|memory|code|tasks|mcp|session|sessions|stop|auth|help|<Claude Code command>>';
const RESUME_USAGE = 'Usage: claude resume [session]';
const NO_CHAT = 'No chat is open. Claude Code commands run in the open chat; start one with "chat".';
const ASK_USAGE = 'Usage: claude ask [--new] <text…>';
const AUTH_USAGE = 'Usage: claude auth <status|login|add|order|use|remove|logout>';
const ORDER_USAGE = 'Usage: claude auth order <account>…';
const ADD_USAGE = 'Usage: claude auth add [--name <account>]';
const CHAT_NEW_USAGE = 'Usage: chat [model]';
const START_USAGE = 'Usage: claude start <message…>';
const START_MAX = 20_000;
const SEND_USAGE = 'Usage: claude send <message…>';
const STOP_USAGE = 'Usage: claude stop [session]';

const SLOT_WORD = /^(?:<([A-Za-z0-9_][\w-]*)(?:…|\.\.\.)?>|\[([A-Za-z0-9_][\w-]*)(?:…|\.\.\.)?\])(?:…|\.\.\.)?$/u;

// Claude Code's argument hints are free text: one goes into the usage only when every word is a plain slot.
const passthroughUsage = (name: string, hint: string | undefined): Pick<Subcommand, 'usage' | 'args'> => {
	const words = (hint ?? '').trim().split(/\s+/u).filter(w => w !== '');
	const slots = words.map(w => {
		const m = SLOT_WORD.exec(w);
		return m?.[1] ?? m?.[2];
	});
	if (slots.every((s): s is string => s !== undefined)) {
		return {
			usage: ['claude', name, ...words].join(' '),
			args: [...new Set(slots)].map(s => ({name: s, description: 'Argument of the Claude Code command'})),
		};
	}
	return {
		usage: `claude ${name} [args…]`,
		args: [{name: 'args', description: `Arguments, as Claude Code describes them: ${Array.from(words.join(' ')).slice(0, 80).join('')}`}],
	};
};

const passthroughDescription = (text: string | undefined): string => {
	const clean = (text ?? '').replace(/\s+/gu, ' ').trim().replace(/\.+$/u, '');
	if (clean === '') return 'Claude Code command (runs in the open chat)';
	const chars = Array.from(`Claude Code: ${clean}`);
	return chars.length <= 90 ? chars.join('') : `${chars.slice(0, 89).join('')}…`;
};

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
	stored: 'stored in the account module',
};

const UNUSABLE_LABELS: Record<NonNullable<AccountView['unusable']>, string> = {
	disabled: 'disabled in the account module',
	reserved: 'not used: the name is reserved for an environment variable',
	missing: 'not used: no secret is set',
};

const LOGOUT_USAGE = 'Usage: claude auth logout';

const isMissingModule = (err: unknown): boolean => {
	const code = (err as {code?: unknown} | null)?.code;
	return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
};

export const createClaudeCommand = (deps: ClaudeDeps): Command => createClaudeCommands(deps).find(c => c.name === 'claude')!;

/** The `claude` command and the top-level `chat` command, sharing one chat slot. */
export const createClaudeCommands = (deps: ClaudeDeps): Command[] => {
	const {dataDir, env} = deps;
	const log = deps.log ?? noopLog;
	const store = createStore(dataDir, log);
	const credOpts: CredentialOpts = {env, dataDir, log, ...(deps.vault && {vault: deps.vault})};
	const vault = vaultOf(credOpts);
	const loginSync = () => loginSyncOf(credOpts);
	const redactor = (cred?: Credential) => makeRedactor(cred, allSecrets(credOpts), deps.redactExtra);
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
	const readName = deps.login?.readName ?? readLine;
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
	const switchAfterLimit = async (err: unknown, cred: Credential): Promise<Credential | undefined> => {
		const kind = limitKind(err);
		if ((kind !== 'usage-limit' && kind !== 'billing') || cred.account === undefined) return undefined;
		// A login refreshed during the turn is saved before another one may be swapped in.
		await loginSync().sync();
		const ctx = accountsCtx(credOpts);
		const now = Date.now() / 1000;
		const resetsAt = err instanceof TurnFailure ? err.rateLimit?.resetsAt : undefined;
		const until = kind === 'billing' ? now + BILLING_HOLD_S : resetsAt !== undefined && resetsAt > now ? resetsAt : now + LIMIT_HOLD_S;
		markLimited(ctx, cred.account, until, kind);
		const next = chooseAccount(ctx);
		log.info('account limited', {reason: kind, next: next !== undefined && next.limitedUntil === undefined && next.name !== cred.account});
		if (!next || next.limitedUntil !== undefined || next.name === cred.account) return undefined;
		try {
			return prepareCredential(credOpts);
		} catch (e) {
			if (!(e instanceof LoginUnsavedError)) throw e;
			log.info('account switch skipped', {reason: 'login-unsaved'});
			return undefined;
		}
	};

	// The ask lock is held: a login account can be swapped into the config dir.
	const prepareAsk = async (): Promise<Credential> => {
		await loadBundle(credOpts);
		try {
			return prepareCredential(credOpts);
		} catch (err) {
			if (!(err instanceof LoginUnsavedError)) throw err;
			await loginSync().sync();
			return prepareCredential(credOpts);
		}
	};

	const runAsk = async (text: string, fresh: boolean, ctx: CommandContext): Promise<void> => {
		let cred: Credential;
		try {
			cred = await prepareAsk();
		} catch (err) {
			log.warn('no credential');
			throw err;
		}
		registerLogRedaction(log, cred);
		log.info('credential resolved', {kind: cred.kind, source: cred.source});
		const redact = redactor(cred);
		const scrub = makeScrub(redact);
		await showNoticeOnce(cred, ctx);
		ctx.print('Asking yena…');
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
			restrictDataDirs(paths);
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
				const next = !timedOut && switches < MAX_ASK_SWITCHES ? await switchAfterLimit(err, cred) : undefined;
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
			await loginSync().sync();
		}
	};

	const unavailable = async (): Promise<never> => {
		throw new Error('The chat is not available in this build');
	};

	const chatDeps = (onMount: (close: () => void) => void): ChatRunDeps => ({
		dataDir,
		...(deps.build && {build: deps.build}),
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
		probeLogin: probe,
		isMissingModule,
		vault,
		...(deps.redactExtra && {redactExtra: deps.redactExtra}),
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
		onInbox: deliver => {
			deliverToOpenChat = deliver;
		},
		onRulesChanged: () => void refreshRules(),
		inputMode: () => inputMode,
		acquire: () => acquireShared('chat'),
	});

	let openHandle: {close: () => void; done: Promise<void>} | undefined;
	let openSession: ChatHandle | undefined;
	let applyOpenChat: ((patch: LivePatch) => void) | undefined;
	let deliverToOpenChat: ((text: string) => void) | undefined;

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
				description: ruleKind(rule),
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

	// Into the chat view that is open (into the running turn while it answers); with none open, a new chat as "claude start".
	const sendToChat = async (args: string[], ctx: CommandContext): Promise<void> => {
		const text = args.join(' ').trim();
		if (text === '') throw new Error(SEND_USAGE);
		if (text.length > START_MAX) throw new Error(`The message is longer than ${START_MAX} characters`);
		const deliver = deliverToOpenChat;
		if (!deliver) return startChat(args, ctx);
		deliver(text);
		log.info('message sent to the open chat', {chars: text.length, byCaller: ctx.signal !== undefined});
		ctx.print('Sent the message to the open chat.');
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
		if (session.state === 'running') throw new Error('yena is still answering; wait or press Esc in the chat.');
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
		for (const m of messages) body.push(m.role === 'user' ? '## You' : '## yena', '', m.text, '');
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
		if (args.length > 1 || !Number.isInteger(n) || n < 1) throw new Error('Usage: claude copy [n]');
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
		const active = await resolveCredential(credOpts);
		const scrub = makeScrub(redactor(active));
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
		const active = await resolveCredential(credOpts);
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
		const chosen = chooseAccount(accountsCtx(credOpts));
		const scrub = makeScrub(redactor());
		const width = Math.max(...list.map(a => a.name.length));
		return list.map((a, i) => {
			const what =
				a.type === 'login'
					? `${TYPE_LABELS.login} (${a.kind === 'oauth' ? 'subscription' : 'Console'}${a.email ? `, ${a.email}` : ''}; stored in the account module)`
					: a.type === 'env'
						? `${a.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'} (${TYPE_LABELS.env})`
						: `${TYPE_LABELS[a.type]} (stored in the account module)`;
			const state =
				a.unusable !== undefined
					? UNUSABLE_LABELS[a.unusable]
					: a.limitedUntil !== undefined
						? `${a.reason === 'billing' ? 'billing failed' : 'limit reached'}, back at ${formatReset(a.limitedUntil, systemClock)}`
						: '';
			const mark = chosen?.name === a.name ? '▸' : ' ';
			return scrub(`${mark} ${i + 1}. ${a.name.padEnd(width)}  ${what}${state ? `  · ${state}` : ''}`);
		});
	};

	const authStatus = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude auth status');
		await loadBundle(credOpts);
		await loginSync().sync();
		const list = listAccounts(accountsCtx(credOpts));
		const active = await resolveCredential(credOpts);
		const status = vault.current().status;
		log.info('auth status', {kind: active?.kind, source: active?.source, accounts: list.length, limited: list.filter(a => a.limitedUntil !== undefined).length});
		if (!active) {
			ctx.print(noCredentials(vault.current()));
		} else {
			ctx.print(`Active credential: ${describeCredential(active)}`);
			ctx.print('Accounts, in priority order (▸ is used next; when it reaches its limit, the next one takes over):');
			for (const line of accountLines(list)) ctx.print(line);
			const reason = degradedReason(status);
			if (reason) ctx.print(reason);
		}
		const waiting = status === 'ok' ? 0 : legacyCount(dataDir, join(dataDir, 'config'));
		if (waiting > 0) {
			ctx.print(`${waiting} stored Claude account${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} to move to the account module: account grant claude`);
		}
		for (const warning of await inspectFileMode(dataDir)) ctx.print(`Warning: ${warning}`);
		if (active) await showNoticeOnce(active, ctx);
	};

	const authOrder = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length === 0) throw new Error(ORDER_USAGE);
		await loadBundle(credOpts);
		const list = setOrder(accountsCtx(credOpts), args);
		log.info('auth order', {count: list.length});
		for (const line of accountLines(list)) ctx.print(line);
	};

	const authUse = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 1) throw new Error('Usage: claude auth use <account>');
		await loadBundle(credOpts);
		const list = useAccount(accountsCtx(credOpts), args[0]!);
		log.info('auth use', {count: list.length});
		ctx.print(`"${args[0]}" is first now and its limit is forgotten; new turns use it.`);
		for (const line of accountLines(list)) ctx.print(line);
	};

	const authRemove = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 1) throw new Error('Usage: claude auth remove <account>');
		await loadBundle(credOpts);
		const {wasInstalled} = await removeAccount(accountsCtx(credOpts), vault, args[0]!);
		log.info('auth remove', {login: wasInstalled});
		ctx.print(`Account "${args[0]}" removed${wasInstalled ? '; Claude Code is signed out of it' : ''}.`);
		if (chatOpen) ctx.print('The open chat keeps its current account until Claude Code restarts.');
		await printActive(ctx);
	};

	// In the app a hidden input in the console panel; from a terminal (./yena claude auth add) a read without echo.
	const promptSecret =
		deps.login?.promptSecret ??
		(async (ctx: CommandContext, label: string): Promise<string> => {
			if (ctx.mount && !ctx.headless) {
				const {secretPrompt} = await import('./ui/secret-prompt.js');
				let value = '';
				await ctx.mount(control => secretPrompt(control, label, v => (value = v)), {target: 'panel'});
				return value;
			}
			if (ctx.suspend) return ctx.suspend(() => readSecret(`${label} (input hidden): `));
			throw new Error('"claude auth add" needs the app (./yena) or a terminal: the key is typed into a hidden input');
		});

	// The account name, prefilled with `initial`: a text input in the app, a line on the terminal; undefined when cancelled.
	const promptName =
		deps.login?.promptName ??
		(async (ctx: CommandContext, label: string, initial: string, validate: (v: string) => string | undefined): Promise<string | undefined> => {
			if (ctx.mount && !ctx.headless) {
				const {namePrompt} = await import('./ui/name-prompt.js');
				let value: string | undefined;
				await ctx.mount(control => namePrompt(control, label, initial, validate, v => (value = v)), {target: 'panel'});
				return value;
			}
			if (!ctx.suspend) return initial;
			return ctx.suspend(() => {
				let problem: string | undefined;
				for (let i = 0; i < 3; i++) {
					const typed = readName(`${problem ? `${problem}\n` : ''}${label} [${initial}]: `).trim();
					const name = typed === '' ? initial : typed;
					problem = validate(name);
					if (!problem) return name;
				}
				throw new Error(problem);
			});
		});

	// A key or token is typed into a hidden input only: never an argument, a file, the history or the log.
	const authAdd = async (rawArgs: string[], ctx: CommandContext): Promise<void> => {
		const {name: given, rest} = takeName(rawArgs);
		if (rest.length > 0) {
			throw new Error(`Keys and tokens are not accepted as arguments: they would stay in the scrollback and history. ${ADD_USAGE}`);
		}
		const reason = degradedReason((await loadBundle(credOpts)).status);
		if (reason) throw new Error(reason);
		const value = (await promptSecret(ctx, 'API key (sk-ant-…) or subscription token (sk-ant-oat…)')).trim();
		if (value === '') {
			ctx.print('Cancelled; nothing was saved.');
			return;
		}
		let name = given;
		if (name === undefined) {
			const actx = accountsCtx(credOpts);
			name = await promptName(ctx, 'Account name', suggestSecretName(actx, value), v => newAccountNameProblem(actx, v));
			if (name === undefined) {
				ctx.print('Cancelled; nothing was saved.');
				return;
			}
		}
		const account = await storeSecret(credOpts, value, name);
		log.info('credential stored', {type: account.type});
		ctx.print(`${account.type === 'token' ? 'Subscription token' : 'API key'} stored as account "${account.name}" in the account module (account list shows it).`);
		await noteIfShadowed(account.name, ctx);
		if (account.type === 'token') await showNoticeOnce({kind: 'oauth', source: 'stored'}, ctx);
	};

	// Says so when a new account is not the one used next.
	const noteIfShadowed = async (name: string, ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential(credOpts);
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
		const removed = await removeStored(credOpts);
		log.info('stored credential removed', {removed});
		ctx.print(
			removed
				? 'Every stored account removed (keys, tokens and logins). Environment variables are not touched. "claude auth remove <account>" removes one.'
				: 'No stored account.',
		);
		const reason = degradedReason(vault.current().status);
		if (reason) ctx.print(reason);
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
		// Claude Code may have refreshed the login, or signed in to another account.
		await loadBundle(credOpts);
		await loginSync().sync();
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
		return authLoginBrowser(bin, request, ctx, name);
	};

	// Claude Code's own browser login; yena never sees the tokens, it only asks the CLI afterwards.
	const authLoginBrowser = async (
		bin: string,
		request: LoginRequest,
		ctx: CommandContext,
		name: string | undefined,
	): Promise<void> => {
		const paths = loginPaths();
		const {meta} = request;
		if (chatRunning()) throw new Error('A chat is answering; wait for it (a sign-in replaces the login Claude Code is using)');
		const reason = degradedReason((await loadBundle(credOpts)).status);
		if (reason) throw new Error(reason);
		// The login there now is kept in its account before Claude Code replaces it.
		await loginSync().sync();
		if (loginSync().dirty()) throw new LoginUnsavedError();
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
		const slot = snapshotLogin(paths.configDir);
		if (!slot) throw new Error('Claude Code has no login in its config dir');
		const account = await adoptLoginAccount(accountsCtx(credOpts), vault, name, slot);
		ctx.print(
			status.method === 'claude.ai'
				? `Signed in with Claude Code (claude.ai) as account "${account.name}". Its login is stored in the account module and copied into Claude Code's config when it is used; Claude Code refreshes it and yena saves it back.`
				: `Signed in with Claude Code (Console account) as account "${account.name}" (stored in the account module).`,
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
				return authStatus(rest, ctx);
			case 'order':
				return authOrder(rest, ctx);
			case 'use':
				return authUse(rest, ctx);
			case 'remove':
				return authRemove(rest, ctx);
			case 'add':
				return authAdd(rest, ctx);
			case 'logout':
				return authLogout(rest, ctx);
			case 'login':
				return authLogin(rest, ctx);
			case undefined:
				if (!ctx.showHelp) throw new Error(AUTH_USAGE);
				return ctx.showHelp(['auth']);
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

	const ACCOUNT_ARG: ArgumentDoc = {name: 'account', description: 'Account name, as "claude auth status" lists it'};
	const NAME_OPTION: OptionDoc = {name: '--name', value: '<account>', description: 'Name of the new account (asked for when left out)'};
	const SESSION_ARG = (what: string): ArgumentDoc => ({name: 'session', description: `Session id or a prefix of it; ${what}`});
	const MESSAGE_ARG: ArgumentDoc = {name: 'message', description: 'Text of the message'};

	const OWN_SUBCOMMANDS: Subcommand[] = [
		{name: 'ping', usage: 'claude ping', description: 'Check that the claude module is loaded', agent: 'confirm'},
		{
			name: 'ask',
			usage: 'claude ask [--new] <text…>',
			description: 'Ask yena a question in the last session',
			agent: 'deny',
			args: [{name: 'text', description: 'The question; put "--" before text that starts with "--"'}],
			options: [{name: '--new', description: 'Ask in a new session'}],
		},
		{
			name: 'chat',
			usage: 'claude chat [--new]',
			description: 'Open an interactive chat in the last session',
			agent: 'deny',
			options: [{name: '--new', description: 'Start a new session'}],
		},
		{
			name: 'new',
			usage: 'claude new [model]',
			description: 'Start a new chat',
			agent: 'deny',
			args: [{name: 'model', description: 'Model of the chat (default: the one in the settings)'}],
		},
		{
			name: 'start',
			usage: 'claude start <message…>',
			description: 'Start a new chat and send it the message',
			agent: 'confirm',
			args: [MESSAGE_ARG],
			notes: ['The open chat is saved and can be resumed.'],
		},
		{
			name: 'send',
			usage: 'claude send <message…>',
			description: 'Send the message to the open chat, or start one',
			agent: 'confirm',
			args: [MESSAGE_ARG],
			notes: ['While the chat answers, the message goes into the running answer.'],
		},
		{
			name: 'resume',
			usage: 'claude resume [session]',
			description: 'Continue an earlier chat',
			agent: 'deny',
			args: [SESSION_ARG('without it, pick from a list')],
		},
		{name: 'rewind', usage: 'claude rewind', description: 'Go back to before one of your messages (files and conversation)', agent: 'deny'},
		{name: 'fork', usage: 'claude fork', description: 'Continue the current chat on a new branch', agent: 'deny'},
		{
			name: 'rename',
			usage: 'claude rename <name>',
			description: 'Name the current chat',
			agent: 'confirm',
			args: [{name: 'name', description: 'New name of the chat'}],
		},
		{
			name: 'export',
			usage: 'claude export [file]',
			description: 'Save the current chat as Markdown',
			agent: 'confirm',
			args: [{name: 'file', description: 'Target file in the project (default: a new file in the exports folder)'}],
		},
		{
			name: 'copy',
			usage: 'claude copy [n]',
			description: "Copy yena's last answer to the clipboard",
			agent: 'deny',
			args: [{name: 'n', description: 'Which answer, counted from the end (default: 1, the last)'}],
		},
		{
			name: 'memory',
			usage: 'claude memory [file]',
			description: 'Edit an md instruction file in your editor',
			agent: 'deny',
			args: [{name: 'file', description: 'File in the md directory (default: CLAUDE.md)'}],
		},
		{
			name: 'code',
			usage: 'claude code [args…]',
			description: 'Run the Claude Code CLI in this terminal',
			agent: 'deny',
			args: [{name: 'args', description: 'Arguments passed on to bin/claude as they are'}],
		},
		{name: 'tasks', usage: 'claude tasks', description: 'Background tasks and subagents of the chat; pick one to stop it', agent: 'safe'},
		{
			name: 'mcp',
			usage: 'claude mcp',
			description: 'MCP servers of the chat and their status',
			agent: 'safe',
			subcommands: [
				{
					name: 'reconnect',
					usage: 'claude mcp reconnect <server>',
					description: 'Reconnect an MCP server of the chat',
					args: [{name: 'server', description: 'Server name, as "claude mcp" lists it'}],
				},
			],
		},
		{name: 'session', usage: 'claude session', description: 'Show the current session, model and runtime', agent: 'safe'},
		{name: 'sessions', usage: 'claude sessions', description: 'Show the running chat or ask, in any yena or in the background', agent: 'safe'},
		{
			name: 'stop',
			usage: 'claude stop [session]',
			description: 'Stop the running chat or ask',
			agent: 'confirm',
			args: [SESSION_ARG('stops only when the running one matches')],
		},
		{
			name: 'auth',
			usage: 'claude auth <subcommand>',
			description: 'Accounts in priority order; the next one takes over at a limit',
			args: [{name: 'subcommand', description: 'One of the subcommands below'}],
			agent: 'confirm',
			subcommands: [
				{name: 'status', usage: 'claude auth status', description: 'Show the active credential and the accounts in order', agent: 'confirm'},
				{
					name: 'login',
					usage: 'claude auth login [--name <account>] [--console | --claudeai] [--sso] [--email <address>]',
					description: "Sign in with Claude Code's browser login",
					// Hands over the terminal (ctx.suspend), which an assistant run does not have.
					agent: 'deny',
					options: [
						NAME_OPTION,
						{name: '--console', description: 'Sign in with an Anthropic Console account (API billing)'},
						{name: '--claudeai', description: 'Sign in with a claude.ai subscription'},
						{name: '--sso', description: 'Sign in through single sign-on'},
						{name: '--email', value: '<address>', description: 'Email address to prefill on the login page'},
					],
				},
				{
					name: 'add',
					usage: 'claude auth add [--name <account>]',
					description: 'Add an API key or subscription token (typed into a hidden input)',
					agent: 'confirm',
					options: [NAME_OPTION],
				},
				{
					name: 'order',
					usage: 'claude auth order <account>…',
					description: 'Set the priority order of the accounts',
					agent: 'confirm',
					args: [{...ACCOUNT_ARG, description: 'Accounts, first one first; the ones left out follow'}],
				},
				{
					name: 'use',
					usage: 'claude auth use <account>',
					description: 'Put an account first and forget its limit',
					agent: 'confirm',
					args: [ACCOUNT_ARG],
				},
				{name: 'remove', usage: 'claude auth remove <account>', description: 'Remove an account', agent: 'confirm', args: [ACCOUNT_ARG]},
				{name: 'logout', usage: 'claude auth logout', description: 'Sign Claude Code out of its current login', agent: 'confirm'},
			],
		},
	];
	// `help` stays reserved: a Claude Code /help listed here would replace core's help subcommand.
	const ownNames = new Set([...OWN_SUBCOMMANDS.map(s => s.name), 'help']);

	const claudeCodeSubcommands = (): Subcommand[] => {
		const known: SlashCommandInfo[] =
			openSession && openSession.state !== 'closed' && openSession.commands.length > 0
				? [...openSession.commands]
				: diskCommands(resolvePaths(dataDir, deps.moduleDir).configDir);
		return known
			.filter(c => !ownNames.has(c.name))
			.map(c => ({name: c.name, description: passthroughDescription(c.description), ...passthroughUsage(c.name, c.argumentHint)}));
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
		if (session.state === 'running') throw new Error('yena is still answering; wait or press Esc in the chat.');
		session.send(`/${name}${args.length > 0 ? ` ${args.join(' ')}` : ''}`, {command: true});
		log.info('claude code command sent', {command: name, args: args.length});
		ctx.print(`Sent /${name} to the chat`);
	};

	const claude: Command = {
		name: 'claude',
		description: 'Claude Code integration',
		usage: 'claude <subcommand> [args…]',
		agent: 'deny',
		args: [
			{name: 'subcommand', description: 'One of the subcommands below, or a Claude Code command of the open chat'},
			{name: 'args', description: 'Its arguments'},
		],
		get subcommands() {
			return [...OWN_SUBCOMMANDS, ...claudeCodeSubcommands()];
		},
		get settings() {
			return permissionsTab();
		},
		run: async ([sub, ...args], ctx) => {
			switch (sub) {
				case undefined:
					if (!ctx.showHelp) throw new Error(USAGE);
					return ctx.showHelp();
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
				case 'send':
					return sendToChat(args, ctx);
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
		args: [{name: 'model', description: 'Model of the chat (default: the one in the settings)'}],
		agent: 'deny',
		autostart: true,
		settings: {
			title: 'Chat',
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
	const fix = createFixCommand({...(deps.devFailure && {devFailure: deps.devFailure}), start: (message, ctx) => startChat([message], ctx)});
	return [chatCommand, claude, fix];
};
