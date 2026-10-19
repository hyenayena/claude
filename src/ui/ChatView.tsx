import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Box, Text, useInput, usePaste, useWindowSize, type Key} from 'ink';
import type {ViewHost} from '../../../../src/api.js';
import type {ChatController, ChatEvent} from '../chat/events.js';
import {MODE_CYCLE, QUESTION_LIMITS, REASON_MAX} from '../chat/permission.js';
import type {ChatMode, PermissionDecision, PermissionRequest} from '../chat/permission.js';
import {sanitizeInput} from '../chat/sanitize.js';
import {editorReduce, emptyEditor, MAX_INPUT, type EditorAction, type EditorState} from './editor.js';
import {InputLine} from './InputLine.js';
import {LiveTools, toolLayout} from './LiveTools.js';
import {PermissionPrompt} from './PermissionPrompt.js';
import {
	formatError,
	formatOut,
	formatUserLine,
	liveTail,
	statusBarText,
	statusLineText,
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
import {StatusBar} from './StatusBar.js';
import {useViewHost} from './view-host.js';
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
	print: (text: string) => void;
	close: () => void;
	scrub: Scrub;
	credentialLabel: string;
	initialModel?: string;
	initialSessionId?: string;
	reveal?: (s: string) => string;
	projectDir?: string;
	armMs?: number;
	// Set when the chat shares the screen with the console: focus, width and reserved keys.
	host?: ViewHost;
}

type PromptEntry =
	| {id: string; request: Extract<PermissionRequest, {kind: 'tool'}>; state: ToolPromptState; armedSig: string}
	| {id: string; request: Extract<PermissionRequest, {kind: 'question'}>; state: QuestionPromptState; armedSig: string};

const promptSig = (p: PromptEntry, tier: string): string =>
	p.request.kind === 'tool'
		? `${p.id}:${(p.state as ToolPromptState).view}:${tier}`
		: `${p.id}:${(p.state as QuestionPromptState).index}:${(p.state as QuestionPromptState).view}:${tier}`;

export const BUSY_HINT = 'Wait for the answer or press Esc to interrupt';
export const DOUBLE_ESC_MS = 500;
export const NEW_CHAT_TITLE = 'New chat';
const MODE_NAME: Record<ChatMode, string> = {default: 'default', acceptEdits: 'accept-edits', auto: 'auto'};

