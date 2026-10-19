import {PassThrough} from 'node:stream';
import type {ReactElement} from 'react';
import {render} from 'ink';
import type {ChatController, ChatEvent, ChatState, UiEvent} from '../../src/chat/events.js';
import type {ChatMode, PermissionDecision, PermissionRequest, QuestionRequest, ToolRequest} from '../../src/chat/permission.js';

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function mountHarness(element: ReactElement, size = {columns: 80, rows: 24}) {
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		raw: [] as boolean[],
		setRawMode(value: boolean) {
			this.raw.push(value);
			return this;
		},
		ref() {},
		unref() {},
	});
	const stdout = Object.assign(new PassThrough(), {isTTY: true, ...size});
	const chunks: string[] = [];
	stdout.on('data', chunk => chunks.push(String(chunk)));

	const instance = render(element, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: new PassThrough() as unknown as NodeJS.WriteStream,
		debug: true,
		interactive: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	return {
		chunks,
		press: (sequence: string) => stdin.write(sequence),
		// Escape is flushed by Ink after 20 ms, so waits must exceed that
		settle: (ms = 30) => wait(ms),
		lastFrame: () => chunks.at(-1) ?? '',
		resize(columns: number, rows: number) {
			Object.assign(stdout, {columns, rows});
			stdout.emit('resize');
		},
		unmount: () => instance.unmount(),
	};
}

export interface FakeController extends ChatController {
	calls: {
		sent: string[];
		interrupts: number;
		resets: number;
		closes: number;
		modes: ChatMode[];
		answers: Array<{id: string; decision: PermissionDecision}>;
	};
	pendingPermissions: PermissionRequest[];
	/** Queues a request and emits `permission-requested`. */
	request(req: PermissionRequest): void;
	/** Drops a request without a decision and emits `permission-resolved`. */
	resolved(id: string): void;
	emit(event: ChatEvent): void;
	ui(event: UiEvent): void;
	setState(state: ChatState): void;
}

export function fakeController(): FakeController {
	const listeners = new Set<(e: ChatEvent) => void>();
	const calls: FakeController['calls'] = {sent: [], interrupts: 0, resets: 0, closes: 0, modes: [], answers: []};
	let state: ChatState = 'idle';
	let mode: ChatMode = 'default';
	const fake: FakeController = {
		calls,
		get state() {
			return state;
		},
		sessionId: undefined,
		model: undefined,
		title: undefined as string | undefined,
		needsNewSession: false,
		get mode() {
			return mode;
		},
		pendingPermissions: [],
		setMode(next) {
			calls.modes.push(next);
			mode = next;
			fake.emit({type: 'mode', mode: next});
		},
		answerPermission(id, decision) {
			const i = fake.pendingPermissions.findIndex(r => r.id === id);
			if (i < 0) return false;
			calls.answers.push({id, decision});
			fake.pendingPermissions.splice(i, 1);
			fake.emit({type: 'permission-resolved', id, pending: fake.pendingPermissions.length});
			return true;
		},
		request(req) {
			fake.pendingPermissions.push(req);
			fake.emit({type: 'permission-requested', request: req, pending: fake.pendingPermissions.length});
		},
		resolved(id) {
			const i = fake.pendingPermissions.findIndex(r => r.id === id);
			if (i >= 0) fake.pendingPermissions.splice(i, 1);
			fake.emit({type: 'permission-resolved', id, pending: fake.pendingPermissions.length});
		},
		send(text) {
			calls.sent.push(text);
			fake.emit({type: 'sent', text});
		},
		async interrupt() {
			calls.interrupts++;
		},
		reset() {
			calls.resets++;
			if (mode !== 'default') {
				mode = 'default';
				fake.emit({type: 'mode', mode});
			}
		},
		close() {
			calls.closes++;
			state = 'closed';
		},
		subscribe(cb) {
			listeners.add(cb);
			return () => listeners.delete(cb);
		},
		emit(event) {
			for (const cb of [...listeners]) cb(event);
		},
		ui(event) {
			fake.emit({type: 'ui', event});
		},
		setState(next) {
			state = next;
			fake.emit({type: 'state', state: next});
		},
	};
	return fake;
}

export function toolReq(over: Partial<ToolRequest> = {}): ToolRequest {
	return {
		kind: 'tool',
		id: 'r1',
		seq: 1,
		toolName: 'Bash',
		input: {command: 'ls -la'},
		cwd: '/app',
		highlights: [],
		defaultToNo: false,
		always: {label: 'Always allow this exact command in this chat'},
		oversize: false,
		...over,
	};
}

export function questionReq(over: Partial<QuestionRequest> = {}): QuestionRequest {
	return {
		kind: 'question',
		id: 'q1',
		seq: 1,
		questions: [
			{
				question: 'Which color?',
				header: 'Color',
				multiSelect: false,
				options: [
					{label: 'Red', description: 'warm'},
					{label: 'Blue', description: 'cold'},
				],
			},
		],
		...over,
	};
}
