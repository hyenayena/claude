import type {CommandContext, Logger} from '../../../src/api.js';
import type {ClaudeDeps} from './commands.js';
import type {LivePatch} from './chat-prefs.js';
import {clockTime} from './clock-time.js';
import {isSubscription, vaultOf, type CredentialOpts} from './credentials.js';
import {errClass} from './log.js';
import {runnerSocketPath} from './runner/spawn.js';
import {makeScrub, type Tier} from './deps/chat.js';
import {loadRetiredCredentials} from './deps/account.js';
import type {ChatRoute, ChatRouteRequest, ChatRunDeps} from './chat/command.js';
import type {ClaudeChatHandle} from './chat/handle.js';
import {queryStatus, serveControl, type ControlServer, type ControlStatus} from './sessions/control.js';
import {acquireLock, isSessionId, readHolder, type LockInfo, type LockKind, type SessionLock} from './sessions/lock.js';
import {createTurnLock, type TurnLock} from './sessions/turn-lock.js';
import type {createStore} from './store.js';
import type {CredentialInfo} from './types.js';

const SUBSCRIPTION_NOTICE_VERSION = 2;
const SUBSCRIPTION_NOTICE =
	"Notice: you are using your own Claude subscription through Claude Code's own sign-in (or CLAUDE_CODE_OAUTH_TOKEN from your environment). Anthropic allows this for ordinary, individual use of Claude Code and the Agent SDK by the plan's purchaser; yena does not store or pass on Claude.ai credentials and does not switch accounts at a usage limit. Use only accounts that are your own (Anthropic's Consumer Terms do not allow sharing accounts). Do not share this setup or run it for others; see README \"Policy caveat\". API keys are recommended for everyone and for anything else (\"claude auth add\" or ANTHROPIC_API_KEY).";

export const isMissingModule = (err: unknown): boolean => {
	const code = (err as {code?: unknown} | null)?.code;
	return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
};

type Acquired = {ok: true; release: () => void} | {ok: false; holder?: LockInfo; unknown?: true};

export type SessionHub = {
	readonly store: ReturnType<typeof createStore>;
	readonly credOpts: CredentialOpts;
	readonly log: Logger;
	chatOpen: boolean;
	askRunning: boolean;
	askAbort: (() => void) | undefined;
	openHandle: {close: () => void; done: Promise<void>} | undefined;
	openSession: ClaudeChatHandle | undefined;
	applyOpenChat: ((patch: LivePatch) => void) | undefined;
	setOpenTier: ((tier: Tier | 'auto') => void) | undefined;
	refreshOpenPin: (() => void) | undefined;
	deliverToOpenChat: ((text: string) => void) | undefined;
	openKeyOnly: boolean;
	inputMode: 'normal' | 'vim';
	onRulesChanged: (() => void) | undefined;
	sessionsDir(): string | undefined;
	busyMessage(holder: LockInfo | undefined): string;
	localStatus(kind: LockKind, startedAt: number): ControlStatus;
	claimBusy(kind: LockKind): () => void;
	tryAcquire(kind: LockKind): Acquired;
	acquireShared(kind: LockKind): () => void;
	acquireAsk(): Promise<() => void>;
	routeChat(req: ChatRouteRequest): ChatRoute;
	turnBusy(holder: LockInfo | undefined): string;
	chatTurnLock(): TurnLock;
	peekLock(): Promise<{free: boolean; title?: string}>;
	showRetiredOnce(ctx: Pick<CommandContext, 'print'>): Promise<void>;
	showNoticeOnce(cred: CredentialInfo, ctx: Pick<CommandContext, 'print'>): Promise<void>;
	runDeps(onMount?: (close: () => void) => void): ChatRunDeps;
};

export const unavailable = async (): Promise<never> => {
	throw new Error('The chat is not available in this build');
};

