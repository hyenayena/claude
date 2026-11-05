import {basename} from 'node:path';
import React, {createElement, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Box, Text, useInput, usePaste, useWindowSize, type Key} from 'ink';
import type {PrintOptions, ViewHost} from '../../../../src/api.js';
import type {ChatController, ChatEvent} from '../chat/events.js';
import {limitIndicator, systemClock, type Clock} from '../chat/limits.js';
import {MODE_CYCLE, QUESTION_LIMITS, REASON_MAX} from '../chat/permission.js';
import type {ChatMode, PermissionDecision, PermissionRequest} from '../chat/permission.js';
import {sanitizeMultilineInput, truncateCells, wrapRows} from '../kit.js';
import {layoutPanel, navigate, revealAgent, type PanelMove} from './agent-panel.js';
import {createAgentStore} from './agent-store.js';
import {agentViewLines} from './agent-view.js';
import {focusAgent, initialAgents, reduceAgents, seedFromTasks} from './agents.js';
import {AgentPanel} from './AgentPanel.js';
import {headerHost} from './view-header.js';
import {editorReduce, emptyEditor, MAX_INPUT, type EditorAction, type EditorState} from './editor.js';
import {cursorFromClick, InputLine, inputRowsNeeded} from './InputLine.js';
import {LiveTools, toolLayout} from './LiveTools.js';
import {PermissionPrompt} from './PermissionPrompt.js';
import {
	formatError,
	formatNotice,
	assistantPrint,
	formatOut,
	formatUserLine,
	liveTail,
	modeHint,
	routeBarText,
	todoLines,
	queuedLines,
	type Scrub,
} from './present.js';
import {
	appendText,
	ARM_MS,
	initQuestionPrompt,
	initToolPrompt,
	isArmed,
	layoutPrompt,
	normalizeKey,
	questionPromptKey,
	rearm,
	toolBodyRows,
	toolPromptKey,
	type QuestionPromptState,
	type ToolPromptState,
} from './prompt-state.js';
import {QuestionPrompt} from './QuestionPrompt.js';
import {parseSlash, slashHints, type SlashHints} from './slash.js';
import {commandHost, type ViewCommandInfo} from './view-commands.js';
import {ChatStatusBar} from './ChatStatusBar.js';
import {turnFilesRows} from './turn-summary.js';
import {useViewHost} from './kit.js';
import {preloadHighlighter} from './highlight.js';
import {mouseHost, validEvent, type ViewMouseEvent} from './view-mouse.js';
import {vimKey, vimStart, type VimEffect, type VimState} from './vim.js';
import {matchFiles, mentionAt} from '../chat/files.js';
import {
	initialTranscript,
	LIVE,
	markInterrupting,
	reduceTranscript,
	setNotice,
	type TranscriptState,
} from './transcript.js';

export interface ChatViewProps {
	controller: ChatController;
	print: (text: string, options?: PrintOptions) => void;
	close: () => void;
	scrub: Scrub;
	initialModel?: string;
	initialSessionId?: string;
	initialAccount?: string;
	initialDraft?: string;
	initialSend?: string;
	onInbox?: (deliver: ((text: string) => void) | undefined) => void;
	files?: () => readonly string[];
	openEditor?: (text: string) => Promise<string | undefined>;
	loadTranscript?: () => Promise<ViewerLine[]>;
	inputMode?: () => 'normal' | 'vim';
	reveal?: (s: string) => string;
	projectDir?: string;
	readBranch?: () => Promise<string | undefined>;
	pin?: {current(): string | undefined; subscribe(cb: () => void): () => void};
	armMs?: number;
	host?: ViewHost;
	clock?: Clock;
}

type PromptEntry =
	| {id: string; request: Extract<PermissionRequest, {kind: 'tool'}>; state: ToolPromptState; armedSig: string}
	| {id: string; request: Extract<PermissionRequest, {kind: 'question'}>; state: QuestionPromptState; armedSig: string};

const promptSig = (p: PromptEntry, tier: string): string =>
	p.request.kind === 'tool'
		? `${p.id}:${(p.state as ToolPromptState).view}:${tier}`
		: `${p.id}:${(p.state as QuestionPromptState).index}:${(p.state as QuestionPromptState).view}:${tier}`;

export const BUSY_HINT = 'Wait for the answer or press Esc to interrupt';
export const ESC_AGAIN_HINT = 'Press Esc again to interrupt';
export const ESC_CONFIRM_AFTER_MS = 10_000;
export const ESC_AGAIN_MS = 2_000;

// A stray Esc (for example a mouse report split by the terminal) must not end a long turn: after the
// first seconds of a turn an interrupt needs a second Esc (TASK-30).
export function escapeInterrupts(now: number, turnSince: number, armedAt: number | undefined): boolean {
	if (now - turnSince < ESC_CONFIRM_AFTER_MS) return true;
	return armedAt !== undefined && now - armedAt <= ESC_AGAIN_MS;
}
export const NEW_CHAT_TITLE = 'New chat';
export const MAX_QUEUED = 20;
const MAX_UNDO = 100;
const MAX_TIMER_MS = 2_000_000_000;

export function armExpiry(atMs: number, clock: Clock, fire: () => void, maxMs = MAX_TIMER_MS): () => void {
	let timer: NodeJS.Timeout | undefined;
	const arm = (): void => {
		const wait = atMs - clock.now();
		if (wait <= 0) return;
		timer = setTimeout(() => {
			fire();
			arm();
		}, Math.min(wait, maxMs));
		timer.unref();
	};
	arm();
	return () => clearTimeout(timer);
}
const MENTION_ROWS = 6;
const MAX_HISTORY = 200;

const sentHistory: string[] = [];
export const rememberSent = (text: string): void => {
	if (sentHistory.at(-1) === text) return;
	sentHistory.push(text);
	if (sentHistory.length > MAX_HISTORY) sentHistory.shift();
};
export const clearSentHistory = (): void => {
	sentHistory.length = 0;
};
const COMMAND_LIST_MS = 1000;
export type ViewerLine = string | {render(width: number): string[]};
type Viewer = {lines: ViewerLine[]; top: number; wrapped?: {width: number; rows: string[]}};

export function viewerRowsOf(v: Viewer, columns: number): string[] {
	const width = Math.max(1, columns - 1);
	if (v.wrapped?.width !== width) v.wrapped = {width, rows: v.lines.flatMap(l => (typeof l === 'string' ? wrapRows(l, width, {mode: 'char'}) : l.render(width)))};
	return v.wrapped.rows;
}

const MODE_NAME: Record<ChatMode, string> = {default: 'default', acceptEdits: 'accept-edits', plan: 'plan', auto: 'auto'};

