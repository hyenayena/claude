import type {CommandBridge, Logger} from '../../../../src/api.js';
import {withPatch, type ChatTuning, type LivePatch} from '../chat-prefs.js';
import {buildChatOptions, buildEnv, ensureMdLinks, resolvePaths, restrictDataDirs, withProjects, type ClaudePaths} from '../config.js';
import type {LoginProbe} from '../claude-login.js';
import {accountsCtx, liveSecrets, loginSyncOf, makeRedactor, prepareCredential, registerLogRedaction, requireCredential, vaultOf, type CredentialOpts} from '../credentials.js';
import {chooseAccount, LoginUnsavedError, markLimited, prepareAccount} from '../accounts.js';
import {degradedReason, type ClaudeVault} from '../vault.js';
import {clip, errClass, noopLog} from '../log.js';
import {buildScope} from '../policy.js';
import type {ChatQueryFn, ClaudeState, Credential} from '../types.js';
import {ChatSession} from './chat-session.js';
import {createConsoleFlags, createConsoleServer, type ConsoleSdk} from './console-tools.js';
import {createChatCanUseTool} from './permission-bridge.js';
import {sdkPermissionMode} from './permission.js';
import {policyHooks} from './policy-hook.js';
import {buildPreview} from './preview.js';
import {makeReveal} from './reveal.js';
import {bashHighlights} from './risk.js';
import {makeScrub} from './scrub.js';
import {ensureShellTmp, sessionDirOf, shellTmpRoot} from './shell-tmp.js';
import {createProcessStatus, statusLine} from './process-status.js';
import {buildSandbox, createSandboxSync, sandboxProblem} from './sandbox.js';
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
	// Why Bash cannot be sandboxed (bubblewrap missing or blocked); undefined when it can.
	sandboxProblem?: (pathVar: string | undefined) => string | undefined;
	// Runs once the credential is resolved, before any dependency loads (e.g. the one-time notice).
	onCredential?: (cred: Credential) => Promise<void>;
	// Loaded together with the SDK so one failure mapping covers them (e.g. the chat UI).
	preload?: () => Promise<void>;
	// The one-session lock for each turn (local yena or runner); see sessions/turn-lock.ts.
	turnLock?: (session: () => ChatSession | undefined) => {acquire(): void; release(): void};
	// An idle chat ends its Claude Code process after this long (IDLE_CLOSE_MS by default).
	idleCloseMs?: number;
	// Stored Claude accounts: the credential channel in yena, the pushed bundle in a runner.
	vault?: ClaudeVault;
	// The host's redactor (every module's registered secrets), applied after the chat's own.
	redactExtra?: (text: string) => string;
	// A runner cannot save a refreshed login itself: it tells the attached yena, which syncs and pushes.
	onLoginChanged?: () => void;
	loginPollMs?: number;
};

/** How often a running turn checks whether Claude Code refreshed its login. */
export const LOGIN_POLL_MS = 30_000;

/** How long an idle chat keeps its Claude Code process (it may still write the title into the transcript). */
export const IDLE_CLOSE_MS = 15_000;

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

// How long an account stays aside when the limit report gives no reset time, and after a billing error.
const LIMIT_HOLD_S = 5 * 3600;
const BILLING_HOLD_S = 24 * 3600;

