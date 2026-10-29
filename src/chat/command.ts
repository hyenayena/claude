import type {BuildInfo, CommandContext, Logger, PrintOptions, UiElement, ViewHost} from '../../../../src/api.js';
import {tuningFromState, type ChatTuning, type LivePatch} from '../chat-prefs.js';
import type {LoginProbe} from '../claude-login.js';
import {clockTime} from '../clock-time.js';
import {resolvePaths, type ClaudePaths} from '../config.js';
import {liveSecrets, loginSyncOf, makeRedactor, registerLogRedaction, requireCredential, vaultOf, type CredentialOpts} from '../credentials.js';
import type {ClaudeVault} from '../vault.js';
import {clip, errClass, noopLog} from '../log.js';
import type {spawnRunner} from '../runner/spawn.js';
import type {LockInfo} from '../sessions/lock.js';
import type {ClaudeState, ChatQueryFn, Credential, CredentialInfo} from '../types.js';
import type {ChatViewProps, ListPickerProps, WaitingViewProps} from '../ui/mount.js';
import {formatBanner} from '../ui/banner.js';
import {assistantPrint, formatNotice, formatUserLine} from '../ui/present.js';
import {readHistory, readTranscriptDetail} from './history.js';
import {listProjectFiles} from './files.js';
import {editInEditor} from '../terminal.js';
import type {ConsoleSdk} from './console-tools.js';
import {createChatEngine, type EngineDeps} from './engine.js';
import type {ChatHandle} from './handle.js';
import {RemoteChatSession} from './remote-session.js';
import {makeReveal} from './reveal.js';
import {makeScrub} from './scrub.js';
import {ensureShellTmp} from './shell-tmp.js';
import {transcriptFile} from './title.js';
import {createShellPanel} from './shell-panel.js';
import {createShellWatch, type ShellWatch} from './shell-watch.js';

export const CHAT_USAGE = 'Usage: claude chat [--new]';
export const NEEDS_MOUNT_MESSAGE = '"claude chat" needs an interface that can show views';

export type ChatUi = {
	createChatElement: (props: ChatViewProps) => UiElement;
	createPickerElement?: (props: ListPickerProps) => UiElement;
	// Live Bash output in the console panel; without it the panel is never shown.
	createShellElement?: (watch: ShellWatch, host?: ViewHost) => UiElement;
	// Shown while another session holds the one-session lock.
	createWaitingElement?: (props: WaitingViewProps) => UiElement;
};

// Where a chat runs: this process, a background runner that is attached or spawned, or not yet (the lock is taken).
export type ChatRoute =
	| {kind: 'local'; release: () => void}
	| {kind: 'attach'; socketPath: string; release: () => void}
	| {kind: 'spawn'; sessionDir: string; release: () => void}
	| {kind: 'wait'; message: string};

export type ChatRouteRequest = {
	// A running background chat may be attached to (otherwise the open waits for it).
	attach: boolean;
	// Run the chat in a background runner that outlives yena.
	keep: boolean;
};

export type ChatRunDeps = {
	dataDir: string;
	build?: BuildInfo;
	env: NodeJS.ProcessEnv;
	moduleDir?: string;
	log?: Logger;
	loadChatQuery: () => Promise<ChatQueryFn>;
	// SDK helpers for the in-process console tools; without it (or without a command bridge) the tools are not offered.
	loadConsoleSdk?: () => Promise<ConsoleSdk>;
	loadUi: () => Promise<ChatUi>;
	registerAbort?: (c: AbortController) => () => void;
	store: {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};
	showNoticeOnce: (cred: CredentialInfo, ctx: CommandContext) => Promise<void>;
	// Detects a Claude Code login; only consulted when no environment credential is set.
	probeLogin?: LoginProbe;
	isMissingModule: (err: unknown) => boolean;
	acquire: () => () => void;
	// Receives the view's close function once the chat is shown.
	onMount?: (close: () => void) => void;
	// Receives the running session, e.g. to apply a permission mode chosen in the settings.
	onSession?: (session: ChatHandle | undefined) => void;
	// Receives the function that applies a settings change to this chat (undefined once it closes).
	onLive?: (apply: ((patch: LivePatch) => void) | undefined) => void;
	// Receives the open chat view's way to take a message from outside ("claude send"); undefined once it closes.
	onInbox?: (deliver: ((text: string) => void) | undefined) => void;
	onRulesChanged?: () => void;
	// Private directory for Claude Code's shell output (CLAUDE_CODE_TMPDIR); throws when unusable.
	shellTmp?: () => string;
	// 'vim' or 'normal' editing for the chat input, read on every key.
	inputMode?: () => 'normal' | 'vim';
	// The one-session lock for each turn of a chat in this process (with `route`).
	turnLock?: EngineDeps['turnLock'];
	// With `route` the single-session lock is handled there instead of `acquire`.
	route?: (req: ChatRouteRequest) => ChatRoute;
	// One look at the lock while waiting; the title is of whatever holds it.
	peek?: () => Promise<{free: boolean; title?: string}>;
	waitPollMs?: number;
	spawnRunner?: typeof spawnRunner;
	// Overrides for the connection to a background chat (tests).
	remote?: {rpcTimeoutMs?: number; connectTimeoutMs?: number};
	// Stored Claude accounts (the credential channel); without it only the environment variables count.
	vault?: ClaudeVault;
	// The host's redactor, applied after the chat's own.
	redactExtra?: (text: string) => string;
};

