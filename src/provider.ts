import {appendFile} from 'node:fs/promises';
import type {ClaudeDeps} from './commands.js';
import {tuningFromState} from './chat-prefs.js';
import {diskCommands} from './disk-commands.js';
import {
	accountOfCredential,
	allSecrets,
	API_KEY_ONLY,
	isSubscription,
	loadBundle,
	makeRedactor,
	prepareCredential,
	registerLogRedaction,
	requireCredential,
	resolveCredential,
} from './credentials.js';
import {buildEnv, buildOptions, ensureMdLinks, resolvePaths, restrictDataDirs, runtimeInfo, withProjects} from './config.js';
import {bindSession, sessionSubscription} from './session-accounts.js';
import {runTurn, TurnFailure} from './session.js';
import {clip, errClass} from './log.js';
import {isModelId} from './store.js';
import {isMissingModule, type SessionHub} from './session-hub.js';
import {queryStatus, type SessionState} from './sessions/control.js';
import {readHolder} from './sessions/lock.js';
import {stopHolder} from './sessions/stop.js';
import {listPrompts, listSessions, readHistory, readTranscriptDetail} from './chat/history.js';
import {readSessionTitle, transcriptFile} from './chat/title.js';
import {openSource, type ClaudeSource} from './chat/open.js';
import type {ChatOpen} from './chat/command.js';
import {isInteractive, makeScrub, type AskEnv, type ChatProvider, type ChatSession, type Origin, type OpenedChat, type OpenEnv, type OpenRequest, type RunningInfo} from './deps/chat.js';
import type {Credential, CredentialInfo, QueryFn} from './types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const STOP_USAGE = 'Usage: claude stop [session]';

const LIMIT_KINDS = new Set(['usage-limit', 'rate-limit', 'billing', 'context']);

const limitKind = (err: unknown): string | undefined =>
	err instanceof TurnFailure && err.kind !== undefined && LIMIT_KINDS.has(err.kind) ? err.kind : undefined;

const kindLabel = (info: CredentialInfo): string => {
	if (info.source === 'claude-login') return isSubscription(info) ? 'subscription login' : 'API key (login)';
	return isSubscription(info) ? 'subscription token' : 'API key';
};

// Fails closed: whatever is not known to be interactive (a missing or unexpected value included) is key-only.
const keyOnlyFor = (origin: Origin): boolean => !isInteractive(origin);

