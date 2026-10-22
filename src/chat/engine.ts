import type {CommandBridge, Logger} from '../../../../src/api.js';
import {withPatch, type ChatTuning, type LivePatch} from '../chat-prefs.js';
import {buildChatOptions, buildEnv, ensureMdLinks, resolvePaths, type ClaudePaths} from '../config.js';
import type {LoginProbe} from '../claude-login.js';
import {makeRedactor, registerLogRedaction, requireCredential} from '../credentials.js';
import {clip, errClass, noopLog} from '../log.js';
import {buildScope} from '../policy.js';
import type {ChatQueryFn, ClaudeState, Credential} from '../types.js';
import {ChatSession} from './chat-session.js';
import {createConsoleServer, type ConsoleSdk} from './console-tools.js';
import {createChatCanUseTool} from './permission-bridge.js';
import {sdkPermissionMode} from './permission.js';
import {policyHooks} from './policy-hook.js';
import {buildPreview} from './preview.js';
import {makeReveal} from './reveal.js';
import {bashHighlights} from './risk.js';
import {makeScrub} from './scrub.js';
import {ensureShellTmp} from './shell-tmp.js';
import {readSessionTitle, titleFromPrompt, transcriptFile} from './title.js';

const TITLE_RETRY_MS = [3_000, 10_000];

export type EngineOpen = {
	fresh: boolean;
	model?: string;
	tuning?: ChatTuning;
	resume?: string;
	fork?: boolean;
	resumeAt?: string;
};

export type EngineDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	moduleDir?: string;
	log?: Logger;
	loadChatQuery: () => Promise<ChatQueryFn>;
	loadConsoleSdk?: () => Promise<ConsoleSdk>;
	store: {read: () => Promise<ClaudeState>};
	probeLogin?: LoginProbe;
	isMissingModule: (err: unknown) => boolean;
	onRulesChanged?: () => void;
	// Private directory for Claude Code's shell output (CLAUDE_CODE_TMPDIR); throws when unusable.
	shellTmp?: () => string;
	// Runs once the credential is resolved, before any dependency loads (e.g. the one-time notice).
	onCredential?: (cred: Credential) => Promise<void>;
	// Loaded together with the SDK so one failure mapping covers them (e.g. the chat UI).
	preload?: () => Promise<void>;
};

export type EngineIo = {
	// The real bridge or a proxy to one; without it the console tools are not offered.
	commandBridge?: CommandBridge;
	// Persists state: the store itself, or a relay to whoever owns state.json.
	stateUpdate: (patch: Partial<ClaudeState>) => Promise<unknown>;
	warn: (text: string) => void;
};

export type ChatEngine = {
	session: ChatSession;
	cred: Credential;
	redact: (s: string) => string;
	scrub: (s: string) => string;
	reveal: ReturnType<typeof makeReveal>;
	paths: ClaudePaths;
	// State as read when the engine started.
	state: ClaudeState;
	resume: string | undefined;
	shellRoot: string | undefined;
	applyLive: (patch: LivePatch) => void;
	/** Stops title timers and closes the session; state writes already queued are awaited by `flush`. */
	close: () => void;
	flush: () => Promise<void>;
};

