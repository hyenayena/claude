import type {BuildInfo, CommandContext, Logger, PrintOptions, UiElement, ViewHost} from '../../../../src/api.js';
import {tuningFromState, type ChatTuning, type LivePatch} from '../chat-prefs.js';
import type {LoginProbe} from '../claude-login.js';
import {clockTime} from '../clock-time.js';
import type {ClaudeVault} from '../vault.js';
import {noopLog} from '../log.js';
import type {spawnRunner} from '../runner/spawn.js';
import type {ClaudeState, ChatQueryFn, CredentialInfo} from '../types.js';
import type {ChatUiHelpers, ChatViewProps, ListPickerProps, WaitingViewProps} from '../deps/chat-ui.js';
import {readHistory, readTranscriptDetail} from './history.js';
import {editInEditor} from '../terminal.js';
import type {ConsoleSdk} from './console-tools.js';
import type {EngineDeps} from './engine.js';
import type {ClaudeChatHandle} from './handle.js';
import type {ChatMode, OpenEnv, ShellFeed, Tier} from '../deps/chat.js';
import {transcriptFile} from './title.js';
import {createShellPanel} from './shell-panel.js';
import {openSource, type ClaudeSource} from './open.js';
import {readGitBranch} from './git-head.js';

export const CHAT_USAGE = 'Usage: claude chat [--new]';
export const NEEDS_MOUNT_MESSAGE = '"claude chat" needs an interface that can show views';

export type ChatUi = ChatUiHelpers & {
	createChatElement: (props: ChatViewProps) => UiElement;
	createPickerElement?: (props: ListPickerProps) => UiElement;
	createShellElement?: (feed: ShellFeed, host?: ViewHost) => UiElement;
	createWaitingElement?: (props: WaitingViewProps) => UiElement;
};

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
	build?: BuildInfo;
	env: NodeJS.ProcessEnv;
	moduleDir?: string;
	log?: Logger;
	loadChatQuery: () => Promise<ChatQueryFn>;
	loadConsoleSdk?: () => Promise<ConsoleSdk>;
	loadUi: () => Promise<ChatUi>;
	registerAbort?: (c: AbortController) => () => void;
	store: {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};
	showNoticeOnce: (cred: CredentialInfo, ctx: Pick<CommandContext, 'print'>) => Promise<void>;
	probeLogin?: LoginProbe;
	isMissingModule: (err: unknown) => boolean;
	acquire: () => () => void;
	onMount?: (close: () => void) => void;
	onSession?: (session: ClaudeChatHandle | undefined) => void;
	onLive?: (apply: ((patch: LivePatch) => void) | undefined) => void;
	onTier?: (set: ((tier: Tier | 'auto') => void) | undefined) => void;
	onPin?: (refresh: (() => void) | undefined) => void;
	onInbox?: (deliver: ((text: string) => void) | undefined) => void;
	onRulesChanged?: () => void;
	shellTmp?: () => string;
	inputMode?: () => 'normal' | 'vim';
	turnLock?: EngineDeps['turnLock'];
	route?: (req: ChatRouteRequest) => ChatRoute;
	peek?: () => Promise<{free: boolean; title?: string}>;
	waitPollMs?: number;
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
	send?: string;
	attach?: boolean;
	mode?: ChatMode;
	keep?: boolean;
};

// What a chat opens with from the saved settings, until the chat module passes them in.
export const openPrefs = (state: ClaudeState): Pick<ChatOpen, 'tuning' | 'mode' | 'keep'> => ({
	tuning: tuningFromState(state),
	...(state.chatPermissionMode && {mode: state.chatPermissionMode}),
	keep: state.chatKeepRunning === 'on',
});

export const runChat = async (args: string[], ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	let fresh = false;
	for (const a of args) {
		if (a === '--new') fresh = true;
		else throw new Error(CHAT_USAGE);
	}
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);

	const state = await deps.store.read();
	await openChat({fresh, attach: !fresh, ...(state.chatModel && {model: state.chatModel}), ...openPrefs(state)}, ctx, deps);
};