export const createClaudeProvider = (hub: SessionHub, deps: ClaudeDeps): ChatProvider => {
	const {dataDir, env} = deps;
	const {store, credOpts, log} = hub;
	let active: Credential | undefined;
	const redactor = (cred?: Credential) => makeRedactor(cred, allSecrets(credOpts), deps.redactExtra);
	const paths = () => resolvePaths(dataDir, deps.moduleDir);
	const transcriptOf = (sessionId: string): string => {
		const p = paths();
		return transcriptFile(p.configDir, p.projectDir, sessionId);
	};

	const runAsk = async (text: string, fresh: boolean, keyOnly: boolean, env_: AskEnv): Promise<void> => {
		const print = env_.print;
		const resume = fresh ? undefined : (await store.read()).lastSessionId;
		let cred: Credential;
		try {
			await loadBundle(credOpts);
			cred = prepareCredential(credOpts, keyOnly ? {apiKeyOnly: true} : {}, sessionSubscription(dataDir, resume));
		} catch (err) {
			log.warn('no credential');
			throw err;
		}
		active = cred;
		registerLogRedaction(log, cred);
		log.info('credential resolved', {kind: cred.kind, source: cred.source});
		const redact = redactor(cred);
		const scrub = makeScrub(redact);
		await hub.showNoticeOnce(cred, {print});
		print('Asking yena…');
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

		const controller = new AbortController();
		const unregister = deps.registerAbort?.(controller);
		const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let timedOut = false;
		hub.askAbort = () => controller.abort();
		const stopOnSignal = (): void => controller.abort();
		if (env_.signal?.aborted) controller.abort();
		else env_.signal?.addEventListener('abort', stopOnSignal, {once: true});
		const timer = setTimeout(() => {
			timedOut = true;
			log.warn('ask timed out', {timeoutMs});
			controller.abort();
		}, timeoutMs);
		timer.unref();
		const startedAt = Date.now();

		const bindAsk = (sessionId: string): void => {
			const account = accountOfCredential(credOpts, cred);
			if (account === undefined) return;
			try {
				if (!bindSession(dataDir, sessionId, account)) log.warn('session subscription mismatch');
			} catch (err) {
				log.warn('session account not saved', {errClass: errClass(err)});
			}
		};

		try {
			const p = await withProjects(resolvePaths(dataDir, deps.moduleDir));
			ensureMdLinks(p);
			restrictDataDirs(p);
			let result;
			const options = buildOptions({paths: p, cred, abortController: controller, resume, env: buildEnv(env, p, cred)});
			try {
				result = await runTurn({query, prompt: text, options, signal: controller.signal, redact, log});
			} catch (err) {
				const failure = timedOut ? new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds`) : err;
				if (err instanceof TurnFailure && err.sessionId && err.kind !== 'resume') {
					bindAsk(err.sessionId);
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
			bindAsk(result.sessionId);
			await store.update({lastSessionId: result.sessionId, ...(result.model && {lastModel: result.model})});
			print(scrub(result.text));
			const model = result.model ?? 'unknown';
			print(scrub(`[session ${result.sessionId.slice(0, 8)} · model ${model} · ${kindLabel(cred)}]`));
			log.info('ask finished', {
				outcome: 'ok',
				ms: Date.now() - startedAt,
				model,
				numTurns: result.numTurns,
				session8: result.sessionId.slice(0, 8),
			});
		} finally {
			hub.askAbort = undefined;
			clearTimeout(timer);
			env_.signal?.removeEventListener('abort', stopOnSignal);
			unregister?.();
		}
	};

	const provider: ChatProvider = {
		id: 'claude',
		label: 'Claude Code',
		modes: ['default', 'acceptEdits', 'plan', 'auto'],
		redact: text => redactor(active)(text),

		admit: async origin => {
			if (hub.askRunning) throw new Error('An ask is already running');
			if (keyOnlyFor(origin)) await requireCredential(credOpts, {apiKeyOnly: true});
		},

		open: async (req: OpenRequest, io: OpenEnv): Promise<OpenedChat | undefined> => {
			const keyOnly = keyOnlyFor(req.origin);
			const state = await store.read();
			const open: ChatOpen = {
				fresh: req.fresh,
				...(req.attach !== undefined && {attach: req.attach}),
				...(req.model !== undefined && {model: req.model}),
				tuning: tuningFromState(state),
				...(req.resume && {resume: req.resume}),
				...(req.fork && {fork: true}),
				...(req.resumeAt && {resumeAt: req.resumeAt}),
				...(req.mode && {mode: req.mode}),
				...(req.keep !== undefined && {keep: req.keep}),
				...(keyOnly && {apiKeyOnly: true}),
			};
			const source = await openSource(open, io, hub.runDeps());
			if (!source) return undefined;
			return track(source, keyOnly);
		},

		lastSession: async () => (await store.read()).lastSessionId,
		sessions: limit => {
			const p = paths();
			return listSessions(p.configDir, p.projectDir, limit);
		},
		history: (id, opts) => readHistory(transcriptOf(id), opts?.limit, opts?.until),
		prompts: id => listPrompts(transcriptOf(id)),
		detail: id => readTranscriptDetail(transcriptOf(id)),
		title: id => readSessionTitle(transcriptOf(id)),
		rename: async (id, name) => {
			await appendFile(transcriptOf(id), `${JSON.stringify({type: 'custom-title', customTitle: name, sessionId: id})}\n`);
			if (hub.openSession?.sessionId === id) hub.openSession.setTitle(name);
		},
		projectDir: () => paths().projectDir,

		running: async () => {
			const dir = hub.sessionsDir();
			if (!dir) throw new Error('Session control is not available (no private run directory)');
			const {holder, unknown} = readHolder(dir);
			if (!holder) return {sessions: [], starting: unknown === true};
			const scrub = makeScrub(s => s);
			const status = await queryStatus(dir).catch(() => undefined);
			const id8 = status?.sessionId8 ?? holder.sessionId?.slice(0, 8);
			const state: SessionState | undefined = status?.state;
			const info: RunningInfo = {
				kind: holder.kind,
				where: holder.where === 'runner' ? 'background' : 'local',
				...(state && {state}),
				...(status?.title && {title: scrub(status.title).slice(0, 80)}),
				...(id8 && {session8: id8}),
				startedAt: holder.startedAt,
				pid: holder.pid,
				pending: status?.pending ?? 0,
				queued: status?.queued ?? 0,
				...(status && holder.where === 'runner' && {attached: status.attached === true}),
			};
			return {sessions: [info], starting: false};
		},

		stop: async id => {
			const dir = hub.sessionsDir();
			if (!dir) throw new Error('Session control is not available (no private run directory)');
			const {holder} = readHolder(dir);
			if (!holder) return undefined;
			const wanted = id?.toLowerCase();
			if (wanted !== undefined && !(holder.sessionId ?? '').startsWith(wanted)) {
				throw new Error(`No running session matches "${makeScrub(s => s)(id!).slice(0, 40)}". ${STOP_USAGE}`);
			}
			const result = await stopHolder(dir, holder, {log});
			if (result.ok) return {kind: holder.kind, via: result.via};
			if (holder.where === 'local') throw new Error(`The ${holder.kind} runs in another yena (pid ${holder.pid}) and did not stop; close that yena.`);
			throw new Error(`The background ${holder.kind} (pid ${holder.pid}) did not stop.`);
		},

		commandHints: () =>
			hub.openSession && hub.openSession.state !== 'closed' && hub.openSession.commands.length > 0
				? [...hub.openSession.commands]
				: diskCommands(paths().configDir),

		describe: async (_session?: ChatSession) => {
			const state = await store.read();
			const rt = runtimeInfo(paths());
			const cred = await resolveCredential(credOpts);
			const scrub = makeScrub(redactor(cred));
			return [
				{label: 'Session', value: scrub(state.lastSessionId ?? '(none)')},
				{label: 'Model', value: scrub(state.lastModel ?? '(unknown)')},
				{label: 'Chat model', value: scrub(state.chatModel ?? 'default')},
				{label: 'Claude Code runtime', value: scrub(rt.cli ?? '(not installed)')},
				{label: 'Agent SDK', value: scrub(rt.sdk)},
				{label: 'Binary in use', value: scrub(rt.binary)},
			];
		},

		ask: async (req, io) => {
			const release = await hub.acquireAsk();
			try {
				await runAsk(req.text, req.fresh, keyOnlyFor(req.origin), io);
			} finally {
				release();
			}
		},

		validModel: isModelId,

		legacyPrefs: async () => {
			const s = await store.read();
			return {
				...(s.chatPermissionMode && {permissionMode: s.chatPermissionMode}),
				...(s.chatInputMode === 'vim' && {inputMode: 'vim' as const}),
				...(s.chatKeepRunning === 'on' && {keepRunning: true}),
			};
		},

		clearLegacyPrefs: async () => {
			await store.update({chatPermissionMode: undefined, chatInputMode: undefined, chatKeepRunning: undefined});
		},
	};

	const track = (source: ClaudeSource, keyOnly: boolean): OpenedChat => {
		const {session} = source;
		active = source.cred;
		const lifetime = new AbortController();
		const unregister = deps.registerAbort?.(lifetime);
		lifetime.signal.addEventListener('abort', () => session.close());
		hub.openSession = session;
		hub.applyOpenChat = source.applyLive;
		hub.setOpenTier = source.setTier;
		hub.refreshOpenPin = source.pin.refresh;
		hub.openKeyOnly = keyOnly;
		return {
			session,
			scrub: source.scrub,
			reveal: source.reveal,
			projectDir: source.paths.projectDir,
			...(source.initialModel !== undefined && {model: source.initialModel}),
			...(source.cred.account !== undefined && {account: source.cred.account}),
			...(source.resume && {resume: source.resume}),
			...(source.remote?.reattached && {reattached: {startedAt: source.remote.startedAt}}),
			detachedWhileRunning: () => source.remote?.detachedWhileRunning === true,
			shell: {feed: source.watch, hasTmp: source.shellRoot !== undefined},
			pin: {current: source.pin.current, subscribe: source.pin.subscribe},
			admitSend: origin => {
				if (keyOnlyFor(origin) && !keyOnly) throw new Error(API_KEY_ONLY);
			},
			close: () => source.close(),
			flush: async () => {
				unregister?.();
				try {
					await source.flush();
				} finally {
					if (hub.openSession === session) {
						hub.openSession = undefined;
						hub.applyOpenChat = undefined;
						hub.setOpenTier = undefined;
						hub.refreshOpenPin = undefined;
					}
				}
			},
		};
	};

	return provider;
};