export const createSessionHub = (
	deps: ClaudeDeps,
	store: ReturnType<typeof createStore>,
	credOpts: CredentialOpts,
	log: Logger,
): SessionHub => {
	const {dataDir, env} = deps;

	const hub: SessionHub = {
		store,
		credOpts,
		log,
		chatOpen: false,
		askRunning: false,
		askAbort: undefined,
		openHandle: undefined,
		openSession: undefined,
		applyOpenChat: undefined,
		setOpenTier: undefined,
		refreshOpenPin: undefined,
		deliverToOpenChat: undefined,
		openKeyOnly: false,
		inputMode: 'normal',
		onRulesChanged: undefined,

		sessionsDir: () => {
			if (!deps.sessionDir) return undefined;
			try {
				return deps.sessionDir();
			} catch (err) {
				log.warn('session directory unavailable', {error: errClass(err)});
				return undefined;
			}
		},

		busyMessage: holder => {
			if (!holder) return 'A session is starting. Wait a moment or run "claude sessions".';
			const what = holder.sessionId ? `${holder.kind} ${holder.sessionId.slice(0, 8)}` : holder.kind;
			return `A session is running (${what} since ${clockTime(holder.startedAt)}). Wait for it or run "claude stop".`;
		},

		localStatus: (kind, startedAt) => {
			const open = hub.openSession;
			const s = kind === 'chat' && open && open.state !== 'closed' ? open : undefined;
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
		},

		claimBusy: kind => {
			if (kind === 'chat') hub.chatOpen = true;
			else hub.askRunning = true;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (kind === 'chat') hub.chatOpen = false;
				else hub.askRunning = false;
			};
		},

		tryAcquire: kind => {
			if (hub.askRunning) throw new Error('An ask is already running');
			if (kind === 'chat' && hub.chatOpen) throw new Error('A chat is already open');
			const dir = hub.sessionsDir();
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
			const unbusy = hub.claimBusy(kind);
			let released = false;
			let server: ControlServer | undefined;
			if (dir && lock) {
				const held = lock;
				const syncId = (): void => {
					const id = kind === 'chat' ? hub.openSession?.sessionId : undefined;
					if (id && isSessionId(id) && id !== held.info.sessionId) held.update({sessionId: id});
				};
				void serveControl({
					dir,
					log,
					handlers: {
						status: () => {
							syncId();
							return hub.localStatus(kind, held.info.startedAt);
						},
						stop: async () => {
							if (kind === 'ask') return hub.askAbort?.();
							await hub.openSession?.interrupt().catch(() => {});
							hub.openHandle?.close();
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
		},

		acquireShared: kind => {
			const got = hub.tryAcquire(kind);
			if (!got.ok) throw new Error(hub.busyMessage(got.holder));
			return got.release;
		},

		acquireAsk: async () => {
			const got = hub.tryAcquire('ask');
			if (got.ok) return got.release;
			const dir = hub.sessionsDir();
			const status = dir && got.holder ? await queryStatus(dir, 500).catch(() => undefined) : undefined;
			const title = status?.title ? makeScrub(s => s)(status.title).slice(0, 80) : '';
			throw new Error(title ? `A session is running (${title}). Wait for it or run "claude stop".` : hub.busyMessage(got.holder));
		},

		routeChat: req => {
			if (hub.askRunning) throw new Error('An ask is already running');
			if (hub.chatOpen) throw new Error('A chat is already open');
			const dir = hub.sessionsDir();
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
						return {kind: 'attach', socketPath: runnerSocketPath(dir), release: hub.claimBusy('chat')};
					}
					return {kind: 'wait', message: hub.busyMessage(h)};
				}
				if (seen.unknown) return {kind: 'wait', message: hub.busyMessage(undefined)};
				if (req.keep && deps.spawnRunner) return {kind: 'spawn', sessionDir: dir, release: hub.claimBusy('chat')};
			}
			return {kind: 'local', release: hub.claimBusy('chat')};
		},

		turnBusy: holder =>
			`${hub.busyMessage(holder).replace(/ Wait for it or run "claude stop"\.$/, '')} Your message stays in the input; send it when that session is done.`,

		chatTurnLock: () =>
			createTurnLock({
				dir: hub.sessionsDir(),
				kind: 'chat',
				where: 'local',
				sessionId: () => hub.openSession?.sessionId,
				status: startedAt => hub.localStatus('chat', startedAt),
				stop: async () => {
					await hub.openSession?.interrupt().catch(() => {});
				},
				busy: hub.turnBusy,
				log,
			}),

		peekLock: async () => {
			const dir = hub.sessionsDir();
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
		},

		showRetiredOnce: async ctx => {
			let record;
			try {
				record = await (deps.loadRetired ?? loadRetiredCredentials)(dataDir);
			} catch (err) {
				log.warn('retired credentials record unavailable', {errClass: errClass(err)});
				return;
			}
			if (!record || (await store.read()).retiredNoticeAt === record.at) return;
			ctx.print(
				`yena no longer stores Claude logins or subscription tokens (Anthropic's rules: sign-in to a Claude account must complete through Claude Code's own flow). Removed from the account module: ${record.logins} login(s), ${record.tokens} token(s). The Claude Code login in use stays; "claude auth login" signs in to another account. A usage limit now ends the turn; yena no longer switches accounts on its own ("claude auth use <account>" picks one).`,
			);
			await store.update({retiredNoticeAt: record.at});
		},

		showNoticeOnce: async (cred, ctx) => {
			await hub.showRetiredOnce(ctx);
			if (!isSubscription(cred)) return;
			if (((await store.read()).subscriptionNotice ?? 0) >= SUBSCRIPTION_NOTICE_VERSION) return;
			ctx.print(SUBSCRIPTION_NOTICE);
			await store.update({subscriptionNotice: SUBSCRIPTION_NOTICE_VERSION});
		},

		runDeps: onMount => ({
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
			showNoticeOnce: hub.showNoticeOnce,
			...(credOpts.probeLogin && {probeLogin: credOpts.probeLogin}),
			isMissingModule,
			vault: vaultOf(credOpts),
			...(deps.redactExtra && {redactExtra: deps.redactExtra}),
			...(onMount && {onMount}),
			onSession: s => {
				hub.openSession = s;
			},
			route: hub.routeChat,
			turnLock: hub.chatTurnLock,
			peek: hub.peekLock,
			...(deps.spawnRunner && {spawnRunner: deps.spawnRunner}),
			...deps.chatTiming,
			onPin: refresh => {
				hub.refreshOpenPin = refresh;
			},
			onLive: apply => {
				hub.applyOpenChat = apply;
			},
			onTier: set => {
				hub.setOpenTier = set;
			},
			onInbox: deliver => {
				hub.deliverToOpenChat = deliver;
			},
			onRulesChanged: () => hub.onRulesChanged?.(),
			inputMode: () => hub.inputMode,
			acquire: () => hub.acquireShared('chat'),
		}),
	};

	void store.read().then(
		s => {
			hub.inputMode = s.chatInputMode === 'vim' ? 'vim' : 'normal';
		},
		() => {},
	);

	return hub;
};
