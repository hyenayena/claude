import type {CommandContext, Logger, UiElement} from '../../../../src/api.js';
import {buildChatOptions, buildEnv, resolvePaths} from '../config.js';
import {makeRedactor, registerLogRedaction, requireCredential} from '../credentials.js';
import {clip, noopLog} from '../log.js';
import type {ClaudeState, ChatQueryFn, Credential, CredentialInfo} from '../types.js';
import type {ChatViewProps} from '../ui/mount.js';
import {buildScope} from '../policy.js';
import {ChatSession} from './chat-session.js';
import {createChatCanUseTool} from './permission-bridge.js';
import {buildPreview} from './preview.js';
import {makeReveal} from './reveal.js';
import {bashHighlights} from './risk.js';
import {makeScrub} from './scrub.js';

export const CHAT_USAGE = 'Usage: claude chat [--new]';
export const NEEDS_MOUNT_MESSAGE = '"claude chat" needs an interface that can show views';

export type ChatUi = {createChatElement: (props: ChatViewProps) => UiElement};

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
};

export type ChatOpen = {fresh: boolean; model?: string};

export const runChat = async (args: string[], ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	let fresh = false;
	for (const a of args) {
		if (a === '--new') fresh = true;
		else throw new Error(CHAT_USAGE);
	}
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);

	const state = await deps.store.read();
	await openChat({fresh, ...(state.chatModel && {model: state.chatModel})}, ctx, deps);
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
	{fresh, model}: ChatOpen,
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
	const resume = fresh ? undefined : state.lastSessionId;
	log.info('chat starting', {
		fresh,
		kind: cred.kind,
		source: cred.source,
		resuming: resume !== undefined,
		model: model ?? 'default',
	});
	const startedAt = Date.now();
	const session = new ChatSession({
		query,
		redact,
		log,
		initialResume: resume,
		buildOptions: (abortController, id, prompter) => ({
			...buildChatOptions({
				paths,
				cred,
				abortController,
				resume: id,
				...(model !== undefined && {model}),
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
		}),
	});

	const lifetime = new AbortController();
	const unregister = deps.registerAbort?.(lifetime);
	lifetime.signal.addEventListener('abort', () => session.close());

	let saving: Promise<void> = Promise.resolve();
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

	try {
		await mount(control => {
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
				...(resume && {initialSessionId: resume}),
			});
		});
	} finally {
		const sessionId = session.sessionId;
		const model = session.model;
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
