import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Box, Text, useInput, usePaste, useWindowSize, type Key} from 'ink';
import type {PrintOptions, ViewHost} from '../../../../src/api.js';
import type {ChatController, ChatEvent} from '../chat/events.js';
import {limitIndicator, systemClock, type Clock} from '../chat/limits.js';
import {MODE_CYCLE, QUESTION_LIMITS, REASON_MAX} from '../chat/permission.js';
import type {ChatMode, PermissionDecision, PermissionRequest} from '../chat/permission.js';
import {sanitizeMultilineInput, wrapLines} from '../kit.js';
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
	statusBarText,
	tasksBarText,
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
import {WorkingLine} from './WorkingLine.js';
import {StatusBar, useViewHost} from './kit.js';
import {mouseHost, validEvent} from './view-mouse.js';
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
	// The account the chat starts on, shown first in the status bar.
	initialAccount?: string;
	// Text the input starts with (e.g. the prompt a rewind went back to).
	initialDraft?: string;
	// Sent once when the view mounts, as if typed and sent.
	initialSend?: string;
	// Called on mount with a function that sends a message as if typed (queued while a turn runs), and with undefined on unmount.
	onInbox?: (deliver: ((text: string) => void) | undefined) => void;
	// Project files for @ mentions (read lazily, may be empty until loaded).
	files?: () => readonly string[];
	// Opens the draft in an external editor (Ctrl+G); resolves with the new text, or undefined.
	openEditor?: (text: string) => Promise<string | undefined>;
	// The whole conversation with full tool input and output, for Ctrl+O (raw lines, scrubbed here).
	loadTranscript?: () => Promise<string[]>;
	// 'vim' turns on NORMAL/INSERT editing; read on every key so a settings change applies at once.
	inputMode?: () => 'normal' | 'vim';
	reveal?: (s: string) => string;
	projectDir?: string;
	armMs?: number;
	// Set when the chat shares the screen with the console: focus, width and reserved keys.
	host?: ViewHost;
	// Time source for the rate-limit indicator; tests inject a fake.
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
export const NEW_CHAT_TITLE = 'New chat';
export const MAX_QUEUED = 20;
const MAX_UNDO = 100;
// setTimeout overflows past 2^31-1 ms.
const MAX_TIMER_MS = 2_000_000_000;

/** Calls `fire` once `clock` reaches `atMs`, re-arming while a capped wait ends early. Returns the canceller. */
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

// Messages sent in this run of yena, for ↑/↓ in any chat.
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
type Viewer = {lines: string[]; top: number; wrapped?: {width: number; rows: string[]}};

// Wrapping a long transcript takes tens of milliseconds; doing it on every scroll step made the
// viewer lag, so the rows are kept until the width changes.
export function viewerRowsOf(v: Viewer, columns: number): string[] {
	const width = Math.max(1, columns - 1);
	if (v.wrapped?.width !== width) v.wrapped = {width, rows: wrapLines(v.lines, width, {mode: 'char'})};
	return v.wrapped.rows;
}

const MODE_NAME: Record<ChatMode, string> = {default: 'default', acceptEdits: 'accept-edits', plan: 'plan', auto: 'auto'};

// Claude Code's colours for the mode hint under the input.
const MODE_COLOR: Record<ChatMode, string | undefined> = {default: undefined, acceptEdits: 'magenta', plan: 'cyan', auto: 'yellow'};

