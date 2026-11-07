import type {CommandContext, Logger} from '../../../../src/api.js';
import type {ChatMode, OpenEnv, Tier} from '../deps/chat.js';
import {sessionSubscription} from '../session-accounts.js';
import {resolvePaths, type ClaudePaths} from '../config.js';
import {accountsCtx, liveSecrets, makeRedactor, registerLogRedaction, requireCredential, vaultOf, type CredentialOpts} from '../credentials.js';
import {pinnedAccount} from '../accounts.js';
import {errClass, noopLog} from '../log.js';
import type {ClaudeState, Credential} from '../types.js';
import {makeReveal, makeScrub} from '../deps/chat.js';
import type {ChatTuning, LivePatch} from '../chat-prefs.js';
import type {LoginProbe} from '../claude-login.js';
import type {ClaudeVault} from '../vault.js';
import type {spawnRunner} from '../runner/spawn.js';
import type {ChatQueryFn, CredentialInfo} from '../types.js';
import type {ConsoleSdk} from './console-tools.js';
import type {EngineDeps} from './engine.js';
import {createChatEngine} from './engine.js';
import type {ClaudeChatHandle} from './handle.js';
import {RemoteChatSession} from './remote-session.js';
import {ensureShellTmp} from './shell-tmp.js';
import {createShellWatch, type ShellWatch} from './shell-watch.js';
import {createPinWatch, type PinWatch} from './pin-watch.js';

export type ChatRoute =
	| {kind: 'local'; release: () => void}
	| {kind: 'attach'; socketPath: string; release: () => void}
	| {kind: 'spawn'; sessionDir: string; release: () => void}
	| {kind: 'wait'; message: string};

export type ChatRouteRequest = {
	attach: boolean;
	keep: boolean;
};

export type ChatRunDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	moduleDir?: string;
	log?: Logger;
	loadChatQuery: () => Promise<ChatQueryFn>;
	loadConsoleSdk?: () => Promise<ConsoleSdk>;
	registerAbort?: (c: AbortController) => () => void;
	store: {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};
	showNoticeOnce: (cred: CredentialInfo, ctx: Pick<CommandContext, 'print'>) => Promise<void>;
	probeLogin?: LoginProbe;
	isMissingModule: (err: unknown) => boolean;
	acquire: () => () => void;
	onRulesChanged?: () => void;
	shellTmp?: () => string;
	turnLock?: EngineDeps['turnLock'];
	route?: (req: ChatRouteRequest) => ChatRoute;
	peek?: () => Promise<{free: boolean; title?: string}>;
	spawnRunner?: typeof spawnRunner;
	remote?: {rpcTimeoutMs?: number; connectTimeoutMs?: number};
	vault?: ClaudeVault;
	redactExtra?: (text: string) => string;
};

export type ChatOpen = {
	fresh: boolean;
	model?: string;
	tuning?: ChatTuning;
	resume?: string;
	fork?: boolean;
	resumeAt?: string;
	apiKeyOnly?: boolean;
	historyUntil?: string;
	draft?: string;
	attach?: boolean;
	// A busy session is refused with its message instead of waiting for it.
	noWait?: boolean;
	mode?: ChatMode;
	keep?: boolean;
};

export type ClaudeSource = {
	session: ClaudeChatHandle;
	cred: Credential;
	scrub: (s: string) => string;
	reveal: (s: string) => string;
	paths: ClaudePaths;
	state: ClaudeState;
	resume: string | undefined;
	shellRoot: string | undefined;
	applyLive: (patch: LivePatch) => void;
	setTier: (tier: Tier | 'auto') => void;
	initialModel: string | undefined;
	remote: RemoteChatSession | undefined;
	watch: ShellWatch;
	pin: PinWatch;
	close: () => void;
	flush: () => Promise<void>;
};

type Base = Omit<ClaudeSource, 'watch' | 'pin'>;

class SpawnFailure extends Error {
	override name = 'SpawnFailure';
}

