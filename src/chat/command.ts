import type {CommandContext, Logger, UiElement} from '../../../../src/api.js';
import {tuningFromState, withPatch, type ChatTuning, type LivePatch} from '../chat-prefs.js';
import {buildChatOptions, buildEnv, resolvePaths} from '../config.js';
import {makeRedactor, registerLogRedaction, requireCredential} from '../credentials.js';
import {clip, noopLog} from '../log.js';
import type {ClaudeState, ChatQueryFn, Credential, CredentialInfo} from '../types.js';
import type {ChatViewProps, ListPickerProps} from '../ui/mount.js';
import {formatAssistantBlock, formatNotice, formatUserLine} from '../ui/present.js';
import {readHistory, readTranscriptDetail} from './history.js';
import {listProjectFiles} from './files.js';
import {editInEditor} from '../terminal.js';
import {buildScope} from '../policy.js';
import {ChatSession} from './chat-session.js';
import {createChatCanUseTool} from './permission-bridge.js';
import {sdkPermissionMode} from './permission.js';
import {policyHooks} from './policy-hook.js';
import {readSessionTitle, titleFromPrompt, transcriptFile} from './title.js';
import {buildPreview} from './preview.js';
import {makeReveal} from './reveal.js';
import {bashHighlights} from './risk.js';
import {makeScrub} from './scrub.js';

export const CHAT_USAGE = 'Usage: claude chat [--new]';
const TITLE_RETRY_MS = [3_000, 10_000];
export const NEEDS_MOUNT_MESSAGE = '"claude chat" needs an interface that can show views';

export type ChatUi = {
	createChatElement: (props: ChatViewProps) => UiElement;
	createPickerElement?: (props: ListPickerProps) => UiElement;
};

export type ChatRunDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	moduleDir?: string;
	log?: Logger;
	loadChatQuery: () => Promise<ChatQueryFn>;
	loadUi: () => Promise<ChatUi>;
	registerAbort?: (c: AbortController) => () => void;
	store: {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};
	showNoticeOnce: (cred: CredentialInfo, ctx: CommandContext) => Promise<void>;
	kindLabel: (cred: CredentialInfo) => string;
	isMissingModule: (err: unknown) => boolean;
	acquire: () => () => void;
	// Receives the view's close function once the chat is shown.
	onMount?: (close: () => void) => void;
	// Receives the running session, e.g. to apply a permission mode chosen in the settings.
	onSession?: (session: ChatSession | undefined) => void;
	// Receives the function that applies a settings change to this chat (undefined once it closes).
	onLive?: (apply: ((patch: LivePatch) => void) | undefined) => void;
	onRulesChanged?: () => void;
	// 'vim' or 'normal' editing for the chat input, read on every key.
	inputMode?: () => 'normal' | 'vim';
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
};

export const runChat = async (args: string[], ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	let fresh = false;
	for (const a of args) {
		if (a === '--new') fresh = true;
		else throw new Error(CHAT_USAGE);
	}
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);

	const state = await deps.store.read();
	await openChat({fresh, ...(state.chatModel && {model: state.chatModel}), tuning: tuningFromState(state)}, ctx, deps);
};

export const openChat = async (open: ChatOpen, ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);
	const mount = ctx.mount;
	const release = deps.acquire();
	try {
		await runLocked(open, ctx, mount, deps);
	} finally {
		release();
	}
};