// `resume` names a session to continue; otherwise `fresh` picks a new one or the last one.
export type ChatOpen = {
	fresh: boolean;
	model?: string;
	tuning?: ChatTuning;
	resume?: string;
	// Continue `resume` as a new session (a branch) instead of in place.
	fork?: boolean;
	// With `resume`: keep the conversation only up to this entry (rewind).
	resumeAt?: string;
	// Shown history stops before this prompt (rewind).
	historyUntil?: string;
	// Text put into the input when the chat opens.
	draft?: string;
	// A message sent as soon as the chat opens (as if typed and sent).
	send?: string;
	// A background chat that is already running may be attached to instead of waiting for it.
	attach?: boolean;
};

export const runChat = async (args: string[], ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	let fresh = false;
	for (const a of args) {
		if (a === '--new') fresh = true;
		else throw new Error(CHAT_USAGE);
	}
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);

	const state = await deps.store.read();
	await openChat({fresh, attach: !fresh, ...(state.chatModel && {model: state.chatModel}), tuning: tuningFromState(state)}, ctx, deps);
};

export const openChat = async (open: ChatOpen, ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);
	const mount = ctx.mount;
	if (!deps.route) {
		const release = deps.acquire();
		try {
			await runLocked(open, ctx, mount, deps, {kind: 'local', release});
		} finally {
			release();
		}
		return;
	}
	const keep = (await deps.store.read()).chatKeepRunning === 'on';
	const route = await resolveRoute(open, keep, mount, deps);
	if (!route) return;
	try {
		await runLocked(open, ctx, mount, deps, route, keep);
	} finally {
		route.release();
	}
};

// Waits (with a view) while another session holds the lock; undefined when the wait was cancelled.
const resolveRoute = async (
	open: ChatOpen,
	keep: boolean,
	mount: NonNullable<CommandContext['mount']>,
	deps: ChatRunDeps,
): Promise<Exclude<ChatRoute, {kind: 'wait'}> | undefined> => {
	for (;;) {
		const route = deps.route!({attach: open.attach === true, keep});
		if (route.kind !== 'wait') return route;
		const ui = deps.peek ? await deps.loadUi() : undefined;
		if (!deps.peek || !ui?.createWaitingElement) throw new Error(route.message);
		const peek = deps.peek;
		const create = ui.createWaitingElement;
		let freed = false;
		await mount(control => {
			deps.onMount?.(control.close);
			return create({
				check: peek,
				pollMs: deps.waitPollMs ?? 1000,
				onFree: () => {
					freed = true;
					control.close();
				},
				onCancel: control.close,
				...(control.host && {host: control.host}),
			});
		});
		if (!freed) return undefined;
	}
};

type ViewSource = {
	chatUi: ChatUi;
	session: ChatHandle;
	cred: Credential;
	scrub: (s: string) => string;
	reveal: (s: string) => string;
	paths: ClaudePaths;
	state: ClaudeState;
	// The session whose earlier messages are shown.
	resume: string | undefined;
	shellRoot: string | undefined;
	applyLive: (patch: LivePatch) => void;
	initialModel: string | undefined;
	draft: string | undefined;
	send?: string;
	fork: boolean;
	historyUntil: string | undefined;
	remote: RemoteChatSession | undefined;
	close: () => void;
	flush: () => Promise<void>;
};

class SpawnFailure extends Error {
	override name = 'SpawnFailure';
}

const openLocal = async (open: ChatOpen, ctx: CommandContext, deps: ChatRunDeps): Promise<ViewSource> => {
	const {fresh, model, tuning, resume: chosen, fork, resumeAt, historyUntil, draft} = open;
	let ui: ChatUi | undefined;
	const engine = await createChatEngine(
		{
			fresh,
			...(model !== undefined && {model}),
			...(tuning && {tuning}),
			...(chosen && {resume: chosen}),
			...(fork && {fork}),
			...(resumeAt && {resumeAt}),
		},
		{
			...deps,
			onCredential: cred => deps.showNoticeOnce(cred, ctx),
			preload: async () => {
				ui = await deps.loadUi();
			},
		},
		{
			...(ctx.commandBridge && {commandBridge: ctx.commandBridge}),
			stateUpdate: patch => deps.store.update(patch),
			warn: text => ctx.print(text),
		},
	);
	const {state} = engine;
	return {
		chatUi: ui!,
		session: engine.session,
		cred: engine.cred,
		scrub: engine.scrub,
		reveal: engine.reveal,
		paths: engine.paths,
		state,
		resume: engine.resume,
		shellRoot: engine.shellRoot,
		applyLive: engine.applyLive,
		initialModel: model !== undefined ? model : !fresh ? state.lastModel : undefined,
		draft,
		...(open.send && {send: open.send}),
		fork: fork === true,
		historyUntil,
		remote: undefined,
		close: engine.close,
		flush: engine.flush,
	};
};