const resolveRoute = async (open: ChatOpen, io: OpenEnv, deps: ChatRunDeps): Promise<Exclude<ChatRoute, {kind: 'wait'}> | undefined> => {
	for (;;) {
		const route = deps.route!({attach: open.attach === true, keep: open.keep === true});
		if (route.kind !== 'wait') return route;
		if (!deps.peek || open.noWait) throw new Error(route.message);
		if (!(await io.wait(deps.peek))) return undefined;
	}
};

const openLocal = async (open: ChatOpen, io: OpenEnv, deps: ChatRunDeps): Promise<Base> => {
	const {fresh, model, tuning, resume: chosen, fork, resumeAt} = open;
	const engine = await createChatEngine(
		{
			fresh,
			...(model !== undefined && {model}),
			...(tuning && {tuning}),
			...(chosen && {resume: chosen}),
			...(fork && {fork}),
			...(resumeAt && {resumeAt}),
			...(open.mode && {mode: open.mode}),
			...(open.apiKeyOnly && {apiKeyOnly: true}),
		},
		{
			...deps,
			onCredential: cred => deps.showNoticeOnce(cred, {print: io.print}),
		},
		{
			...(io.commandBridge && {commandBridge: io.commandBridge}),
			stateUpdate: patch => deps.store.update(patch),
			warn: text => io.print(text),
		},
	);
	const {state} = engine;
	return {
		session: engine.session,
		cred: engine.cred,
		scrub: engine.scrub,
		reveal: engine.reveal,
		paths: engine.paths,
		state,
		resume: engine.resume,
		shellRoot: engine.shellRoot,
		applyLive: engine.applyLive,
		setTier: engine.setTier,
		initialModel: model !== undefined ? model : !fresh ? state.lastModel : undefined,
		remote: undefined,
		close: engine.close,
		flush: engine.flush,
	};
};

const openRemote = async (open: ChatOpen, route: Extract<ChatRoute, {kind: 'attach' | 'spawn'}>, io: OpenEnv, deps: ChatRunDeps): Promise<Base> => {
	const log = deps.log ?? noopLog;
	const credOpts: CredentialOpts = {env: deps.env, dataDir: deps.dataDir, log, ...(deps.vault && {vault: deps.vault})};
	let cred: Credential;
	try {
		cred = await requireCredential(
			{...credOpts, ...(deps.probeLogin && {probeLogin: deps.probeLogin})},
			open.apiKeyOnly ? {apiKeyOnly: true} : {},
			sessionSubscription(deps.dataDir, open.resume),
		);
	} catch (err) {
		log.warn('no credential');
		throw err;
	}
	registerLogRedaction(log, cred);
	const redact = makeRedactor(cred, liveSecrets(credOpts), deps.redactExtra);
	const scrub = makeScrub(redact);
	await deps.showNoticeOnce(cred, {print: io.print});
	const keep = open.keep === true;
	const state = await deps.store.read();
	const paths = resolvePaths(deps.dataDir, deps.moduleDir);
	let shellRoot: string | undefined;
	try {
		shellRoot = (deps.shellTmp ?? ensureShellTmp)();
	} catch (err) {
		log.warn('shell tmp unavailable', {error: errClass(err)});
	}

	let socketPath: string;
	let spawned = false;
	if (route.kind === 'spawn') {
		const spawn = deps.spawnRunner;
		if (!spawn) throw new SpawnFailure('Could not start the background chat');
		try {
			socketPath = (await spawn({moduleDir: paths.moduleDir, sessionDir: route.sessionDir, env: deps.env, log})).socketPath;
		} catch (err) {
			throw new SpawnFailure(err instanceof Error ? err.message : 'Could not start the background chat');
		}
		spawned = true;
		log.info('chat remote', {action: 'spawned'});
	} else {
		socketPath = route.socketPath;
	}

	const resumeId = open.resume ?? (open.fresh ? undefined : state.lastSessionId);
	const remote = await RemoteChatSession.connect({
		socketPath,
		log,
		cwd: paths.projectDir,
		stateUpdate: patch => deps.store.update(patch),
		onLost: reason => io.notice(scrub(reason)),
		credentials: vaultOf(credOpts),
		...(io.commandBridge && {commandBridge: io.commandBridge}),
		...(spawned && {
			open: {
				open: {
					fresh: open.fresh,
					...(open.model !== undefined && {model: open.model}),
					...(open.resume && {resume: open.resume}),
					...(open.fork && {fork: true}),
					...(open.resumeAt && {resumeAt: open.resumeAt}),
					...(open.apiKeyOnly && {apiKeyOnly: true}),
					...(open.historyUntil && {historyUntil: open.historyUntil}),
					...(open.draft && {draft: open.draft}),
				},
				tuning: open.tuning ?? {},
				...(open.mode && {mode: open.mode}),
				keep,
			},
		}),
		...deps.remote,
	}).catch((err: unknown) => {
		const raw = err instanceof Error ? err.message : String(err);
		throw new Error(
			raw === 'attached elsewhere'
				? 'The background chat is attached to another yena. Close it there or run "chat stop".'
				: scrub(raw),
		);
	});
	if (!spawned) log.info('chat remote', {action: 'attached'});
	remote.refreshCommands();
	return {
		session: remote,
		cred,
		scrub,
		reveal: makeReveal(redact),
		paths,
		state,
		resume: spawned ? resumeId : remote.sessionId,
		shellRoot,
		applyLive: patch => remote.applyLive(patch),
		setTier: tier => remote.setTier(tier),
		initialModel: spawned ? open.model : remote.model,
		remote,
		close: () => remote.close(),
		flush: () => Promise.resolve(),
	};
};