export const openChat = async (open: ChatOpen, ctx: CommandContext, deps: ChatRunDeps): Promise<void> => {
	if (!ctx.mount) throw new Error(NEEDS_MOUNT_MESSAGE);
	const mount = ctx.mount;
	let ui: ChatUi | undefined;
	const io: OpenEnv = {
		print: text => ctx.print(text),
		notice: text => {
			if (ui) ctx.print(ui.formatNotice(text, s => s));
			else void deps.loadUi().then(u => ctx.print(u.formatNotice(text, s => s)), () => ctx.print(text));
		},
		wait: async check => {
			const create = (await deps.loadUi()).createWaitingElement!;
			let freed = false;
			await mount(control => {
				deps.onMount?.(control.close);
				return create({
					check,
					pollMs: deps.waitPollMs ?? 1000,
					onFree: () => {
						freed = true;
						control.close();
					},
					onCancel: control.close,
					...(control.host && {host: control.host}),
				});
			});
			return freed;
		},
		...(ctx.commandBridge && {commandBridge: ctx.commandBridge}),
	};
	const source = await openSource(open, io, deps);
	if (!source) return;
	ui = source.chatUi;
	await runLocked(source, ctx, mount, deps);
};

const runLocked = async (
	source: ClaudeSource,
	ctx: CommandContext,
	mount: NonNullable<CommandContext['mount']>,
	deps: ChatRunDeps,
): Promise<void> => {
	const log = deps.log ?? noopLog;
	const {chatUi, session, cred, scrub, reveal, paths, resume, shellRoot, applyLive, initialModel, draft, historyUntil, send, pin} = source;
	const {formatBanner, formatFileCard, assistantPrint, assistantRows, formatNotice, formatUserLine, listProjectFiles} = chatUi;
	const startedAt = Date.now();

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

	let chatHost: ViewHost | undefined;
	let shellPanel: ReturnType<typeof createShellPanel> | undefined;
	let unregister: (() => void) | undefined;
	try {
		shellPanel =
			ctx.mount && chatUi.createShellElement
				? createShellPanel({
						watch: source.watch,
						mount: ctx.mount,
						isFocused: () => chatHost?.isFocused() ?? false,
						build: (w, control) => chatUi.createShellElement!(w, control.host),
						hasTmp: shellRoot !== undefined,
						log,
					})
				: undefined;

		const lifetime = new AbortController();
		unregister = deps.registerAbort?.(lifetime);
		lifetime.signal.addEventListener('abort', () => session.close());

		deps.onSession?.(session);
		deps.onLive?.(applyLive);
		deps.onTier?.(source.setTier);
		deps.onPin?.(pin.refresh);
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
				readBranch: () => readGitBranch(paths.projectDir),
				projectDir: paths.projectDir,
				pin,
				...(initialModel !== undefined && {initialModel}),
				...(cred.account !== undefined && {initialAccount: cred.account}),
				...(resume && !source.fork && {initialSessionId: resume}),
				...(draft && {initialDraft: draft}),
				...(send && {initialSend: send}),
				...(deps.onInbox && {onInbox: deps.onInbox}),
				files,
				loadTranscript: async () => {
					const id = session.sessionId;
					if (!id) return [];
					const detail = await readTranscriptDetail(transcriptFile(paths.configDir, paths.projectDir, id));
					return detail.map(item => {
						if (typeof item === 'string') return item;
						if (item.kind === 'text') return {render: (width: number) => assistantRows(item.text, scrub, width, {full: true})};
						return {render: (width: number) => formatFileCard(item, scrub, width, {full: true}).split('\n')};
					});
				},
				...(deps.inputMode && {inputMode: deps.inputMode}),
				...(ctx.suspend && {
					openEditor: (text: string) => ctx.suspend!(() => editInEditor(text, process.env)),
				}),
			});
		});
		if (resume && printHistory) {
			const print = printHistory;
			const earlier = await readHistory(transcriptFile(paths.configDir, paths.projectDir, resume), 40, historyUntil).catch(() => []);
			for (const m of earlier) {
				print(' ');
				if (m.role === 'user') {
					print(formatUserLine(m.text, scrub));
					continue;
				}
				const columns = chatHost?.columns() ?? 0;
				const block = assistantPrint(m.text, scrub, {width: columns > 1 ? columns - 1 : undefined, copyLabel: true});
				print(block.text, block.options);
			}
			if (earlier.length > 0) print(formatNotice('Resumed — earlier messages above.', scrub));
		}
		if (!resume && !source.remote?.reattached && printHistory) {
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
		deps.onTier?.(undefined);
		deps.onPin?.(undefined);
		shellPanel?.dispose();
		try {
			source.close();
		} finally {
			unregister?.();
			await source.flush();
		}
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