// The interface half of the chat engine for a chat that runs in a background process.
const openRemote = async (
	open: ChatOpen,
	route: Extract<ChatRoute, {kind: 'attach' | 'spawn'}>,
	keep: boolean,
	ctx: CommandContext,
	deps: ChatRunDeps,
): Promise<ViewSource> => {
	const log = deps.log ?? noopLog;
	const credOpts: CredentialOpts = {env: deps.env, dataDir: deps.dataDir, log, ...(deps.vault && {vault: deps.vault})};
	let cred: Credential;
	try {
		cred = await requireCredential({...credOpts, ...(deps.probeLogin && {probeLogin: deps.probeLogin})});
	} catch (err) {
		log.warn('no credential');
		throw err;
	}
	registerLogRedaction(log, cred);
	const redact = makeRedactor(cred, liveSecrets(credOpts), deps.redactExtra);
	const scrub = makeScrub(redact);
	await deps.showNoticeOnce(cred, ctx);
	let chatUi: ChatUi;
	try {
		chatUi = await deps.loadUi();
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		log.error('chat dependencies failed to load', {missingModule: deps.isMissingModule(err), err: clip(scrub(raw))});
		if (deps.isMissingModule(err)) {
			throw new Error('The chat interface dependencies (ink, react) are not installed in the yena host. Run "./yena install".');
		}
		throw new Error(`Claude request failed: ${scrub(raw)}`);
	}
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
		onLost: reason => ctx.print(formatNotice(reason, scrub)),
		// The runner gets the stored accounts from here and asks this yena to save a refreshed login.
		credentials: vaultOf(credOpts),
		onLoginChanged: () => void loginSyncOf(credOpts).sync(),
		...(ctx.commandBridge && {commandBridge: ctx.commandBridge}),
		...(spawned && {
			open: {
				open: {
					fresh: open.fresh,
					...(open.model !== undefined && {model: open.model}),
					...(open.resume && {resume: open.resume}),
					...(open.fork && {fork: true}),
					...(open.resumeAt && {resumeAt: open.resumeAt}),
					...(open.historyUntil && {historyUntil: open.historyUntil}),
					...(open.draft && {draft: open.draft}),
				},
				tuning: open.tuning ?? {},
				...(state.chatPermissionMode && {mode: state.chatPermissionMode}),
				keep,
			},
		}),
		...deps.remote,
	}).catch((err: unknown) => {
		const raw = err instanceof Error ? err.message : String(err);
		throw new Error(
			raw === 'attached elsewhere'
				? 'The background chat is attached to another yena. Close it there or run "claude stop".'
				: scrub(raw),
		);
	});
	if (!spawned) log.info('chat remote', {action: 'attached'});
	remote.refreshCommands();
	return {
		chatUi,
		session: remote,
		cred,
		scrub,
		reveal: makeReveal(redact),
		paths,
		state,
		resume: spawned ? resumeId : remote.sessionId,
		shellRoot,
		applyLive: patch => remote.applyLive(patch),
		initialModel: spawned ? open.model : remote.model,
		draft: spawned ? open.draft : undefined,
		...(open.send && {send: open.send}),
		fork: spawned && open.fork === true,
		historyUntil: spawned ? open.historyUntil : undefined,
		remote,
		close: () => remote.close(),
		flush: () => Promise.resolve(),
	};
};