// The route (or the acquired lock) is freed at the end of flush, after the engine or the remote is done.
const complete = (base: Base, release: () => void, deps: ChatRunDeps): ClaudeSource => {
	const log = deps.log ?? noopLog;
	const watch = createShellWatch({root: base.shellRoot, sessionId: () => base.session.sessionId, scrub: base.scrub, log});
	const unfeed = base.session.subscribe(e => watch.feed(e));
	const credOpts: CredentialOpts = {env: deps.env, dataDir: deps.dataDir, log, ...(deps.vault && {vault: deps.vault})};
	const pin = createPinWatch(() => pinnedAccount(accountsCtx(credOpts))?.name);
	const unpin = base.session.subscribe(e => {
		if (e.type === 'account' || e.type === 'turn-end') pin.refresh();
	});
	return {
		...base,
		watch,
		pin,
		close: () => {
			unfeed();
			unpin();
			watch.close();
			base.close();
		},
		flush: async () => {
			try {
				await base.flush();
			} finally {
				release();
			}
		},
	};
};

export const openSource = async (open: ChatOpen, io: OpenEnv, deps: ChatRunDeps): Promise<ClaudeSource | undefined> => {
	const log = deps.log ?? noopLog;
	if (!deps.route) {
		const release = deps.acquire();
		try {
			return complete(await openLocal(open, io, deps), release, deps);
		} catch (err) {
			release();
			throw err;
		}
	}
	const route = await resolveRoute(open, io, deps);
	if (!route) return undefined;
	// Fail closed: a key-only open never joins a runner that may run on a login.
	if (open.apiKeyOnly && route.kind === 'attach') {
		route.release();
		throw new Error('A background chat is running; an unattended run does not join it. Close it with "chat stop" first.');
	}
	let held: Exclude<ChatRoute, {kind: 'wait'}> = route;
	try {
		let base: Base;
		if (route.kind === 'local') base = await openLocal(open, io, deps);
		else {
			try {
				base = await openRemote(open, route, io, deps);
			} catch (err) {
				if (!(err instanceof SpawnFailure)) throw err;
				log.warn('chat remote', {action: 'fallback'});
				io.print('Warning: could not start the chat in the background; it runs in this yena and ends when you leave.');
				route.release();
				const again = deps.route({attach: false, keep: false});
				if (again.kind !== 'local') throw new Error(again.kind === 'wait' ? again.message : 'Could not start the chat');
				held = again;
				base = await openLocal(open, io, deps);
			}
		}
		return complete(base, held.release, deps);
	} catch (err) {
		held.release();
		throw err;
	}
};