export function ChatView(props: ChatViewProps) {
	const {controller, print: printRaw, close, scrub} = props;
	// Claude Code's rhythm: one empty line before every block. A notice line (audit, mode) belongs to
	// the block that follows it, so no gap is left after it.
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
	// When the running turn started, for the seconds on the working line.
	const sinceRef = useRef(Date.now());
	const lastEventRef = useRef(Date.now());
	const reveal = props.reveal ?? scrub;
	const armMs = props.armMs ?? ARM_MS;
	const terminal = useWindowSize();
	const rows = terminal.rows;
	const {focused, columns} = useViewHost(props.host);
	const host = props.host;
	const clock = props.clock ?? systemClock;

	// Keys and events can arrive faster than React re-renders, so refs hold the truth.
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
	// Messages queued while detached, with no turn left to send them, come back as draft text.
	const strandedRef = useRef(controller.state === 'running' ? '' : (controller.queued ?? []).join('\n\n'));
	const initialText = [props.initialDraft ?? '', strandedRef.current].filter(Boolean).join('\n');
	const edRef = useRef<EditorState>(initialText ? editorReduce(emptyEditor, {type: 'insert', text: initialText}) : emptyEditor);
	const closedRef = useRef(false);
	// Messages typed while Claude answers; sent together when the turn ends.
	const queueRef = useRef<string[]>(controller.state === 'running' ? [...(controller.queued ?? [])] : []);
	const setQueue = useCallback(
		(next: string[]) => {
			queueRef.current = next;
			controller.setQueued?.(next);
		},
		[controller],
	);
	// Position while browsing the history with ↑/↓ (-1: not browsing) and the draft it replaced.
	const historyRef = useRef<{index: number; draft: EditorState}>({index: -1, draft: emptyEditor});
	// Ctrl+R: the query, the history index it matched, and the draft to restore on Esc.
	const searchRef = useRef<{query: string; index: number; draft: EditorState} | undefined>(undefined);
	// @ mentions: the highlighted suggestion; dismissed after Esc until the text changes.
	const mentionRef = useRef<{selected: number; dismissed: boolean}>({selected: 0, dismissed: false});
	// "/" command hints: the highlighted command; dismissed after Esc until the text changes.
	const commandRef = useRef<{selected: number; dismissed: boolean}>({selected: 0, dismissed: false});
	const commandListRef = useRef<{at: number; list: ViewCommandInfo[]} | undefined>(undefined);
	const vimRef = useRef<VimState>(vimStart);
	// Ctrl+O: the full transcript and the first row shown (-1 means the bottom).
	const viewerRef = useRef<Viewer | undefined>(undefined);
	// What the last render showed, for mouse events that arrive between renders.
	const shownRef = useRef({columns: 0, rows: 0, inputRows: 0, vimNormal: false, statusBar: false, waiting: false, belowInput: 0});
	const [, setTick] = useState(0);
	const render = useCallback(() => setTick(n => n + 1), []);
	// Core reports 0 columns while the console covers the chat; tables are laid out to the last real width.
	const lastWidthRef = useRef(0);
	if (columns > 0) lastWidthRef.current = columns;

	const setT = useCallback(
		(next: TranscriptState) => {
			tRef.current = next;
			render();
		},
		[render],
	);
	// Earlier drafts for undo (Ctrl+_ or vim u).
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

	const feed = useCallback(
		(event: ChatEvent) => {
			if (closedRef.current) return;
			lastEventRef.current = Date.now();
			if (event.type === 'sent') {
				print(formatUserLine(event.text, scrub));
				return;
			}
			if (event.type === 'steer-failed') {
				// The chat's process got it after the turn: queue it, or back to the draft when nothing runs.
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
			for (const out of step.out) {
				if (out.kind === 'blank') continue;
				if (out.kind === 'assistant') {
					// The transcript keeps a row's last column empty, so the first layout leaves it too.
					const width = lastWidthRef.current > 1 ? lastWidthRef.current - 1 : undefined;
					const block = assistantPrint(out.text, scrub, {interrupted: out.interrupted, width, copyLabel: true});
					print(block.text, block.options);
					continue;
				}
				if (out.kind === 'tool' || out.kind === 'audit') {
					// A call stays on one row and its output within a few rows; laid out again at every width.
					const width = lastWidthRef.current > 1 ? lastWidthRef.current - 1 : undefined;
					const text = formatOut(out, scrub, reveal, width);
					const options: PrintOptions = {render: w => formatOut(out, scrub, reveal, w)};
					if (out.kind === 'audit') printNotice(text, options);
					else print(text, options);
					continue;
				}
				const text = formatOut(out, scrub, reveal, lastWidthRef.current || undefined);
				if (out.kind === 'mode' || out.kind === 'account') printNotice(text);
				else print(text);
			}
			if (event.type === 'turn-end' && queueRef.current.length > 0) {
				// After an interrupt, limit or context failure the queued text comes back to the draft instead of being sent.
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
		[print, printNotice, scrub, reveal, setT, render, setQueue],
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
		// A chat in another process keeps its pending permissions for the next attach.
		if (controller.detachesOnClose) return;
		for (const req of [...controller.pendingPermissions]) {
			controller.answerPermission(req.id, {kind: 'cancel', cause: 'closed'});
		}
	}, [controller]);

	useLayoutEffect(() => {
		// The stranded queue now lives in the draft; the chat's process must not keep a copy.
		if (strandedRef.current) controller.setQueued?.([]);
	}, [controller]);

	useLayoutEffect(() => {
		const unsubscribe = controller.subscribe(feed);
		return () => {
			unsubscribe();
			closedRef.current = true;
			cancelPending();
			// Synchronous so the child process is killed even when the app unmounts on a signal
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
			// Default and plan only take permissions away, so they need no confirmation.
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

	// A message typed while a turn runs goes into that turn (read between steps); false when the queue is full.
	const steerOrQueue = useCallback(
		(text: string): boolean => {
			// Messages already queued go first, so a later one cannot overtake them.
			if (tRef.current.phase === 'running' && controller.steer && queueRef.current.length === 0) {
				try {
					controller.steer(text);
					return true;
				} catch {
					// The turn is just ending: the message waits for the next one.
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
		// Vim-style ":q" exits the application (or leaves the chat when there is no host).
		if (text === ':q' || text === ':q!') {
			edRef.current = emptyEditor;
			if (host?.quit) host.quit();
			else leave();
			return;
		}
		const slash = parseSlash(text);
		const commands = commandHost(host);
		// A yena console command: it runs in the console (which opens beside the chat), not in Claude.
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
			// Refused (e.g. another session is working): the text goes back into the input.
			edRef.current = editorReduce(emptyEditor, {type: 'insert', text});
			print(formatError(error instanceof Error ? error.message : String(error), scrub));
			render();
			return;
		}
		if (controller.state === 'running') feed({type: 'state', state: 'running'});
	}, [controller, feed, host, leave, print, printNotice, render, requestMode, scrub, setT, steerOrQueue]);

	// "claude start <message>": the message goes out once, right after the view is up.
	const sentInitial = useRef(false);
	useEffect(() => {
		const text = props.initialSend;
		if (sentInitial.current || !text) return;
		sentInitial.current = true;
		edRef.current = editorReduce(emptyEditor, {type: 'insert', text});
		submit();
	}, [props.initialSend, submit]);

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
		if (phase === 'running') interrupt();
		// Next to the console the chat is the main screen: only Ctrl+C leaves it.
		else if (phase === 'interrupting') {
			if (!host) leave();
		} else if (edRef.current.text !== '') edit({type: 'clear'});
		// The chat is the main screen next to the console, so Esc never leaves it there.
		else if (!host) leave();
	}, [edit, host, interrupt, leave]);

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
			// Held shut until the prompt has been rendered; the effect below arms it
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
		const layout = layoutPrompt(rows, columns);
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

	// The @ mention at the cursor and its suggestions, unless dismissed or nothing matches.
	const activeMention = (): {start: number; matches: string[]} | undefined => {
		if (mentionRef.current.dismissed || !props.files) return undefined;
		const ed = edRef.current;
		const at = mentionAt(ed.text, ed.cursor);
		if (!at) return undefined;
		const matches = matchFiles(props.files(), at.query, MENTION_ROWS);
		return matches.length > 0 ? {start: at.start, matches} : undefined;
	};

	// The "/command sub…" being typed and what may come next, unless dismissed.
	const activeCommand = (): SlashHints | undefined => {
		if (commandRef.current.dismissed) return undefined;
		const commands = commandHost(host);
		if (!commands) return undefined;
		const ed = edRef.current;
		if (!ed.text.startsWith('/')) return undefined;
		// Listing may read command files from disk, so it is taken at most once a second while typing.
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
		// The list stays: a command with subcommands shows them next.
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
		// Any other key takes the match into the draft (Enter does not send it yet).
		searchRef.current = undefined;
		if (s.index >= 0) edit({type: 'set', text: sentHistory[s.index]!});
		else render();
	};

	const viewerRows = () => Math.max(3, (rows >= 12 ? rows - 3 : rows - 1) - 2);

	const openViewer = () => {
		viewerRef.current = {lines: ['Loading the transcript…'], top: -1};
		render();
		props.loadTranscript!().then(
			lines => {
				if (!viewerRef.current) return;
				viewerRef.current = {lines: lines.length > 0 ? lines.map(l => scrub(l)) : ['The transcript is empty so far.'], top: -1};
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

	const onMouse = (raw: unknown): boolean => {
		if (!validEvent(raw) || closedRef.current) return false;
		const shown = shownRef.current;
		if (raw.kind === 'wheel') {
			if (!viewerRef.current) return false;
			const height = Math.max(3, (shown.rows >= 12 ? shown.rows - 3 : shown.rows - 1) - 2);
			scrollViewer(shown.columns, height, top => top + (raw.wheel === 'up' ? -1 : 1));
			return true;
		}
		if (raw.kind !== 'press' || raw.button !== 'left') return false;
		if (controller.pendingPermissions.length > 0 || viewerRef.current || searchRef.current || pendingModeRef.current) return false;
		if (shown.waiting || shown.inputRows < 1) return false;
		const below = shown.belowInput + (shown.vimNormal ? 1 : 0) + (shown.statusBar ? 1 : 0);
		const row = shown.inputRows - 1 - (raw.height - 1 - below - raw.y);
		if (row < 0 || row >= shown.inputRows) return false;
		const ed = edRef.current;
		let cursor = cursorFromClick(ed.text, ed.cursor, shown.columns, shown.inputRows, row, raw.x);
		if (cursor === undefined) return false;
		// NORMAL mode sits on a character, never after the last one of a line.
		if (shown.vimNormal && cursor > 0 && (cursor === ed.text.length || ed.text[cursor] === '\n') && ed.text[cursor - 1] !== '\n') cursor--;
		edit({type: 'moveTo', cursor});
		return true;
	};
	const mouseRef = useRef(onMouse);
	mouseRef.current = onMouse;
	useEffect(() => mouseHost(host)?.(event => mouseRef.current(event)), [host]);

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
		if (viewerRef.current) return viewerKey(input, key);
		if (key.ctrl && input === 'o' && props.loadTranscript) return openViewer();
		if (searchRef.current) return searchKey(input, key);
		const mention = activeMention();
		if (props.inputMode?.() === 'vim' && !key.ctrl && !key.meta && !key.tab && !mention) {
			// Esc while Claude answers still interrupts, whatever the vim mode.
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
			// Enter on a name typed in full, or right after a space, runs the line; otherwise Enter and Tab take the highlighted one.
			const exact = command.query === '' && command.path.length > 0 ? true : command.matches.some(c => c.name === command.query);
			if (key.tab || (key.return && !key.meta && !key.shift && !exact)) return acceptCommand(command);
		}
		// Tab with nothing to complete opens or closes the console beside the chat.
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
		// Ctrl+_ (also Ctrl+/ in many terminals) arrives as 0x1f.
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
		if (pendingModeRef.current) return;
		insertPasted(text);
	}, {isActive: focused});

	useEffect(() => {
		host?.setTitle?.(barTitle, barStatusFull);
	});

	useEffect(() => {
		const p = promptRef.current;
		if (!p) return;
		const sig = promptSig(p, layoutPrompt(rows, columns).tier);
		if (p.armedSig === sig) return;
		p.armedSig = sig;
		p.state = rearm(p.state, Date.now(), armMs) as typeof p.state;
	});

	const prompt = currentPrompt();
	const t = tRef.current;
	const ed = edRef.current;
	const limit = limitIndicator(t.limit, clock);
	const resetsAt = t.limit?.resetsAt;
	// Drops an expired indicator while the chat is idle.
	useEffect(() => {
		if (resetsAt === undefined) return;
		return armExpiry(resetsAt * 1000, clock, render);
	}, [resetsAt, clock, render]);
	const barStatusFull = statusBarText(
		{
			...(t.account !== undefined && {account: t.account}),
			model: t.model,
			sessionId: t.sessionId,
			phase: t.phase,
			pending: controller.pendingPermissions.length,
			...(limit !== undefined && {limit}),
			tasks: tasksBarText(controller.tasks ?? []),
		},
		scrub,
	);
	// A host with a title bar shows the chat's name and this status above the chat instead.
	const barTitle = scrub(controller.title ?? NEW_CHAT_TITLE);
	const statusBar = host?.setTitle ? null : <StatusBar text={barStatusFull} />;
	shownRef.current = {columns, rows, inputRows: 0, vimNormal: false, statusBar: statusBar !== null, waiting: false, belowInput: 0};

	if (prompt) {
		const layout = layoutPrompt(rows, columns);
		const total = batchRef.current + controller.pendingPermissions.length;
		const position = batchRef.current + 1;
		return (
			<Box flexDirection="column">
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

	if (viewerRef.current) {
		const v = viewerRef.current;
		const wrapped = viewerRowsOf(v, columns);
		const height = viewerRows();
		const max = Math.max(0, wrapped.length - height);
		const top = v.top < 0 ? max : Math.min(v.top, max);
		const shown = wrapped.slice(top, top + height);
		return (
			<Box flexDirection="column">
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
	// Stay under the terminal height or Ink falls back to clearing the screen every frame
	const cap = rows >= 12 ? rows - 3 : rows - 1;
	let rem = Math.max(0, cap - 1);
	// The rules around the input go first when the terminal is too short for everything.
	const ruleRows = rem >= 6 ? 2 : 0;
	rem -= ruleRows;
	const hintRows = hint && rem >= 4 ? 1 : 0;
	rem -= hintRows;
	const inputRows = Math.min(LIVE.maxInputRows, inputRowsNeeded(ed.text, columns), Math.max(1, Math.floor(rem / 2)));
	rem -= inputRows;
	const noticeNeeded = noticeText ? Math.ceil(noticeText.length / Math.max(1, columns)) : 0;
	const noticeRows = Math.min(noticeNeeded, 2, Math.max(0, rem));
	rem -= noticeRows;
	const workingRows = (running || t.status !== null) && rem > 0 ? 1 : 0;
	rem -= workingRows;
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
	const toolRows = toolLayout(tools.length, t.liveRaw ? Math.floor(rem / 2) : rem).rows;
	rem -= toolRows;
	const tail = liveTail(t.liveRaw, scrub, Math.min(LIVE.maxTailRows, Math.max(0, rem)), columns);
	// The bottom rule and the mode hint sit between the input and the status bar.
	shownRef.current = {...shownRef.current, inputRows, vimNormal, waiting: running && ed.text === '', belowInput: ruleRows / 2 + hintRows};

	return (
		<Box flexDirection="column">
			{tail.map((line, i) => (
				<Text key={i} wrap="truncate">
					{line === '' ? ' ' : line}
				</Text>
			))}
			<LiveTools tools={tools} scrub={scrub} maxRows={toolRows} />
			{workingRows > 0 && <WorkingLine phase={t.phase} status={t.status} since={sinceRef.current} lastEventAt={t.pending > 0 ? undefined : lastEventRef.current} />}
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