const runLocked = async (
	open: ChatOpen,
	ctx: CommandContext,
	mount: NonNullable<CommandContext['mount']>,
	deps: ChatRunDeps,
	route: Exclude<ChatRoute, {kind: 'wait'}>,
	keep = false,
): Promise<void> => {
	const log = deps.log ?? noopLog;
	let source: ViewSource;
	if (route.kind === 'local') source = await openLocal(open, ctx, deps);
	else {
		try {
			source = await openRemote(open, route, keep, ctx, deps);
		} catch (err) {
			if (!(err instanceof SpawnFailure)) throw err;
			log.warn('chat remote', {action: 'fallback'});
			ctx.print('Warning: could not start the chat in the background; it runs in this yena and ends when you leave.');
			route.release();
			const again = deps.route!({attach: false, keep: false});
			if (again.kind !== 'local') throw new Error(again.kind === 'wait' ? again.message : 'Could not start the chat');
			try {
				await runLocked(open, ctx, mount, deps, again);
			} finally {
				again.release();
			}
			return;
		}
	}
	const {chatUi, session, cred, scrub, reveal, paths, state, resume, shellRoot, applyLive, initialModel, draft, historyUntil, send} = source;
	const startedAt = Date.now();

	// Project files for @ mentions, read in the background on the first "@" of the chat.
	let projectFiles: readonly string[] = [];
	let filesRequested = false;
	const files = (): readonly string[] => {
		if (!filesRequested) {
			filesRequested = true;
			void listProjectFiles(paths.projectDir).then(
				list => {
					projectFiles = list;
				},
				() => {},
			);
		}
		return projectFiles;
	};

	const shellWatch = createShellWatch({root: shellRoot, sessionId: () => session.sessionId, scrub, log});
	const unfeed = session.subscribe(e => shellWatch.feed(e));
	let chatHost: ViewHost | undefined;
	const shellPanel =
		ctx.mount && chatUi.createShellElement
			? createShellPanel({
					watch: shellWatch,
					mount: ctx.mount,
					isFocused: () => chatHost?.isFocused() ?? false,
					build: (w, control) => chatUi.createShellElement!(w, control.host),
					hasTmp: shellRoot !== undefined,
					log,
				})
			: undefined;

	// A remote chat only detaches here: the background process keeps it.
	const lifetime = new AbortController();
	const unregister = deps.registerAbort?.(lifetime);
	lifetime.signal.addEventListener('abort', () => session.close());

	deps.onSession?.(session);
	deps.onLive?.(applyLive);
	try {
		let printHistory: ((text: string, options?: PrintOptions) => void) | undefined;
		const mounted = mount(control => {
			printHistory = control.print ?? ctx.print;
			chatHost = control.host;
			deps.onMount?.(control.close);
			return chatUi.createChatElement({
				controller: session,
				print: control.print ?? ctx.print,
				close: control.close,
				...(control.host && {host: control.host}),
				scrub,
				reveal,
				projectDir: paths.projectDir,
				...(initialModel !== undefined && {initialModel}),
				...(resume && !source.fork && {initialSessionId: resume}),
				...(draft && {initialDraft: draft}),
				...(send && {initialSend: send}),
				...(deps.onInbox && {onInbox: deps.onInbox}),
				files,
				loadTranscript: async () => {
					const id = session.sessionId;
					return id ? readTranscriptDetail(transcriptFile(paths.configDir, paths.projectDir, id)) : [];
				},
				...(deps.inputMode && {inputMode: deps.inputMode}),
				...(ctx.suspend && {
					openEditor: (text: string) => ctx.suspend!(() => editInEditor(text, process.env)),
				}),
			});
		});
		// A resumed chat shows its earlier messages; the transcript was cleared for the new view.
		if (resume && printHistory) {
			const print = printHistory;
			const earlier = await readHistory(transcriptFile(paths.configDir, paths.projectDir, resume), 40, historyUntil).catch(() => []);
			for (const m of earlier) {
				// One empty line before each message, as in the live chat.
				print(' ');
				if (m.role === 'user') {
					print(formatUserLine(m.text, scrub));
					continue;
				}
				const columns = chatHost?.columns() ?? 0;
				const block = assistantPrint(m.text, scrub, {width: columns > 1 ? columns - 1 : undefined});
				print(block.text, block.options);
			}
			if (earlier.length > 0) print(formatNotice('Resumed — earlier messages above.', scrub));
		}
		if (!resume && !source.remote?.reattached && printHistory) {
			// Laid out again by the transcript whenever its width changes; the text is for places without that.
			const banner = (columns: number): string => formatBanner({build: deps.build, model: initialModel, columns}, scrub);
			printHistory(banner(chatHost?.columns() || 80), {render: banner});
		}
		if (source.remote?.reattached && printHistory) {
			printHistory(formatNotice(`Reattached to a session working since ${clockTime(source.remote.startedAt)}`, scrub));
		}
		await mounted;
	} finally {
		const sessionId = session.sessionId;
		const model = session.model;
		deps.onSession?.(undefined);
		deps.onLive?.(undefined);
		shellPanel?.dispose();
		unfeed();
		shellWatch.close();
		source.close();
		unregister?.();
		await source.flush();
		log.info('chat closed', {ms: Date.now() - startedAt, session8: sessionId?.slice(0, 8), model});
		const left = source.remote?.detachedWhileRunning === true;
		ctx.print(
			scrub(
				sessionId
					? `[chat ${left ? 'left running in the background' : 'closed'} · session ${sessionId.slice(0, 8)} · model ${model ?? 'unknown'}]`
					: '[chat closed]',
			),
		);
	}
};