export function ChatView(props: ChatViewProps) {
	const {controller, print, close, scrub, credentialLabel} = props;
	const reveal = props.reveal ?? scrub;
	const armMs = props.armMs ?? ARM_MS;
	const terminal = useWindowSize();
	const rows = terminal.rows;
	const {focused, columns} = useViewHost(props.host, terminal.columns);
	const host = props.host;

	// Keys and events can arrive faster than React re-renders, so refs hold the truth.
	const tRef = useRef<TranscriptState>(
		initialTranscript({
			model: props.initialModel ?? controller.model,
			sessionId: props.initialSessionId ?? controller.sessionId,
			mode: controller.mode,
			pending: controller.pendingPermissions.length,
		}),
	);
	const promptRef = useRef<PromptEntry | null>(null);
	const batchRef = useRef(0);
	const pendingModeRef = useRef<{mode: ChatMode; armedAt: number} | undefined>(undefined);
	const edRef = useRef<EditorState>(emptyEditor);
	const closedRef = useRef(false);
	const [, setTick] = useState(0);
	const render = useCallback(() => setTick(n => n + 1), []);

	const setT = useCallback(
		(next: TranscriptState) => {
			tRef.current = next;
			render();
		},
		[render],
	);
	const edit = useCallback(
		(action: EditorAction) => {
			edRef.current = editorReduce(edRef.current, action);
			render();
		},
		[render],
	);

	const feed = useCallback(
		(event: ChatEvent) => {
			if (closedRef.current) return;
			if (event.type === 'sent') {
				print(formatUserLine(event.text, scrub));
				return;
			}
			if (event.type === 'permission-resolved') {
				batchRef.current = event.pending === 0 ? 0 : batchRef.current + 1;
			}
			const step = reduceTranscript(tRef.current, event);
			setT(event.type === 'turn-end' ? {...step.state, notice: undefined} : step.state);
			for (const out of step.out) print(formatOut(out, scrub, reveal));
		},
		[print, scrub, reveal, setT],
	);

	const cancelPending = useCallback(() => {
		for (const req of [...controller.pendingPermissions]) {
			controller.answerPermission(req.id, {kind: 'cancel', cause: 'closed'});
		}
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
			edit({type: 'insert', text: sanitizeInput(raw)});
			const after = edRef.current;
			const requested = sanitizeInput(raw).length;
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
			if (mode === 'default') {
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
		const t = tRef.current;
		if (t.phase !== 'idle') {
			setT(setNotice(t, BUSY_HINT));
			return;
		}
		edRef.current = emptyEditor;
		setT(setNotice(tRef.current, undefined));
		try {
			controller.send(text);
		} catch (error) {
			print(formatError(error instanceof Error ? error.message : String(error), scrub));
			return;
		}
		if (controller.state === 'running') feed({type: 'state', state: 'running'});
	}, [controller, feed, host, leave, print, requestMode, scrub, setT]);

	// Time of an Esc on an idle, empty chat; a second one soon after opens the console.
	const lastEmptyEscRef = useRef(0);
	const escape = useCallback(() => {
		const phase = tRef.current.phase;
		const first = lastEmptyEscRef.current;
		lastEmptyEscRef.current = 0;
		if (phase === 'running') interrupt();
		// Next to the console the chat is the main screen: only Ctrl+C leaves it.
		else if (phase === 'interrupting') {
			if (!host) leave();
		} else if (edRef.current.text !== '') edit({type: 'clear'});
		// The chat is the main screen next to the console, so Esc never leaves it there.
		else if (!host) leave();
		else {
			const now = Date.now();
			if (first !== 0 && now - first <= DOUBLE_ESC_MS) host.togglePanel?.();
			else lastEmptyEscRef.current = now;
		}
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

	useInput((input: string, key: Key) => {
		if (closedRef.current) return;
		if (host?.isHostKey(input, key)) return;
		const prompt = currentPrompt();
		if (prompt) return promptKey(prompt, input, key);
		if (pendingModeRef.current) return modeKey(key);
		if (key.ctrl && input === 'c') return ctrlC();
		if (key.escape) return escape();
		lastEmptyEscRef.current = 0;
		if (key.tab && key.shift) return cycleMode();
		if (tRef.current.notice !== undefined) setT(setNotice(tRef.current, undefined));
		if (key.return) {
			if (key.meta || key.shift) return edit({type: 'insert', text: '\n'});
			return submit();
		}
		if (key.backspace || key.delete) return edit({type: 'backspace'});
		if (key.leftArrow) return edit({type: 'left'});
		if (key.rightArrow) {
			if (host && edRef.current.text === '' && host.move('right')) return;
			return edit({type: 'right'});
		}
		if (key.home) return edit({type: 'home'});
		if (key.end) return edit({type: 'end'});
		if (key.ctrl) {
			if (input === 'a') return edit({type: 'home'});
			if (input === 'e') return edit({type: 'end'});
			if (input === 'u') return edit({type: 'killLine'});
			return;
		}
		if (key.meta || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
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
		host?.setTitle?.(barTitle, barStatus);
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
	const barStatus = statusBarText(
		{
			credentialLabel,
			model: t.model,
			sessionId: t.sessionId,
			phase: t.phase,
			mode: controller.mode,
			pending: controller.pendingPermissions.length,
		},
		scrub,
	);
	// A host with a title bar shows the chat's name and this status above the chat instead.
	const barTitle = scrub(controller.title ?? NEW_CHAT_TITLE);
	const statusBar = host?.setTitle ? null : <StatusBar text={barStatus} />;

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

	const tools = [...t.tools.values()];
	const statusText = statusLineText(t.status);
	const pendingMode = pendingModeRef.current?.mode;
	const noticeText =
		pendingMode === 'auto'
			? 'Let a model classifier approve or deny tool calls (Bash and edits included) for this chat? It asks you only when unsure. Enter to confirm, any other key cancels.'
			: pendingMode
				? `Auto-accept Edit/Write inside ${scrub(props.projectDir ?? 'the project')} for this chat? Enter to confirm, any other key cancels.`
				: t.notice;
	// Stay under the terminal height or Ink falls back to clearing the screen every frame
	const cap = rows >= 12 ? rows - 3 : rows - 1;
	let rem = Math.max(0, cap - 1);
	const inputRows = Math.min(LIVE.maxInputRows, ed.text.split('\n').length, Math.max(1, Math.floor(rem / 2)));
	rem -= inputRows;
	const noticeNeeded = noticeText ? Math.ceil(noticeText.length / Math.max(1, columns)) : 0;
	const noticeRows = Math.min(noticeNeeded, 2, Math.max(0, rem));
	rem -= noticeRows;
	const statusRows = statusText && rem > 0 ? 1 : 0;
	rem -= statusRows;
	const toolRows = toolLayout(tools.length, t.liveRaw ? Math.floor(rem / 2) : rem).rows;
	rem -= toolRows;
	const tail = liveTail(t.liveRaw, scrub, Math.min(LIVE.maxTailRows, Math.max(0, rem)), columns);

	return (
		<Box flexDirection="column">
			{tail.map((line, i) => (
				<Text key={i} wrap="truncate">
					{line === '' ? ' ' : line}
				</Text>
			))}
			<LiveTools tools={tools} scrub={scrub} maxRows={toolRows} />
			{statusRows > 0 && <Text dimColor wrap="truncate">{statusText}</Text>}
			{noticeRows > 0 && (
				<Text dimColor wrap={noticeRows >= noticeNeeded ? 'wrap' : 'truncate'}>
					{noticeText}
				</Text>
			)}
			<InputLine text={ed.text} cursor={ed.cursor} columns={columns} running={t.phase !== 'idle'} maxRows={inputRows} />
			{statusBar}
		</Box>
	);
}