export const createChatEngine = async (open: EngineOpen, deps: EngineDeps, io: EngineIo): Promise<ChatEngine> => {
	const {fresh, model, tuning, resume: chosen, fork, resumeAt} = open;
	const {dataDir, env, store} = deps;
	const log = deps.log ?? noopLog;
	let cred: Credential;
	try {
		cred = await requireCredential({env, dataDir, probeLogin: deps.probeLogin});
	} catch (err) {
		log.warn('no credential');
		throw err;
	}
	registerLogRedaction(log, cred);
	const redact = makeRedactor(cred);
	const scrub = makeScrub(redact);
	const reveal = makeReveal(redact);
	await deps.onCredential?.(cred);

	let query: ChatQueryFn;
	let consoleSdk: ConsoleSdk | undefined;
	try {
		query = await deps.loadChatQuery();
		if (io.commandBridge && deps.loadConsoleSdk) {
			consoleSdk = await deps.loadConsoleSdk().catch(err => {
				log.warn('console tools unavailable', {err});
				return undefined;
			});
		}
		await deps.preload?.();
	} catch (err) {
		const missingModule = deps.isMissingModule(err);
		log.error('chat dependencies failed to load', {
			missingModule,
			err: clip(scrub(err instanceof Error ? err.message : String(err))),
		});
		if (missingModule) {
			const raw = err instanceof Error ? err.message : '';
			if (/ink|react/i.test(raw) && !/claude-agent-sdk/i.test(raw)) {
				throw new Error('The chat interface dependencies (ink, react) are not installed in the yena host. Run "./yena install".');
			}
			throw new Error('The Claude Agent SDK is not installed. Run modules/claude/bin/install.');
		}
		throw new Error(`Claude request failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
	}

	const state = await store.read();
	const paths = resolvePaths(dataDir, deps.moduleDir);
	ensureMdLinks(paths);
	const scope = buildScope(paths);
	const resume = chosen ?? (fresh ? undefined : state.lastSessionId);
	log.info('chat starting', {
		fresh,
		kind: cred.kind,
		source: cred.source,
		resuming: resume !== undefined,
		model: model ?? 'default',
	});
	let shellRoot: string | undefined;
	try {
		shellRoot = (deps.shellTmp ?? ensureShellTmp)();
	} catch (err) {
		log.warn('shell tmp unavailable', {error: errClass(err)});
	}
	let saving: Promise<void> = Promise.resolve();
	// Branching and rewinding apply to the query that opens the chat, not to later respawns.
	let spawned = false;
	const firstSpawn = (): boolean => {
		const first = !spawned;
		spawned = true;
		return first;
	};

	// Settings changed while the chat is open: applied to the running query and kept for a respawn.
	let live = {...(model !== undefined && {model}), tuning: {...tuning}};
	const applyLive = (patch: LivePatch): void => {
		live = withPatch(live, patch);
		session.applyLive(patch);
	};

	const session = new ChatSession({
		query,
		redact,
		log,
		initialResume: resume,
		...(state.allowedCommands && {savedApprovals: state.allowedCommands}),
		onRemember: key => {
			saving = saving
				.then(async () => {
					const now = (await store.read()).allowedCommands ?? [];
					if (!now.includes(key)) await io.stateUpdate({allowedCommands: [...now, key]});
					deps.onRulesChanged?.();
				})
				.catch(() => io.warn('Warning: could not save the permission rule'));
		},
		...(state.chatPermissionMode && {initialMode: state.chatPermissionMode}),
		buildOptions: (abortController, id, prompter) => ({
			...buildChatOptions({
				paths,
				cred,
				abortController,
				resume: id,
				...(live.model !== undefined && {model: live.model}),
				tuning: live.tuning,
				env: buildEnv(env, paths, cred, shellRoot),
				...(consoleSdk && io.commandBridge && {
					consoleServer: createConsoleServer({
						bridge: io.commandBridge,
						sdk: consoleSdk,
						prompter,
						redact,
						cwd: paths.projectDir,
						log,
						holdTurn: () => session.holdTurnTimer(),
					}),
				}),
				canUseTool: createChatCanUseTool({
					scope,
					projectDir: paths.projectDir,
					mdDir: paths.mdDir,
					prompter,
					preview: (tool, input, sc) => buildPreview(tool, input, sc),
					highlights: bashHighlights,
				}),
			}),
			includePartialMessages: true,
			...(firstSpawn() && {...(fork && {forkSession: true}), ...(resumeAt && {resumeSessionAt: resumeAt})}),
			permissionMode: sdkPermissionMode(prompter.mode),
			hooks: policyHooks(scope, paths.configDir),
		}),
	});

	// The chat's name: Claude Code writes a generated title into the transcript some time after a
	// turn, so it is read after each turn (and again a little later); the first message stands in.
	const titleTimers = new Set<NodeJS.Timeout>();
	const refreshTitle = async (): Promise<void> => {
		const id = session.sessionId;
		if (!id) return;
		const title = await readSessionTitle(transcriptFile(paths.configDir, paths.projectDir, id));
		if (title) session.setTitle(title);
	};
	const refreshTitleSoon = (): void => {
		void refreshTitle();
		for (const ms of TITLE_RETRY_MS) {
			const timer = setTimeout(() => {
				titleTimers.delete(timer);
				void refreshTitle();
			}, ms);
			timer.unref();
			titleTimers.add(timer);
		}
	};
	if (resume) void refreshTitle();
	session.subscribe(e => {
		if (e.type === 'sent' && session.title === undefined && !e.text.startsWith('/')) {
			const stand = titleFromPrompt(e.text);
			if (stand) session.setTitle(stand);
		}
		if (e.type === 'turn-end' && (e.outcome === 'ok' || e.outcome === 'limit' || e.outcome === 'context')) refreshTitleSoon();
	});

	session.subscribe(e => {
		if (e.type !== 'turn-end' || session.needsNewSession) return;
		const lastSessionId = session.sessionId;
		if (!lastSessionId) return;
		const lastModel = session.model;
		saving = saving
			.then(() => io.stateUpdate({lastSessionId, ...(lastModel && {lastModel})}))
			.then(
				() => undefined,
				() => io.warn('Warning: could not save the session state'),
			);
	});

	return {
		session,
		cred,
		redact,
		scrub,
		reveal,
		paths,
		state,
		resume,
		shellRoot,
		applyLive,
		close: () => {
			for (const timer of titleTimers) clearTimeout(timer);
			titleTimers.clear();
			session.close();
		},
		flush: () => saving,
	};
};