export const createChatEngine = async (open: EngineOpen, deps: EngineDeps, io: EngineIo): Promise<ChatEngine> => {
	const {fresh, model, tuning, resume: chosen, fork, resumeAt} = open;
	const {dataDir, env, store} = deps;
	const log = deps.log ?? noopLog;
	const credOpts: CredentialOpts = {env, dataDir, log, ...(deps.vault && {vault: deps.vault})};
	let cred: Credential;
	try {
		cred = await requireCredential({...credOpts, ...(deps.probeLogin && {probeLogin: deps.probeLogin})});
	} catch (err) {
		log.warn('no credential');
		throw err;
	}
	registerLogRedaction(log, cred);
	const loginSync = loginSyncOf(credOpts);
	// In yena the sync saves the login itself; a runner asks the attached yena to.
	let lastSync: Promise<unknown> = Promise.resolve();
	const saveLoginSoon = (): void => {
		if (deps.onLoginChanged) {
			if (loginSync.dirty()) deps.onLoginChanged();
		} else lastSync = loginSync.sync();
	};
	const redact = makeRedactor(cred, liveSecrets(credOpts), deps.redactExtra);
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
	const paths = await withProjects(resolvePaths(dataDir, deps.moduleDir));
	ensureMdLinks(paths);
	restrictDataDirs(paths);
	const scope = buildScope({...paths, ...(env.SSH_AUTH_SOCK && {agentSocket: env.SSH_AUTH_SOCK})});
	const resume = chosen ?? (fresh ? undefined : state.lastSessionId);
	log.info('chat starting', {
		fresh,
		kind: cred.kind,
		source: cred.source,
		resuming: resume !== undefined,
		model: model ?? 'default',
	});
	const status = vaultOf(credOpts).current().status;
	if (status === 'no-grant' || status === 'error') io.warn(`Note: ${degradedReason(status)}`);
	const problem = (deps.sandboxProblem ?? sandboxProblem)(env.PATH);
	if (problem !== undefined) {
		log.warn('bash sandbox unavailable');
		io.warn(`Warning: Bash in the chat runs without its sandbox, so it can write to projects that are not isolated: ${problem}.`);
	}
	let created: ChatSession | undefined;
	const sandboxExtras = {socketDirs: [sessionDirOf(shellTmpRoot(process.getuid?.() ?? 0))]};
	const sandbox = createSandboxSync(
		async () => buildSandbox(paths, await paths.projects?.read(), undefined, undefined, sandboxExtras),
		async s => {
			await created?.applySandbox(s);
		},
	);
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

	const turnLock = deps.turnLock?.(() => created);
	const session = new ChatSession({
		query,
		redact,
		log,
		...(turnLock && {turnLock}),
		idleCloseMs: deps.idleCloseMs ?? IDLE_CLOSE_MS,
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
		// The account is chosen again at every start of Claude Code (a limit may have passed or been hit),
		// under the session lock, so a login can be swapped into the config dir safely.
		buildOptions: (abortController, id, prompter) => {
			try {
				cred = prepareCredential(credOpts);
			} catch (err) {
				if (err instanceof LoginUnsavedError) saveLoginSoon();
				throw err;
			}
			registerLogRedaction(log, cred);
			const consoleFlags = createConsoleFlags();
			// Claude Code narrows a running sandbox at once but never widens it past the one it started with,
			// so a later `project isolate` would not reach Bash. It starts with no project denies, and the
			// policy hook narrows it to the real access before every Bash command (beforeBash).
			const access = paths.projects?.readSync();
			const box = problem === undefined ? buildSandbox(paths, access && {...access, managed: []}, undefined, undefined, sandboxExtras) : undefined;
			if (box) sandbox.spawned(box);
			return {
			...buildChatOptions({
				paths,
				cred,
				abortController,
				resume: id,
				...(live.model !== undefined && {model: live.model}),
				tuning: live.tuning,
				env: buildEnv(env, paths, cred, shellRoot),
				...(box && {sandbox: box}),
				...(consoleSdk && io.commandBridge && {
					consoleServer: createConsoleServer({
						bridge: io.commandBridge,
						sdk: consoleSdk,
						prompter,
						flags: consoleFlags,
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
					consoleFlags,
					preview: (tool, input, sc) => buildPreview(tool, input, sc),
					highlights: bashHighlights,
				}),
			}),
			includePartialMessages: true,
			...(firstSpawn() && {...(fork && {forkSession: true}), ...(resumeAt && {resumeSessionAt: resumeAt})}),
			permissionMode: sdkPermissionMode(prompter.mode),
			hooks: policyHooks(scope, paths.configDir, {approved: key => prompter.hasApproved(key), ...(box && {beforeBash: () => sandbox.refresh(), procHidden: true})}),
			};
		},
		onUsageLimit: ({reason, rateLimit}) => {
			const current = cred.account;
			if (current === undefined) return undefined;
			const ctx = accountsCtx(credOpts);
			const now = Date.now() / 1000;
			const until =
				reason === 'billing' ? now + BILLING_HOLD_S : rateLimit?.resetsAt !== undefined && rateLimit.resetsAt > now ? rateLimit.resetsAt : now + LIMIT_HOLD_S;
			markLimited(ctx, current, until, reason);
			const next = chooseAccount(ctx);
			log.info('account limited', {reason, next: next !== undefined && next.limitedUntil === undefined && next.name !== current});
			if (!next || next.limitedUntil !== undefined || next.name === current) return undefined;
			try {
				prepareAccount(ctx, next.name);
			} catch (err) {
				if (!(err instanceof LoginUnsavedError)) throw err;
				// Swapping in another login now would overwrite the refreshed one before it is saved.
				log.info('account switch skipped', {reason: 'login-unsaved'});
				saveLoginSoon();
				return undefined;
			}
			return {from: current, to: next.name};
		},
	});
	created = session;

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

	const procStatus = createProcessStatus(env.YENA_STATUS_DIR, log);
	const writeStatus = (): void => {
		if (session.state === 'closed') return procStatus.clear();
		procStatus.set(statusLine({state: session.state, sessionId: session.sessionId, tasks: session.tasks}));
	};
	writeStatus();
	session.subscribe(e => {
		if (e.type === 'state' || (e.type === 'ui' && (e.event.kind === 'task' || e.event.kind === 'session'))) writeStatus();
	});

	// Claude Code refreshes its login during a run: saved after each turn and checked every 30 s while one runs.
	let loginPoll: NodeJS.Timeout | undefined;
	const stopLoginPoll = (): void => {
		if (loginPoll) clearInterval(loginPoll);
		loginPoll = undefined;
	};
	session.subscribe(e => {
		if (e.type === 'turn-end') saveLoginSoon();
		if (e.type !== 'state') return;
		if (e.state === 'running' && !loginPoll) {
			loginPoll = setInterval(() => {
				if (loginSync.changed()) saveLoginSoon();
			}, deps.loginPollMs ?? LOGIN_POLL_MS);
			loginPoll.unref();
		} else if (e.state !== 'running') stopLoginPoll();
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
		// The account in use now: it changes when a limit switches it.
		get cred() {
			return cred;
		},
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
			procStatus.clear();
			stopLoginPoll();
			saveLoginSoon();
		},
		flush: () => Promise.all([saving, lastSync]).then(() => undefined),
	};
};