const MODE_COLOR: Record<ChatMode, string | undefined> = {default: undefined, acceptEdits: 'magenta', plan: 'cyan', auto: 'yellow'};

export function ChatView(props: ChatViewProps) {
	const {controller, print: printRaw, close, scrub} = props;
	const gapRef = useRef(true);
	const print = useCallback(
		(text: string, options?: PrintOptions) => {
			if (gapRef.current) printRaw(' ');
			printRaw(text, options);
			gapRef.current = true;
		},
		[printRaw],
	);
	const printNotice = useCallback(
		(text: string, options?: PrintOptions) => {
			if (gapRef.current) printRaw(' ');
			printRaw(text, options);
			gapRef.current = false;
		},
		[printRaw],
	);
	const sinceRef = useRef(Date.now());
	const branchRef = useRef<string | undefined>(undefined);
	const readBranchRef = useRef(props.readBranch);
	readBranchRef.current = props.readBranch;
	const escArmedRef = useRef<number | undefined>(undefined);
	const lastEventRef = useRef(Date.now());
	const beatRef = useRef(0);
	const reveal = props.reveal ?? scrub;
	const armMs = props.armMs ?? ARM_MS;
	const terminal = useWindowSize();
	const rows = terminal.rows;
	const {focused, columns} = useViewHost(props.host);
	const host = props.host;
	const clock = props.clock ?? systemClock;

	const tRef = useRef<TranscriptState>(
		initialTranscript({
			model: props.initialModel ?? controller.model,
			sessionId: props.initialSessionId ?? controller.sessionId,
			...(props.initialAccount !== undefined && {account: props.initialAccount}),
			mode: controller.mode,
			pending: controller.pendingPermissions.length,
		}),
	);
	const promptRef = useRef<PromptEntry | null>(null);
	const batchRef = useRef(0);
	const pendingModeRef = useRef<{mode: ChatMode; armedAt: number} | undefined>(undefined);
	const strandedRef = useRef(controller.state === 'running' ? '' : (controller.queued ?? []).join('\n\n'));
	const initialText = [props.initialDraft ?? '', strandedRef.current].filter(Boolean).join('\n');
	const edRef = useRef<EditorState>(initialText ? editorReduce(emptyEditor, {type: 'insert', text: initialText}) : emptyEditor);
	const closedRef = useRef(false);
	const queueRef = useRef<string[]>(controller.state === 'running' ? [...(controller.queued ?? [])] : []);
	const setQueue = useCallback(
		(next: string[]) => {
			queueRef.current = next;
			controller.setQueued?.(next);
		},
		[controller],
	);
	const historyRef = useRef<{index: number; draft: EditorState}>({index: -1, draft: emptyEditor});
	const searchRef = useRef<{query: string; index: number; draft: EditorState} | undefined>(undefined);
	const mentionRef = useRef<{selected: number; dismissed: boolean}>({selected: 0, dismissed: false});
	const commandRef = useRef<{selected: number; dismissed: boolean}>({selected: 0, dismissed: false});
	const commandListRef = useRef<{at: number; list: ViewCommandInfo[]} | undefined>(undefined);
	const vimRef = useRef<VimState>(vimStart);
	const viewerRef = useRef<Viewer | undefined>(undefined);
	const shownRef = useRef({columns: 0, rows: 0, inputRows: 0, vimNormal: false, statusBar: false, waiting: false, belowInput: 0, panelHeight: 0});
	const agentsRef = useRef<ReturnType<typeof createAgentStore> | undefined>(undefined);
	if (!agentsRef.current) agentsRef.current = createAgentStore(seedFromTasks(initialAgents(), controller.tasks ?? []));
	const agents = agentsRef.current;
	const agentsState = useSyncExternalStore(agents.subscribe, agents.get);
	const agentTopRef = useRef(-1);
	const panelOf = (cols: number, height: number) => layoutPanel(agents.get(), {columns: cols, rows: height, scrub});
	const focusBox = (focus: Parameters<typeof focusAgent>[1]) => agents.set(revealAgent(focusAgent(agents.get(), focus), {columns, rows, scrub}));
	const panelHeight = layoutPanel(agentsState, {columns, rows, scrub}).height;
	const viewRows = rows - panelHeight;
	const [, setTick] = useState(0);
	const render = useCallback(() => setTick(n => n + 1), []);
	const lastWidthRef = useRef(0);
	if (columns > 0) lastWidthRef.current = columns;

	const setT = useCallback(
		(next: TranscriptState) => {
			tRef.current = next;
			render();
		},
		[render],
	);
	const undoRef = useRef<EditorState[]>([]);
	const edit = useCallback(
		(...actions: EditorAction[]) => {
			historyRef.current = {index: -1, draft: emptyEditor};
			const before = edRef.current;
			let next = before;
			for (const action of actions) next = editorReduce(next, action);
			if (next.text !== before.text) {
				undoRef.current.push(before);
				if (undoRef.current.length > MAX_UNDO) undoRef.current.shift();
			}
			edRef.current = next;
			mentionRef.current = {...mentionRef.current, dismissed: false};
			if (next.text !== before.text) commandRef.current = {selected: 0, dismissed: false};
			render();
		},
		[render],
	);
	const undo = useCallback(() => {
		const prev = undoRef.current.pop();
		if (!prev) return;
		edRef.current = {...prev, ...(edRef.current.killed !== undefined && {killed: edRef.current.killed})};
		render();
	}, [render]);

	const refreshBranch = useCallback(() => {
		const read = readBranchRef.current;
		if (!read) return;
		read().then(
			branch => {
				if (closedRef.current || branch === branchRef.current) return;
				branchRef.current = branch;
				render();
			},
			() => undefined,
		);
	}, [render]);
	useEffect(() => refreshBranch(), [refreshBranch]);

	const feed = useCallback(
		(event: ChatEvent) => {
			if (closedRef.current) return;
			lastEventRef.current = Date.now();
			agents.set(reduceAgents(agents.get(), event));
			if (event.type === 'sent') {
				print(formatUserLine(event.text, scrub));
				return;
			}
			if (event.type === 'steer-failed') {
				if (tRef.current.phase !== 'idle' && queueRef.current.length < MAX_QUEUED) setQueue([...queueRef.current, event.text]);
				else {
					const draft = edRef.current.text;
					edRef.current = editorReduce(emptyEditor, {type: 'insert', text: draft ? `${event.text}\n${draft}` : event.text});
				}
				render();
				return;
			}
			if (event.type === 'permission-resolved') {
				batchRef.current = event.pending === 0 ? 0 : batchRef.current + 1;
			}
			const step = reduceTranscript(tRef.current, event);
			if (tRef.current.phase === 'idle' && step.state.phase !== 'idle') sinceRef.current = Date.now();
			setT(event.type === 'turn-end' ? {...step.state, notice: undefined} : step.state);
			if (event.type === 'turn-end') refreshBranch();
			for (const out of step.out) {
				if (out.kind === 'blank') continue;
				if (out.kind === 'turn-summary') {
					print(formatOut(out, scrub, reveal, lastWidthRef.current || undefined), {render: w => formatOut(out, scrub, reveal, w)});
					continue;
				}
				if (out.kind === 'assistant') {
					beatRef.current++;
					const width = lastWidthRef.current > 1 ? lastWidthRef.current - 1 : undefined;
					const block = assistantPrint(out.text, scrub, {interrupted: out.interrupted, width, copyLabel: true});
					print(block.text, block.options);
					continue;
				}
				if (out.kind === 'tool' || out.kind === 'tool-group' || out.kind === 'audit' || out.kind === 'route-block') {
					if (out.kind === 'tool' || out.kind === 'tool-group') beatRef.current++;
					const width = lastWidthRef.current > 1 ? lastWidthRef.current - 1 : undefined;
					const text = formatOut(out, scrub, reveal, width);
					const options: PrintOptions = {render: w => formatOut(out, scrub, reveal, w)};
					if (out.kind === 'audit') printNotice(text, options);
					else print(text, options);
					continue;
				}
				const text = formatOut(out, scrub, reveal, lastWidthRef.current || undefined);
				if (out.kind === 'mode' || out.kind === 'account' || out.kind === 'route') printNotice(text);
				else print(text);
			}
			if (event.type === 'turn-end' && queueRef.current.length > 0) {
				if (event.outcome === 'interrupted' || event.outcome === 'limit' || event.outcome === 'context') {
					const back = queueRef.current.join('\n\n');
					setQueue([]);
					const draft = edRef.current.text;
					edRef.current = editorReduce(emptyEditor, {type: 'insert', text: draft ? `${back}\n${draft}` : back});
					render();
				} else {
					setTimeout(flushQueue, 0);
				}
			}
		},
		[print, printNotice, scrub, reveal, setT, render, setQueue, agents, refreshBranch],
	);

	const flushQueue = useCallback(() => {
		if (closedRef.current || queueRef.current.length === 0 || controller.state !== 'idle') return;
		const text = queueRef.current.join('\n\n');
		setQueue([]);
		render();
		try {
			controller.send(text);
		} catch (error) {
			const draft = edRef.current.text;
			edRef.current = editorReduce(emptyEditor, {type: 'insert', text: draft ? `${text}\n${draft}` : text});
			print(formatError(error instanceof Error ? error.message : String(error), scrub));
			render();
			return;
		}
		if ((controller.state as string) === 'running') feed({type: 'state', state: 'running'});
	}, [controller, print, render, scrub, setQueue]);

	const cancelPending = useCallback(() => {
		if (controller.detachesOnClose) return;
		for (const req of [...controller.pendingPermissions]) {
			controller.answerPermission(req.id, {kind: 'cancel', cause: 'closed'});
		}
	}, [controller]);

	useLayoutEffect(() => {
		if (strandedRef.current) controller.setQueued?.([]);
	}, [controller]);

	useLayoutEffect(() => {
		const unsubscribe = controller.subscribe(feed);
		return () => {
			unsubscribe();
			closedRef.current = true;
			cancelPending();
			controller.close();
		};
	}, [controller, feed, cancelPending]);

	const leave = useCallback(() => {
		if (closedRef.current) return;
		closedRef.current = true;
		cancelPending();
		controller.close();
		close();
	}, [controller, close, cancelPending]);

	const interrupt = useCallback(() => {
		setT(markInterrupting(tRef.current));
		controller.interrupt().catch((error: unknown) => {
			print(formatError(error instanceof Error ? error.message : String(error), scrub));
		});
	}, [controller, print, scrub, setT]);

	const insertPasted = useCallback(
		(raw: string) => {
			const before = edRef.current;
			edit({type: 'insert', text: sanitizeMultilineInput(raw)});
			const after = edRef.current;
			const requested = sanitizeMultilineInput(raw).length;
			if (after.truncated || after.text.length - before.text.length < requested) {
				setT(setNotice(tRef.current, `Input truncated to ${MAX_INPUT} characters`));
			}
		},
		[edit, setT],
	);

	const requestMode = useCallback(
		(mode: ChatMode) => {
			if (mode === controller.mode) {
				setT(setNotice(tRef.current, `Already in ${MODE_NAME[mode]} mode.`));
				return;
			}
			if (mode === 'default' || mode === 'plan') {
				pendingModeRef.current = undefined;
				controller.setMode(mode);
				setT({...tRef.current, mode: controller.mode, notice: undefined});
				return;
			}
			pendingModeRef.current = {mode, armedAt: Date.now() + armMs};
			setT(setNotice(tRef.current, undefined));
		},
		[armMs, controller, setT],
	);

	const cycleMode = useCallback(() => {
		const at = MODE_CYCLE.indexOf(controller.mode);
		requestMode(MODE_CYCLE[(at + 1) % MODE_CYCLE.length] as ChatMode);
	}, [controller, requestMode]);

	const steerOrQueue = useCallback(
		(text: string): boolean => {
			if (tRef.current.phase === 'running' && controller.steer && queueRef.current.length === 0) {
				try {
					controller.steer(text);
					return true;
				} catch {
				}
			}
			if (queueRef.current.length >= MAX_QUEUED) return false;
			setQueue([...queueRef.current, text]);
			return true;
		},
		[controller, setQueue],
	);

	const submit = useCallback(() => {
		const text = edRef.current.text.trim();
		if (text === '') return;
		if (text === ':q' || text === ':q!') {
			edRef.current = emptyEditor;
			if (host?.quit) host.quit();
			else leave();
			return;
		}
		const slash = parseSlash(text);
		const commands = commandHost(host);
		if (slash?.kind === 'command' && commands?.runLine(slash.line)) {
			historyRef.current = {index: -1, draft: emptyEditor};
			rememberSent(text);
			edRef.current = emptyEditor;
			setT(setNotice(tRef.current, undefined));
			printNotice(formatNotice(`/${slash.line} → console`, scrub));
			return;
		}
		const message = slash?.kind === 'literal' ? slash.text : text;
		const t = tRef.current;
		historyRef.current = {index: -1, draft: emptyEditor};
		rememberSent(text);
		if (t.phase !== 'idle') {
			if (!steerOrQueue(message)) {
				setT(setNotice(t, BUSY_HINT));
				return;
			}
			edRef.current = emptyEditor;
			setT(setNotice(tRef.current, undefined));
			return;
		}
		edRef.current = emptyEditor;
		setT(setNotice(tRef.current, undefined));
		try {
			controller.send(message);
		} catch (error) {
			edRef.current = editorReduce(emptyEditor, {type: 'insert', text});
			print(formatError(error instanceof Error ? error.message : String(error), scrub));
			render();
			return;
		}
		if (controller.state === 'running') feed({type: 'state', state: 'running'});
	}, [controller, feed, host, leave, print, printNotice, render, requestMode, scrub, setT, steerOrQueue]);

	const sentInitial = useRef(false);
	useEffect(() => {
		void preloadHighlighter();
	}, []);

	useEffect(() => {
		const text = props.initialSend;
		if (sentInitial.current || !text) return;
		sentInitial.current = true;
		edRef.current = editorReduce(emptyEditor, {type: 'insert', text});
		submit();
	}, [props.initialSend, submit]);

	const pinWatch = props.pin;
	useEffect(() => pinWatch?.subscribe(render), [pinWatch, render]);

	const onInbox = props.onInbox;
	useEffect(() => {
		if (!onInbox) return;
		onInbox(text => {
			if (closedRef.current) throw new Error('The chat is closed');
			if (tRef.current.phase !== 'idle') {
				if (!steerOrQueue(text)) throw new Error(BUSY_HINT);
				render();
				return;
			}
			controller.send(text);
			if (controller.state === 'running') feed({type: 'state', state: 'running'});
		});
		return () => onInbox(undefined);
	}, [onInbox, controller, feed, render, steerOrQueue]);

	const browseHistory = useCallback(
		(step: -1 | 1) => {
			const h = historyRef.current;
			if (sentHistory.length === 0 || (step === 1 && h.index === -1)) return;
			let index = h.index === -1 ? sentHistory.length - 1 : h.index + step;
			const draft = h.index === -1 ? edRef.current : h.draft;
			if (index < 0) index = 0;
			if (index >= sentHistory.length) {
				historyRef.current = {index: -1, draft: emptyEditor};
				edRef.current = draft;
			} else {
				historyRef.current = {index, draft};
				edRef.current = editorReduce(emptyEditor, {type: 'insert', text: sentHistory[index]!});
			}
			render();
		},
		[render],
	);

	const escape = useCallback(() => {
		const phase = tRef.current.phase;
		if (phase === 'running') {
			const now = Date.now();
			if (!escapeInterrupts(now, sinceRef.current, escArmedRef.current)) {
				escArmedRef.current = now;
				setT(setNotice(tRef.current, ESC_AGAIN_HINT));
				return;
			}
			escArmedRef.current = undefined;
			interrupt();
		} else if (phase === 'interrupting') {
			if (!host) leave();
		} else if (edRef.current.text !== '') edit({type: 'clear'});
		else if (!host) leave();
	}, [edit, host, interrupt, leave, setT]);

	const ctrlC = useCallback(() => {
		const phase = tRef.current.phase;
		if (phase === 'running') interrupt();
		else leave();
	}, [interrupt, leave]);

	const currentPrompt = (): PromptEntry | null => {
		const head = controller.pendingPermissions[0];
		if (!head) {
			promptRef.current = null;
			return null;
		}
		if (promptRef.current?.id !== head.id) {
			pendingModeRef.current = undefined;
			const closed = {armedAt: Number.POSITIVE_INFINITY};
			promptRef.current =
				head.kind === 'tool'
					? {id: head.id, request: head, state: {...initToolPrompt(head, 0, armMs), ...closed}, armedSig: ''}
					: {id: head.id, request: head, state: {...initQuestionPrompt(head, 0, armMs), ...closed}, armedSig: ''};
		}
		return promptRef.current;
	};

	const answer = (p: PromptEntry, decision: PermissionDecision, stopTurn: boolean | undefined) => {
		const others = controller.pendingPermissions.filter(r => r.id !== p.id);
		controller.answerPermission(p.id, decision);
		if (!stopTurn) return;
		for (const r of others) controller.answerPermission(r.id, {kind: 'deny', stop: true});
		interrupt();
	};

	const promptKey = (p: PromptEntry, input: string, key: Key) => {
		const pk = normalizeKey(input, key);
		const now = Date.now();
		const layout = layoutPrompt(viewRows, columns);
		let notice: string | undefined;
		let decision: PermissionDecision | undefined;
		let stopTurn: boolean | undefined;
		if (p.request.kind === 'tool') {
			const state = p.state as ToolPromptState;
			let pager;
			if (state.view === 'full') {
				const total = toolBodyRows(p.request, reveal, layout.width).length;
				pager = {max: Math.max(0, total - layout.pagerRows), page: Math.max(1, layout.pagerRows - 1)};
			}
			const blind = layout.tier === 'minimal';
			const res = toolPromptKey(state, p.request, pk, now, pager, armMs, blind);
			p.state = res.state;
			({notice, decision, stopTurn} = res);
		} else {
			const res = questionPromptKey(p.state as QuestionPromptState, p.request, pk, now, armMs, layout.budget < 4);
			p.state = res.state;
			({notice, decision, stopTurn} = res);
		}
		if (decision) answer(p, decision, stopTurn);
		setT(setNotice(tRef.current, notice));
	};

	const promptPaste = (p: PromptEntry, text: string) => {
		const now = Date.now();
		if (!isArmed(p.state, now)) return;
		if (p.request.kind === 'tool') {
			const state = p.state as ToolPromptState;
			if (state.view === 'reason') p.state = {...state, reason: appendText(state.reason, text, REASON_MAX)};
		} else {
			const state = p.state as QuestionPromptState;
			if (state.view === 'other') p.state = {...state, other: appendText(state.other, text, QUESTION_LIMITS.freeText)};
		}
		render();
	};

	const modeKey = (key: Key) => {
		const pending = pendingModeRef.current;
		if (!pending || Date.now() < pending.armedAt) return;
		pendingModeRef.current = undefined;
		if (key.return && !key.meta && !key.shift) {
			controller.setMode(pending.mode);
			setT({...tRef.current, mode: controller.mode, notice: undefined});
		} else {
			setT(setNotice(tRef.current, undefined));
		}
	};

	const activeMention = (): {start: number; matches: string[]} | undefined => {
		if (mentionRef.current.dismissed || !props.files) return undefined;
		const ed = edRef.current;
		const at = mentionAt(ed.text, ed.cursor);
		if (!at) return undefined;
		const matches = matchFiles(props.files(), at.query, MENTION_ROWS);
		return matches.length > 0 ? {start: at.start, matches} : undefined;
	};

	const activeCommand = (): SlashHints | undefined => {
		if (commandRef.current.dismissed) return undefined;
		const commands = commandHost(host);
		if (!commands) return undefined;
		const ed = edRef.current;
		if (!ed.text.startsWith('/')) return undefined;
		const now = Date.now();
		if (!commandListRef.current || now - commandListRef.current.at > COMMAND_LIST_MS) commandListRef.current = {at: now, list: commands.listCommands()};
		return slashHints(commandListRef.current.list, ed.text, ed.cursor, MENTION_ROWS);
	};

	const acceptCommand = (c: SlashHints) => {
		const choice = c.matches[Math.min(commandRef.current.selected, c.matches.length - 1)];
		if (choice === undefined) return;
		const ed = edRef.current;
		undoRef.current.push(ed);
		const text = `/${[...c.path, choice.name].join(' ')} `;
		edRef.current = {...ed, text, cursor: text.length, truncated: false};
		commandRef.current = {selected: 0, dismissed: false};
		render();
	};

	const acceptMention = (m: {start: number; matches: string[]}) => {
		const choice = m.matches[Math.min(mentionRef.current.selected, m.matches.length - 1)];
		if (choice === undefined) return;
		const ed = edRef.current;
		const insert = `@${choice} `;
		undoRef.current.push(ed);
		edRef.current = {...ed, text: ed.text.slice(0, m.start) + insert + ed.text.slice(ed.cursor), cursor: m.start + insert.length, truncated: false};
		mentionRef.current = {selected: 0, dismissed: false};
		render();
	};

	const findInHistory = (query: string, from: number): number => {
		const q = query.toLowerCase();
		for (let i = Math.min(from, sentHistory.length - 1); i >= 0; i--) {
			if (sentHistory[i]!.toLowerCase().includes(q)) return i;
		}
		return -1;
	};

	const searchKey = (input: string, key: Key) => {
		const s = searchRef.current!;
		if (key.escape || (key.ctrl && input === 'g')) {
			edRef.current = s.draft;
			searchRef.current = undefined;
			return render();
		}
		if (key.ctrl && input === 'r') {
			const older = findInHistory(s.query, s.index - 1);
			if (older >= 0) searchRef.current = {...s, index: older};
			return render();
		}
		if (key.backspace || key.delete) {
			const query = s.query.slice(0, -1);
			searchRef.current = {...s, query, index: query ? findInHistory(query, sentHistory.length - 1) : -1};
			return render();
		}
		if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
			const query = s.query + input;
			searchRef.current = {...s, query, index: findInHistory(query, sentHistory.length - 1)};
			return render();
		}
		searchRef.current = undefined;
		if (s.index >= 0) edit({type: 'set', text: sentHistory[s.index]!});
		else render();
	};

	const viewerRows = () => Math.max(3, (rows >= 12 ? rows - 3 : rows - 1) - panelHeight - 2);

	const openViewer = () => {
		viewerRef.current = {lines: ['Loading the transcript…'], top: -1};
		render();
		props.loadTranscript!().then(
			lines => {
				if (!viewerRef.current) return;
				const shown: ViewerLine[] = lines.length > 0 ? lines.map(l => (typeof l === 'string' ? scrub(l) : l)) : ['The transcript is empty so far.'];
				const summary = tRef.current.lastSummary;
				if (summary !== undefined && summary.files.length > 0) shown.push('', {render: w => turnFilesRows(summary, w, scrub, props.projectDir)});
				viewerRef.current = {lines: shown, top: -1};
				render();
			},
			(error: unknown) => {
				if (!viewerRef.current) return;
				viewerRef.current = {lines: [`Cannot read the transcript: ${scrub(error instanceof Error ? error.message : String(error))}`], top: -1};
				render();
			},
		);
	};

	const scrollViewer = (width: number, height: number, step: (top: number, max: number) => number) => {
		const v = viewerRef.current!;
		const total = viewerRowsOf(v, width).length;
		const max = Math.max(0, total - height);
		const top = v.top < 0 ? max : v.top;
		viewerRef.current = {...v, top: Math.min(max, Math.max(0, step(top, max)))};
		render();
	};

	const viewerKey = (input: string, key: Key) => {
		if (key.escape || input === 'q' || (key.ctrl && input === 'o')) {
			viewerRef.current = undefined;
			return render();
		}
		const height = viewerRows();
		scrollViewer(columns, height, (top, max) => {
			if (key.upArrow || input === 'k') return top - 1;
			if (key.downArrow || input === 'j') return top + 1;
			if (key.pageUp || input === 'b') return top - height;
			if (key.pageDown || input === ' ' || input === 'f') return top + height;
			if (input === 'g' || key.home) return 0;
			if (input === 'G' || key.end) return max;
			return top;
		});
	};

	const openAgent = (id: string | undefined) => {
		agentTopRef.current = -1;
		focusBox({selected: id, open: id});
		render();
	};

	const scrollAgent = (cols: number, height: number, step: (top: number, max: number) => number) => {
		const box = agents.get().boxes.get(agents.get().open ?? '');
		if (!box) return;
		const total = agentViewLines(box, scrub, reveal, Math.max(1, cols - 1)).length;
		const max = Math.max(0, total - height);
		const top = agentTopRef.current < 0 ? max : Math.min(agentTopRef.current, max);
		const next = Math.min(max, Math.max(0, step(top, max)));
		agentTopRef.current = next >= max ? -1 : next;
		render();
	};

	const openAgentKey = (input: string, key: Key) => {
		const s = agents.get();
		if (key.escape) {
			focusBox({selected: s.open});
			return render();
		}
		if (key.leftArrow || key.rightArrow) {
			const ids = panelOf(columns, rows).ids;
			const at = ids.indexOf(s.open!);
			const next = ids[at < 0 ? 0 : Math.min(ids.length - 1, Math.max(0, at + (key.leftArrow ? -1 : 1)))];
			if (next !== undefined && next !== s.open) openAgent(next);
			return;
		}
		const height = viewerRows();
		scrollAgent(columns, height, (top, max) => {
			if (key.upArrow || input === 'k') return top - 1;
			if (key.downArrow || input === 'j') return top + 1;
			if (key.pageUp || input === 'b') return top - height;
			if (key.pageDown || input === ' ' || input === 'f') return top + height;
			if (input === 'g' || key.home) return 0;
			if (input === 'G' || key.end) return max;
			return top;
		});
	};

	const selectAgentKey = (input: string, key: Key): boolean => {
		const s = agents.get();
		const move: PanelMove | undefined = key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.upArrow ? 'up' : key.downArrow ? 'down' : undefined;
		if (move && !key.shift && !key.ctrl && !key.meta) {
			focusBox({selected: navigate(panelOf(columns, rows), s.selected!, move)});
			render();
			return true;
		}
		if (key.return && !key.meta && !key.shift) {
			openAgent(s.selected);
			return true;
		}
		agents.set(focusAgent(s, {}));
		render();
		return key.escape;
	};

	const onHeaderMouse = (raw: ViewMouseEvent): boolean => {
		const shown = shownRef.current;
		const layout = panelOf(shown.columns, shown.rows);
		if (raw.kind === 'wheel') {
			const scroll = Math.min(layout.maxScroll, Math.max(0, layout.scroll + (raw.wheel === 'up' ? -1 : 1)));
			agents.set({...agents.get(), scroll});
			render();
			return true;
		}
		if (raw.kind !== 'press' || raw.button !== 'left') return true;
		if (controller.pendingPermissions.length > 0 || searchRef.current || pendingModeRef.current) return true;
		const id = layout.hit(raw.x, raw.y);
		if (id === undefined) return true;
		if (agents.get().open === id) focusBox({selected: id});
		else {
			viewerRef.current = undefined;
			agentTopRef.current = -1;
			focusBox({selected: id, open: id});
		}
		render();
		return true;
	};

	const onMouse = (raw: unknown): boolean => {
		if (!validEvent(raw) || closedRef.current) return false;
		if (raw.region === 'header') return onHeaderMouse(raw);
		const shown = shownRef.current;
		if (raw.kind === 'wheel') {
			const height = Math.max(3, (shown.rows >= 12 ? shown.rows - 3 : shown.rows - 1) - shown.panelHeight - 2);
			if (agents.get().open !== undefined && controller.pendingPermissions.length === 0) {
				scrollAgent(shown.columns, height, top => top + (raw.wheel === 'up' ? -1 : 1));
				return true;
			}
			if (!viewerRef.current) return false;
			scrollViewer(shown.columns, height, top => top + (raw.wheel === 'up' ? -1 : 1));
			return true;
		}
		if (raw.kind !== 'press' || raw.button !== 'left') return false;
		if (controller.pendingPermissions.length > 0 || viewerRef.current || searchRef.current || pendingModeRef.current || agents.get().open !== undefined) return false;
		if (shown.waiting || shown.inputRows < 1) return false;
		const below = shown.belowInput + (shown.vimNormal ? 1 : 0) + (shown.statusBar ? 1 : 0);
		const row = shown.inputRows - 1 - (raw.height - 1 - below - raw.y);
		if (row < 0 || row >= shown.inputRows) return false;
		const ed = edRef.current;
		let cursor = cursorFromClick(ed.text, ed.cursor, shown.columns, shown.inputRows, row, raw.x);
		if (cursor === undefined) return false;
		if (shown.vimNormal && cursor > 0 && (cursor === ed.text.length || ed.text[cursor] === '\n') && ed.text[cursor - 1] !== '\n') cursor--;
		edit({type: 'moveTo', cursor});
		return true;
	};
	const mouseRef = useRef(onMouse);
	mouseRef.current = onMouse;
	useEffect(() => mouseHost(host)?.(event => mouseRef.current(event)), [host]);
	useEffect(() => {
		const setHeader = headerHost(host);
		if (!setHeader) return;
		setHeader(createElement(AgentPanel, {store: agents, ...(host !== undefined && {host}), scrub}));
		return () => setHeader(null);
	}, [host, agents, scrub]);

	const runVimEffect = (effect: VimEffect) => {
		switch (effect.kind) {
			case 'edit':
				return effect.actions.length > 0 ? edit(...effect.actions) : render();
			case 'submit':
				return submit();
			case 'undo':
				return undo();
			case 'history':
				return browseHistory(effect.step);
			case 'escape':
				return escape();
			case 'none':
				return render();
		}
	};

	const externalEdit = () => {
		if (!props.openEditor) return;
		const before = edRef.current;
		props.openEditor(before.text).then(
			text => {
				if (text === undefined || closedRef.current) return;
				undoRef.current.push(before);
				edRef.current = editorReduce(edRef.current, {type: 'set', text: sanitizeMultilineInput(text)});
				render();
			},
			(error: unknown) => print(formatError(error instanceof Error ? error.message : String(error), scrub)),
		);
	};

	useInput((input: string, key: Key) => {
		if (closedRef.current) return;
		if (host?.isHostKey(input, key)) return;
		const prompt = currentPrompt();
		if (prompt) return promptKey(prompt, input, key);
		if (pendingModeRef.current) return modeKey(key);
		if (key.ctrl && input === 'c') return ctrlC();
		if (agents.get().open !== undefined) return openAgentKey(input, key);
		if (agents.get().selected !== undefined && selectAgentKey(input, key)) return;
		if (viewerRef.current) return viewerKey(input, key);
		if (key.ctrl && input === 'o' && props.loadTranscript) return openViewer();
		if (searchRef.current) return searchKey(input, key);
		const vimNormalNow = props.inputMode?.() === 'vim' && vimRef.current.mode === 'normal';
		const downward = (key.downArrow && !key.shift && !key.ctrl && !key.meta) || (vimNormalNow && input === 'j' && !key.ctrl && !key.meta);
		if (downward && edRef.current.text === '' && historyRef.current.index === -1) {
			const first = panelOf(columns, rows).visibleIds[0];
			if (first !== undefined) {
				focusBox({selected: first});
				return render();
			}
		}
		const mention = activeMention();
		if (props.inputMode?.() === 'vim' && !key.ctrl && !key.meta && !key.tab && !mention) {
			const busyEscape = key.escape && tRef.current.phase !== 'idle';
			if (!busyEscape) {
				const r = vimKey(vimRef.current, {
					input,
					escape: key.escape,
					return: key.return && !key.meta && !key.shift,
					leftArrow: key.leftArrow,
					rightArrow: key.rightArrow,
					upArrow: key.upArrow && !key.shift,
					downArrow: key.downArrow && !key.shift,
					backspace: (key.backspace || key.delete) && vimRef.current.mode === 'normal',
				});
				if (r.handled) {
					vimRef.current = r.state;
					return runVimEffect(r.effect);
				}
			}
		}
		const command = mention ? undefined : activeCommand();
		if (key.escape) {
			if (mention) {
				mentionRef.current = {selected: 0, dismissed: true};
				return render();
			}
			if (command) {
				commandRef.current = {selected: 0, dismissed: true};
				return render();
			}
			return escape();
		}
		if (key.tab && key.shift) return cycleMode();
		if (tRef.current.notice !== undefined) setT(setNotice(tRef.current, undefined));
		if (mention) {
			if (key.upArrow || key.downArrow) {
				const n = mention.matches.length;
				mentionRef.current = {...mentionRef.current, selected: (mentionRef.current.selected + (key.upArrow ? n - 1 : 1)) % n};
				return render();
			}
			if (key.tab || (key.return && !key.meta && !key.shift)) return acceptMention(mention);
		}
		if (command) {
			if (key.upArrow || key.downArrow) {
				const n = command.matches.length;
				commandRef.current = {...commandRef.current, selected: (commandRef.current.selected + (key.upArrow ? n - 1 : 1)) % n};
				return render();
			}
			const exact = command.query === '' && command.path.length > 0 ? true : command.matches.some(c => c.name === command.query);
			if (key.tab || (key.return && !key.meta && !key.shift && !exact)) return acceptCommand(command);
		}
		if (key.tab) {
			host?.togglePanel?.();
			return;
		}
		if (key.return) {
			if (key.meta || key.shift) return edit({type: 'insert', text: '\n'});
			return submit();
		}
		if ((key.backspace || key.delete) && key.meta) return edit({type: 'killWordBack'});
		if (key.backspace || key.delete) return edit({type: 'backspace'});
		if (key.leftArrow) return edit({type: key.ctrl || key.meta ? 'wordLeft' : 'left'});
		if (key.rightArrow) {
			if (key.ctrl || key.meta) return edit({type: 'wordRight'});
			if (host && edRef.current.text === '' && host.move('right')) return;
			return edit({type: 'right'});
		}
		if (key.home) return edit({type: 'home'});
		if (key.end) return edit({type: 'end'});
		if (input === '\u001f' || (key.ctrl && (input === '_' || input === '/'))) return undo();
		if (key.ctrl) {
			if (input === 'a') return edit({type: 'home'});
			if (input === 'e') return edit({type: 'end'});
			if (input === 'u') return edit({type: 'killLine'});
			if (input === 'k') return edit({type: 'killEnd'});
			if (input === 'w') return edit({type: 'killWordBack'});
			if (input === 'y') return edit({type: 'yank'});
			if (input === 'g') return externalEdit();
			if (input === 'b') {
				void controller.backgroundTasks?.().then(moved => {
					if (!closedRef.current) setT(setNotice(tRef.current, moved ? 'Moved the running work to the background.' : 'Nothing is running that could go to the background.'));
				});
				return;
			}
			if (input === 'r' && sentHistory.length > 0) {
				searchRef.current = {query: '', index: -1, draft: edRef.current};
				return render();
			}
			return;
		}
		if (key.meta) {
			if (input === 'b') return edit({type: 'wordLeft'});
			if (input === 'f') return edit({type: 'wordRight'});
			if (input === 'd') return edit({type: 'killWordForward'});
			return;
		}
		if ((key.upArrow || key.downArrow) && !key.shift) return browseHistory(key.upArrow ? -1 : 1);
		if (key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
		if (input) insertPasted(input);
	}, {isActive: focused});

	usePaste((text: string) => {
		if (closedRef.current) return;
		if (host?.isHostKey(text)) return;
		const prompt = currentPrompt();
		if (prompt) return promptPaste(prompt, text);
		if (pendingModeRef.current || agents.get().open !== undefined) return;
		insertPasted(text);
	}, {isActive: focused});

	useEffect(() => {
		host?.setTitle?.(barTitle, sessionId8);
	});

	useEffect(() => {
		const p = promptRef.current;
		if (!p) return;
		const sig = promptSig(p, layoutPrompt(viewRows, columns).tier);
		if (p.armedSig === sig) return;
		p.armedSig = sig;
		p.state = rearm(p.state, Date.now(), armMs) as typeof p.state;
	});

	const prompt = currentPrompt();
	const t = tRef.current;
	const ed = edRef.current;
	const limit = limitIndicator(t.limit, clock);
	const resetsAt = t.limit?.resetsAt;
	useEffect(() => {
		if (resetsAt === undefined) return;
		return armExpiry(resetsAt * 1000, clock, render);
	}, [resetsAt, clock, render]);
	const pin = props.pin?.current();
	const sessionId8 = t.sessionId ? scrub(t.sessionId).slice(0, 8) : undefined;
	const barTitle = scrub(controller.title ?? NEW_CHAT_TITLE);
	const statusBar = (
		<ChatStatusBar
			phase={t.phase}
			status={t.status}
			pending={controller.pendingPermissions.length}
			since={sinceRef.current}
			beat={beatRef.current}
			lastEventAt={lastEventRef.current}
			columns={columns}
			{...(t.model !== undefined && {model: t.model})}
			route={routeBarText(controller.route)}
			{...(controller.context !== undefined && {context: controller.context})}
			{...(t.account !== undefined && {account: t.account})}
			{...(pin !== undefined && {pin})}
			{...(limit !== undefined && {limit})}
			tasks={controller.tasks ?? []}
			{...(props.projectDir !== undefined && {project: basename(props.projectDir)})}
			{...(branchRef.current !== undefined && {branch: branchRef.current})}
			scrub={scrub}
		/>
	);
	shownRef.current = {columns, rows, inputRows: 0, vimNormal: false, statusBar: true, waiting: false, belowInput: 0, panelHeight};
	const headerSlot = headerHost(host) !== undefined;
	const fallbackPanel = headerSlot ? null : <AgentPanel store={agents} {...(host !== undefined && {host})} scrub={scrub} rows={rows} />;

	if (prompt) {
		const layout = layoutPrompt(viewRows, columns);
		const total = batchRef.current + controller.pendingPermissions.length;
		const position = batchRef.current + 1;
		return (
			<Box flexDirection="column">
				{fallbackPanel}
				{prompt.request.kind === 'tool' ? (
					<PermissionPrompt
						request={prompt.request}
						state={prompt.state as ToolPromptState}
						layout={layout}
						reveal={reveal}
						position={position}
						total={total}
						approvals={t.approvals}
						notice={t.notice}
					/>
				) : (
					<QuestionPrompt
						request={prompt.request}
						state={prompt.state as QuestionPromptState}
						layout={layout}
						reveal={reveal}
						position={position}
						total={total}
						notice={t.notice}
					/>
				)}
				{statusBar}
			</Box>
		);
	}

	const openBox = agentsState.open !== undefined ? agentsState.boxes.get(agentsState.open) : undefined;
	if (openBox) {
		const width = Math.max(1, columns - 1);
		const lines = agentViewLines(openBox, scrub, reveal, width);
		const height = viewerRows();
		const max = Math.max(0, lines.length - height);
		const top = agentTopRef.current < 0 ? max : Math.min(agentTopRef.current, max);
		const shown = lines.slice(top, top + height);
		const footer = `Subagent ${scrub(openBox.name).replace(/\s+/g, ' ')} · read-only · ↑↓ j k scroll · ←→ other agent · Esc back`;
		return (
			<Box flexDirection="column">
				{fallbackPanel}
				{shown.map((line, i) => (
					<Text key={i} wrap="truncate">
						{line === '' ? ' ' : line}
					</Text>
				))}
				<Text dimColor>{'─'.repeat(width)}</Text>
				<Text dimColor wrap="truncate">
					{truncateCells(footer, width)}
				</Text>
				{statusBar}
			</Box>
		);
	}

	if (viewerRef.current) {
		const v = viewerRef.current;
		const wrapped = viewerRowsOf(v, columns);
		const height = viewerRows();
		const max = Math.max(0, wrapped.length - height);
		const top = v.top < 0 ? max : Math.min(v.top, max);
		const shown = wrapped.slice(top, top + height);
		return (
			<Box flexDirection="column">
				{fallbackPanel}
				{shown.map((line, i) => (
					<Text key={i} wrap="truncate">
						{line === '' ? ' ' : line}
					</Text>
				))}
				<Text dimColor wrap="truncate">{`Transcript ${Math.min(wrapped.length, top + shown.length)}/${wrapped.length} · ↑↓ j k · space b page · g G ends · Esc or Ctrl+O close`}</Text>
				{statusBar}
			</Box>
		);
	}

	const tools = [...t.tools.values()];
	const running = t.phase !== 'idle';
	const pendingMode = pendingModeRef.current?.mode;
	const noticeText =
		pendingMode === 'auto'
			? 'Let a model classifier approve or deny tool calls (Bash and edits included) for this chat? It asks you only when unsure. Enter to confirm, any other key cancels.'
			: pendingMode
				? `Auto-accept Edit/Write inside ${scrub(props.projectDir ?? 'the project')} for this chat? Enter to confirm, any other key cancels.`
				: t.notice;
	const hint = modeHint(t.mode);
	const rule = '─'.repeat(Math.max(1, columns - 1));
	const cap = (rows >= 12 ? rows - 3 : rows - 1) - panelHeight;
	let rem = Math.max(0, cap - 2);
	const ruleRows = rem >= 6 ? 2 : 0;
	rem -= ruleRows;
	const hintRows = hint && rem >= 4 ? 1 : 0;
	rem -= hintRows;
	const inputRows = Math.min(LIVE.maxInputRows, inputRowsNeeded(ed.text, columns), Math.max(1, Math.floor(rem / 2)));
	rem -= inputRows;
	const noticeNeeded = noticeText ? Math.ceil(noticeText.length / Math.max(1, columns)) : 0;
	const noticeRows = Math.min(noticeNeeded, 2, Math.max(0, rem));
	rem -= noticeRows;
	const mention = activeMention();
	const mentionRows = mention ? Math.min(mention.matches.length, Math.max(0, rem - 2)) : 0;
	rem -= mentionRows;
	const command = mention ? undefined : activeCommand();
	const commandRows = command ? Math.min(command.matches.length, Math.max(0, rem - 2)) : 0;
	rem -= commandRows;
	const commandLabel = (name: string) => `/${[...(command?.path ?? []), name].join(' ')}`;
	const nameWidth = command ? Math.max(...command.matches.map(c => commandLabel(c.name).length)) + 1 : 0;
	const vimNormal = props.inputMode?.() === 'vim' && vimRef.current.mode === 'normal';
	rem -= vimNormal ? 1 : 0;
	const queued = queuedLines(queueRef.current, scrub, Math.min(3, Math.max(0, rem - 1)));
	rem -= queued.length;
	const todos = todoLines(t.todos, scrub, Math.min(LIVE.maxTodoRows, Math.floor(rem / 2)));
	rem -= todos.length;
	const toolRows = toolLayout(tools.length + (t.fold.length > 0 ? 1 : 0), t.liveRaw ? Math.floor(rem / 2) : rem).rows;
	rem -= toolRows;
	const tail = liveTail(t.liveRaw, scrub, Math.min(LIVE.maxTailRows, Math.max(0, rem)), columns);
	shownRef.current = {...shownRef.current, inputRows, vimNormal, waiting: running && ed.text === '', belowInput: ruleRows / 2 + hintRows};

	return (
		<Box flexDirection="column">
			{fallbackPanel}
			{tail.map((line, i) => (
				<Text key={i} wrap="truncate">
					{line === '' ? ' ' : line}
				</Text>
			))}
			<LiveTools tools={tools} fold={t.fold} scrub={scrub} maxRows={toolRows} width={Math.max(1, columns - 1)} />
			{todos.map((line, i) => (
				<Text key={`todo-${i}`} wrap="truncate">
					{line}
				</Text>
			))}
			{queued.map((line, i) => (
				<Text key={`queued-${i}`} dimColor wrap="truncate">
					{line}
				</Text>
			))}
			{noticeRows > 0 && (
				<Text dimColor wrap={noticeRows >= noticeNeeded ? 'wrap' : 'truncate'}>
					{noticeText}
				</Text>
			)}
			{mention &&
				mention.matches.slice(0, mentionRows).map((file, i) => (
					<Text key={`mention-${file}`} wrap="truncate" inverse={i === Math.min(mentionRef.current.selected, mention.matches.length - 1)}>
						{`  @${scrub(file)}`}
					</Text>
				))}
			{command &&
				command.matches.slice(0, commandRows).map((c, i) => {
					const selected = i === Math.min(commandRef.current.selected, command.matches.length - 1);
					return (
						<Text key={`command-${c.name}`} wrap="truncate">
							<Text inverse={selected}>{`  ${scrub(commandLabel(c.name)).padEnd(nameWidth)}`}</Text>
							<Text dimColor>{` ${scrub(c.description)}`}</Text>
						</Text>
					);
				})}
			{ruleRows > 0 && <Text dimColor>{rule}</Text>}
			{searchRef.current ? (
				<Text wrap="truncate">
					<Text dimColor>{`(reverse-i-search) '${scrub(searchRef.current.query)}': `}</Text>
					{searchRef.current.index >= 0 ? scrub(sentHistory[searchRef.current.index]!.replace(/\s+/g, ' ')) : ''}
				</Text>
			) : (
				<InputLine text={ed.text} cursor={ed.cursor} columns={columns} maxRows={inputRows} />
			)}
			{ruleRows > 0 && <Text dimColor>{rule}</Text>}
			{vimNormal && <Text dimColor>-- NORMAL --</Text>}
			{hintRows > 0 && (
				<Text wrap="truncate" color={MODE_COLOR[t.mode]}>
					{`  ${hint}`}
				</Text>
			)}
			{statusBar}
		</Box>
	);
}