const runLocked = async (
	{fresh, model, tuning, resume: chosen, fork, resumeAt, historyUntil, draft}: ChatOpen,
	ctx: CommandContext,
	mount: NonNullable<CommandContext['mount']>,
	deps: ChatRunDeps,
): Promise<void> => {
	const {dataDir, env, store} = deps;
	const log = deps.log ?? noopLog;
	let cred: Credential;
	try {
		cred = await requireCredential({env, dataDir});
	} catch (err) {
		log.warn('no credential');
		throw err;
	}
	registerLogRedaction(log, cred);
	const redact = makeRedactor(cred);
	const scrub = makeScrub(redact);
	const reveal = makeReveal(redact);
	await deps.showNoticeOnce(cred, ctx);

	let query: ChatQueryFn;
	let ui: ChatUi;
	try {
		query = await deps.loadChatQuery();
		ui = await deps.loadUi();
	} catch (err) {
		const missingModule = deps.isMissingModule(err);
		log.error('chat dependencies failed to load', {
			missingModule,
			err: clip(scrub(err instanceof Error ? err.message : String(err))),
		});
		if (missingModule) {
			const raw = err instanceof Error ? err.message : '';
			if (/ink|react/i.test(raw) && !/claude-agent-sdk/i.test(raw)) {
				throw new Error('The chat interface dependencies (ink, react) are not installed in the yena host. Run "make install".');
			}
			throw new Error('The Claude Agent SDK is not installed. Run modules/claude/bin/install.');
		}
		throw new Error(`Claude request failed: ${scrub(err instanceof Error ? err.message : String(err))}`);
	}

	const state = await store.read();
	const paths = resolvePaths(dataDir, deps.moduleDir);
	const scope = buildScope(paths);
	const resume = chosen ?? (fresh ? undefined : state.lastSessionId);
	log.info('chat starting', {
		fresh,
		kind: cred.kind,
		source: cred.source,
		resuming: resume !== undefined,
		model: model ?? 'default',
	});
	const startedAt = Date.now();
	let saving: Promise<void> = Promise.resolve();
	// Branching and rewinding apply to the query that opens the chat, not to later respawns.
	let spawned = false;
	const firstSpawn = (): boolean => {
		const first = !spawned;
		spawned = true;
		return first;
	};

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
					if (!now.includes(key)) await store.update({allowedCommands: [...now, key]});
					deps.onRulesChanged?.();
				})
				.catch(() => ctx.print('Warning: could not save the permission rule'));
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
				env: buildEnv(env, paths, cred),
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

	const lifetime = new AbortController();
	const unregister = deps.registerAbort?.(lifetime);
	lifetime.signal.addEventListener('abort', () => session.close());

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
		if (e.type === 'turn-end' && e.outcome === 'ok') refreshTitleSoon();
	});

	session.subscribe(e => {
		if (e.type !== 'turn-end' || e.outcome !== 'ok') return;
		const lastSessionId = session.sessionId;
		if (!lastSessionId) return;
		const lastModel = session.model;
		saving = saving
			.then(() => store.update({lastSessionId, ...(lastModel && {lastModel})}))
			.then(
				() => undefined,
				() => ctx.print('Warning: could not save the session state'),
			);
	});

	deps.onSession?.(session);
	deps.onLive?.(applyLive);
	try {
		let printHistory: ((text: string) => void) | undefined;
		const mounted = mount(control => {
			printHistory = control.print ?? ctx.print;
			deps.onMount?.(control.close);
			return ui.createChatElement({
				controller: session,
				print: control.print ?? ctx.print,
				close: control.close,
				...(control.host && {host: control.host}),
				scrub,
				reveal,
				projectDir: paths.projectDir,
				credentialLabel: deps.kindLabel(cred),
				...(model !== undefined
					? {initialModel: model}
					: state.lastModel && !fresh && {initialModel: state.lastModel}),
				...(resume && !fork && {initialSessionId: resume}),
				...(draft && {initialDraft: draft}),
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
			for (const m of earlier) print(m.role === 'user' ? formatUserLine(m.text, scrub) : formatAssistantBlock(m.text, scrub));
			if (earlier.length > 0) print(formatNotice('Resumed — earlier messages above.', scrub));
		}
		await mounted;
	} finally {
		const sessionId = session.sessionId;
		const model = session.model;
		deps.onSession?.(undefined);
		deps.onLive?.(undefined);
		for (const timer of titleTimers) clearTimeout(timer);
		titleTimers.clear();
		session.close();
		unregister?.();
		await saving;
		log.info('chat closed', {ms: Date.now() - startedAt, session8: sessionId?.slice(0, 8), model});
		ctx.print(
			scrub(
				sessionId
					? `[chat closed · session ${sessionId.slice(0, 8)} · model ${model ?? 'unknown'}]`
					: '[chat closed]',
			),
		);
	}
};
