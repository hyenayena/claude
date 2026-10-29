import assert from 'node:assert/strict';
import type {PrintOptions} from '../../../../src/api.js';
import {afterEach, test} from 'node:test';
import React, {createElement} from 'react';
void React;
import {makeScrub} from '../../src/chat/scrub.js';
import type {PermissionRequest} from '../../src/chat/permission.js';
import {makeReveal} from '../../src/chat/reveal.js';
import {armExpiry, BUSY_HINT, ChatView, clearSentHistory, MAX_QUEUED, type ChatViewProps} from '../../src/ui/ChatView.js';
import {createChatElement} from '../../src/ui/mount.js';
import {fakeController, mountHarness, questionReq, toolReq, type FakeController} from './testkit.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const scrub = makeScrub(s => s.split(SECRET).join('[redacted]'));
const ESC = '\u001b';
const ENTER = '\r';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

function setup(size?: {columns: number; rows: number}, extra: Partial<ChatViewProps> = {}) {
	const controller: FakeController = fakeController();
	const printed: string[] = [];
	// Every print in order, the empty gap lines between blocks included.
	const raw: string[] = [];
	const closed = {count: 0};
	const h = mountHarness(
		createElement(ChatView, {
			controller,
			print: s => {
				raw.push(s);
				if (s !== ' ') printed.push(s);
			},
			close: () => closed.count++,
			scrub,
			...extra,
		}),
		size,
	);
	cleanup.push(() => h.unmount());
	return {controller, printed, raw, closed, ...h};
}

test('createChatElement returns a renderable element', async () => {
	const controller = fakeController();
	const h = mountHarness(
		createChatElement({controller, print() {}, close() {}, scrub}) as never,
	);
	cleanup.push(() => h.unmount());
	await h.settle();
	assert.match(h.lastFrame(), /idle$/);
});

test('typing builds the buffer and Enter sends and echoes', async () => {
	const t = setup();
	await t.settle();
	t.press('hello');
	await t.settle();
	assert.match(t.lastFrame(), /> hello/);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['hello']);
	assert.equal(t.printed.length, 1);
	assert.match(t.printed[0] as string, /hello/);
	assert.doesNotMatch(t.lastFrame(), /hello/);
});

test('Esc while running interrupts; Esc while interrupting hard-stops', async () => {
	const t = setup();
	t.controller.setState('running');
	await t.settle();
	t.press(ESC);
	await t.settle(50);
	assert.equal(t.controller.calls.interrupts, 1);
	assert.match(t.lastFrame(), /interrupting/);
	assert.equal(t.closed.count, 0);
	t.press(ESC);
	await t.settle(50);
	assert.equal(t.controller.calls.closes, 1);
	assert.equal(t.closed.count, 1);
});

test('Esc idle clears a non-empty buffer, otherwise leaves', async () => {
	const t = setup();
	await t.settle();
	t.press('abc');
	await t.settle();
	t.press(ESC);
	await t.settle(50);
	assert.doesNotMatch(t.lastFrame(), /abc/);
	assert.equal(t.closed.count, 0);
	t.press(ESC);
	await t.settle(50);
	assert.equal(t.closed.count, 1);
	assert.equal(t.controller.calls.closes, 1);
});

test('Ctrl+C in each state', async () => {
	const idle = setup();
	await idle.settle();
	idle.press('\u0003');
	await idle.settle();
	assert.equal(idle.closed.count, 1);

	const running = setup();
	running.controller.setState('running');
	await running.settle();
	running.press('\u0003');
	await running.settle();
	assert.equal(running.controller.calls.interrupts, 1);
	assert.equal(running.closed.count, 0);
	running.press('\u0003');
	await running.settle();
	assert.equal(running.closed.count, 1);
	assert.equal(running.controller.calls.closes, 1);
});

test('the chat has no slash commands: text starting with / is sent as a message', async () => {
	const t = setup();
	await t.settle();
	for (const text of ['/help', '/new', '/exit', '/mode auto']) {
		t.press(text);
		await t.settle();
		t.press(ENTER);
		await t.settle();
		t.controller.setState('idle');
		await t.settle();
	}
	assert.deepEqual(t.controller.calls.sent, ['/help', '/new', '/exit', '/mode auto']);
	assert.equal(t.controller.calls.resets, 0);
	assert.equal(t.closed.count, 0);
	assert.deepEqual(t.controller.calls.modes, []);
});

test('a paste beyond the input limit is truncated with a notice', async () => {
	const t = setup();
	await t.settle();
	t.press(`${PASTE_START}${'a'.repeat(40000)}${PASTE_END}`);
	await t.settle(100);
	assert.match(t.lastFrame(), /Input truncated to 32000 characters/);
	t.press(ENTER);
	await t.settle();
	assert.equal(t.controller.calls.sent.length, 1);
	assert.equal(t.controller.calls.sent[0]?.length, 32000);
});

test('multi-line bracketed paste is inserted without submitting', async () => {
	const t = setup();
	await t.settle();
	t.press(`${PASTE_START}line one\r\nline two${ESC}[31m${PASTE_END}`);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, []);
	const frame = t.lastFrame();
	assert.match(frame, /line one/);
	assert.match(frame, /line two/);
	assert.ok(!frame.includes(`${ESC}[31m`));
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['line one\nline two']);
});

test('streaming text stays in the live tail; the full block goes to print', async () => {
	const t = setup();
	t.controller.setState('running');
	t.controller.ui({kind: 'text-delta', text: 'streaming now'});
	await t.settle();
	assert.match(t.lastFrame(), /streaming now/);
	t.controller.ui({kind: 'text', messageId: 'm1', text: 'streaming now done'});
	t.controller.emit({type: 'turn-end', outcome: 'ok'});
	t.controller.setState('idle');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /streaming now/);
	assert.equal(t.printed.filter(p => p.includes('streaming now done')).length, 1);
});

test('turn errors are printed and the chat stays usable', async () => {
	const t = setup();
	t.controller.setState('running');
	t.controller.emit({type: 'turn-end', outcome: 'error', error: 'it broke'});
	t.controller.setState('idle');
	await t.settle();
	assert.ok(t.printed.some(p => p.includes('it broke')));
	t.press('again');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['again']);
});

test('status bar starts with the session and never shows a secret', async () => {
	const t = setup();
	t.controller.ui({kind: 'session', sessionId: 'abcdef123456', model: `model-${SECRET}`});
	t.controller.ui({kind: 'result', ok: true, subtype: 'success', costUsd: 0.0123});
	await t.settle();
	const frame = t.lastFrame();
	assert.ok(!frame.includes(SECRET));
	assert.match(frame, /abcdef12 · model-\[redacted\] · idle/);
});

test('live height stays below rows - 2 after a 50 KB stream at 24 rows', async () => {
	const t = setup({columns: 80, rows: 24});
	t.controller.setState('running');
	t.controller.ui({kind: 'tool-use', toolUseId: 'a', name: 'Bash', input: {command: 'x'}});
	for (let i = 0; i < 50; i++) {
		t.controller.ui({kind: 'text-delta', text: `${'word '.repeat(40)}\n`.repeat(5)});
	}
	await t.settle(60);
	const frame = t.lastFrame();
	assert.ok(frame.split('\n').length < 22, `frame has ${frame.split('\n').length} rows`);
	t.press('a\u001b[1;3Mb');
	t.press(`${PASTE_START}${'p\n'.repeat(30)}${PASTE_END}`);
	await t.settle(60);
	assert.ok(t.lastFrame().split('\n').length < 22);
});

test('tool call with escapes in args and results shows none', async () => {
	const t = setup();
	t.controller.setState('running');
	t.controller.ui({
		kind: 'tool-use',
		toolUseId: 't1',
		name: 'Bash',
		input: {command: `echo ${ESC}]0;pwn\u0007 ${SECRET}`},
	});
	await t.settle();
	const running = t.lastFrame();
	assert.ok(!running.includes(`${ESC}]0`));
	assert.ok(!running.includes(SECRET));
	t.controller.ui({kind: 'tool-result', toolUseId: 't1', isError: false, text: `${ESC}]52;c;AAAA\u0007out ${SECRET}`});
	await t.settle();
	const block = t.printed.join('\n');
	assert.ok(!block.includes(`${ESC}]`));
	assert.ok(!block.includes(SECRET));
	assert.match(block, /out/);
});

test('unmount calls controller.close synchronously', async () => {
	const t = setup();
	await t.settle();
	t.unmount();
	assert.equal(t.controller.calls.closes, 1);
});

test('live region respects small terminal heights', async () => {
	for (const rows of [10, 24]) {
		const t = setup({columns: 80, rows});
		t.controller.setState('running');
		for (let i = 0; i < 6; i++) {
			t.controller.ui({kind: 'tool-use', toolUseId: `t${i}`, name: 'Bash', input: {command: `cmd ${i}`}});
		}
		t.controller.ui({kind: 'text-delta', text: 'tail line\n'.repeat(40)});
		t.press(`${PASTE_START}${'long input\n'.repeat(7)}${PASTE_END}`);
		await t.settle(60);
		const height = t.lastFrame().split('\n').length;
		assert.ok(height < (rows >= 12 ? rows - 2 : rows), `rows=${rows} height=${height}`);
		assert.match(t.lastFrame(), /running/);
	}
});

test('tiny terminal does not crash and keeps the status bar', async () => {
	const t = setup({columns: 20, rows: 6});
	t.controller.setState('running');
	t.controller.ui({kind: 'tool-use', toolUseId: 'a', name: 'Bash', input: {command: 'x'}});
	t.controller.ui({kind: 'tool-use', toolUseId: 'b', name: 'Bash', input: {command: 'y'}});
	t.controller.ui({kind: 'text-delta', text: 'hello\nworld\n'});
	t.press(`${PASTE_START}a\nb\nc\nd${PASTE_END}`);
	await t.settle(60);
	const frame = t.lastFrame();
	assert.ok(frame.split('\n').length < 6);
	assert.match(frame, /running/);
});

test('a secret straddling the args cut is fully redacted in the tool line', async () => {
	const t = setup();
	t.controller.setState('running');
	t.controller.ui({kind: 'tool-use', toolUseId: 's', name: 'Bash', input: {command: `${'a'.repeat(90)} ${SECRET}`}});
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /sk-ant/);
});

const reveal = makeReveal(s => s.split(SECRET).join('[redacted]'));
const ARM = 60;
const armed = {reveal, armMs: ARM, projectDir: '/app'} satisfies Partial<ChatViewProps>;
const SHIFT_TAB = `${ESC}[Z`;
const frameRows = (frame: string): number => frame.replace(/\n+$/, '').split('\n').length;

async function typeText(t: {press: (s: string) => unknown; settle: (ms?: number) => Promise<void>}, text: string) {
	for (const ch of text) {
		t.press(ch);
		await t.settle(4);
	}
}

async function withPrompt(req: PermissionRequest = toolReq(), size?: {columns: number; rows: number}) {
	const t = setup(size, armed);
	await t.settle();
	t.controller.request(req);
	await t.settle(ARM + 50);
	return t;
}

test('the modal takes focus: keys never reach the draft and Enter never submits it', async () => {
	const t = setup(undefined, armed);
	await t.settle();
	t.press('draft text');
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(ARM + 50);
	assert.match(t.lastFrame(), /Permission|Bash: run this command/);
	assert.doesNotMatch(t.lastFrame(), /draft text/);
	for (const k of ['x', 'z', 'q', '1']) {
		t.press(k);
		await t.settle();
	}
	assert.deepEqual(t.controller.calls.sent, []);
	t.press('y');
	await t.settle();
	assert.deepEqual(t.controller.calls.answers.map(a => a.decision), [{kind: 'allow'}]);
	assert.match(t.lastFrame(), /> draft text/);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['draft text']);
});

test('y allows once, a allows always, n and Esc deny', async () => {
	const cases: Array<[string, unknown]> = [
		['y', {kind: 'allow'}],
		['a', {kind: 'allow', always: true}],
		['n', {kind: 'deny'}],
		[ESC, {kind: 'deny'}],
	];
	for (const [keys, expected] of cases) {
		const t = await withPrompt();
		t.press(keys);
		await t.settle(50);
		assert.deepEqual(t.controller.calls.answers.map(a => a.decision), [expected], JSON.stringify(keys));
		assert.equal(t.closed.count, 0);
		assert.equal(t.controller.calls.interrupts, 0);
	}
});

test('arrows plus Enter pick a choice; Tab and Shift+Tab move the selection', async () => {
	const t = await withPrompt();
	t.press('\t');
	await t.settle();
	t.press('\t');
	await t.settle();
	t.press(SHIFT_TAB);
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.answers.map(a => a.decision), [{kind: 'allow', always: true}]);
	assert.equal(t.controller.calls.modes.length, 0);
});

test('r opens the reason editor; Enter sends it, Esc returns', async () => {
	const t = await withPrompt();
	t.press('r');
	await t.settle(ARM + 50);
	await typeText(t, 'too risky');
	assert.match(t.lastFrame(), /Reason: too risky/);
	t.press(ESC);
	await t.settle(ARM + 50);
	assert.doesNotMatch(t.lastFrame(), /Reason:/);
	assert.equal(t.controller.calls.answers.length, 0);
	t.press('r');
	await t.settle(ARM + 50);
	await typeText(t, 'no thanks');
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.answers.map(a => a.decision), [{kind: 'deny', reason: 'no thanks'}]);
});

test('s and Ctrl+C deny everything and interrupt the turn without leaving', async () => {
	for (const key of ['s', '\u0003']) {
		const t = setup(undefined, armed);
		t.controller.setState('running');
		await t.settle();
		t.controller.request(toolReq({id: 'a'}));
		t.controller.request(toolReq({id: 'b'}));
		await t.settle(ARM + 50);
		t.press(key);
		await t.settle();
		assert.equal(t.controller.calls.answers.length, 2);
		assert.ok(t.controller.calls.answers.every(a => a.decision.kind === 'deny'));
		assert.equal(t.controller.calls.interrupts, 1);
		assert.equal(t.closed.count, 0);
	}
});

test('a defaultToNo request opens on Deny and ignores the y and a shortcuts', async () => {
	const t = await withPrompt(toolReq({defaultToNo: true, always: false}));
	t.press('y');
	await t.settle();
	t.press('a');
	await t.settle();
	assert.equal(t.controller.calls.answers.length, 0);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.answers.map(a => a.decision), [{kind: 'deny'}]);

	const u = await withPrompt(toolReq({defaultToNo: true, always: false}));
	u.press('\u001b[A');
	await u.settle();
	u.press(ENTER);
	await u.settle();
	assert.deepEqual(u.controller.calls.answers.map(a => a.decision), [{kind: 'allow'}]);
});

test('typeahead within the arming window is ignored; paste is ignored', async () => {
	const t = setup(undefined, {reveal, projectDir: '/app'});
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(100);
	t.press('y');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	t.press(`${PASTE_START}yyy${PASTE_END}`);
	await t.settle();
	assert.equal(t.controller.calls.answers.length, 0);
	await t.settle(400);
	t.press('y');
	await t.settle();
	assert.equal(t.controller.calls.answers.length, 1);
	assert.deepEqual(t.controller.calls.sent, []);
});

test('a double-tapped Enter cannot approve two queued prompts', async () => {
	const t = setup(undefined, armed);
	await t.settle();
	t.controller.request(toolReq({id: 'a'}));
	t.controller.request(toolReq({id: 'b'}));
	await t.settle(ARM + 50);
	assert.match(t.lastFrame(), /Permission 1 of 2/);
	t.press(ENTER);
	await t.settle(5);
	t.press('y');
	await t.settle();
	assert.equal(t.controller.calls.answers.length, 1);
	assert.match(t.lastFrame(), /Permission 2 of 2/);
});

test('escape sequences, OSC and bidi controls in a command are shown as tokens', async () => {
	const evil = `echo ${ESC}[31mred${ESC}]0;title\u0007 \u202eevil \r x ${SECRET}`;
	const t = await withPrompt(toolReq({input: {command: evil}, cliNote: {text: `note ${ESC}[2J`}}));
	const frames = t.chunks.join('');
	assert.ok(!frames.includes(`${ESC}]0`));
	assert.ok(!frames.includes('\u202e'));
	assert.ok(!frames.includes('\u0007'));
	assert.ok(!frames.includes(SECRET));
	assert.match(t.lastFrame(), /\u27e6\\x1b\u27e7\[31mred/);
	assert.match(t.lastFrame(), /\u27e6\\u\{202e\}\u27e7/);
	t.press('y');
	await t.settle();
	assert.ok(t.printed.every(p => !p.includes(`${ESC}]`)));
});

test('long lines wrap and large commands and diffs fit the live region', async () => {
	const long = 'a'.repeat(300);
	const t = await withPrompt(toolReq({input: {command: long}}));
	assert.match(t.lastFrame(), /│ a{20}/);
	t.press('n');
	await t.settle();

	for (const rows of [24, 10]) {
		const command = Array.from({length: 100}, (_, i) => `echo line ${i}`).join('\n');
		const bash = await withPrompt(toolReq({input: {command}}), {columns: 80, rows});
		assert.ok(frameRows(bash.lastFrame()) <= rows - 2, `bash rows=${rows} h=${frameRows(bash.lastFrame())}`);
		assert.match(bash.lastFrame(), /awaiting approval$/);

		const preview = {
			rows: Array.from({length: 500}, (_, i) => ({kind: (i % 2 ? 'add' : 'del') as 'add' | 'del', text: `line ${i}`, no: i + 1})),
			added: 250,
			removed: 250,
			truncated: false,
			approximate: false,
		};
		const edit = await withPrompt(
			toolReq({toolName: 'Edit', path: '/app/x.ts', input: {file_path: '/app/x.ts'}, always: false, preview}),
			{columns: 80, rows},
		);
		assert.ok(frameRows(edit.lastFrame()) <= rows - 2, `edit rows=${rows} h=${frameRows(edit.lastFrame())}`);
		assert.match(edit.lastFrame(), /awaiting approval$/);
	}
});

test('v opens the pager and Esc returns', async () => {
	const command = Array.from({length: 100}, (_, i) => `echo line ${i}`).join('\n');
	const t = await withPrompt(toolReq({input: {command}}));
	t.press('v');
	await t.settle(ARM + 50);
	assert.match(t.lastFrame(), /Full view/);
	t.press('\u001b[6~');
	await t.settle();
	assert.match(t.lastFrame(), /Full view · rows 1[0-9]-/);
	t.press(ESC);
	await t.settle(ARM + 50);
	assert.doesNotMatch(t.lastFrame(), /Full view/);
	assert.equal(t.controller.calls.answers.length, 0);
});

test('Shift+Tab asks for confirmation before accept-edits; Enter applies it', async () => {
	const t = setup(undefined, armed);
	await t.settle();
	t.press(SHIFT_TAB);
	await t.settle(ARM + 50);
	assert.match(t.lastFrame().replace(/\s+/g, ' '), /Auto-accept Edit\/Write inside \/app for this chat\? Enter to confirm, any other key cancels\./);
	assert.equal(t.controller.calls.modes.length, 0);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits']);
	assert.match(t.lastFrame(), /accept edits on/);
	assert.ok(t.printed.some(p => p.includes('auto-accept edits (this chat only)')));
	t.press(SHIFT_TAB);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan'], 'plan needs no confirmation');
	assert.match(t.lastFrame(), /plan mode on/);
	t.press(SHIFT_TAB);
	await t.settle(ARM + 50);
	assert.match(t.lastFrame().replace(/\s+/g, ' '), /Let a model classifier approve or deny tool calls/);
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan']);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan', 'auto']);
	assert.match(t.lastFrame(), /auto mode on/);
	assert.ok(t.printed.some(p => p.includes('Mode: auto (a classifier approves')));
	t.press(SHIFT_TAB);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan', 'auto', 'default']);
	assert.doesNotMatch(t.lastFrame(), /mode on|mode:/);
});

test('any other key cancels the accept-edits confirmation and Enter before arming does not apply it', async () => {
	const t = setup(undefined, {reveal, projectDir: '/app'});
	await t.settle();
	t.press(SHIFT_TAB);
	await t.settle(40);
	t.press(ENTER);
	await t.settle();
	assert.equal(t.controller.calls.modes.length, 0);
	await t.settle(400);
	t.press('x');
	await t.settle();
	assert.equal(t.controller.calls.modes.length, 0);
	assert.doesNotMatch(t.lastFrame(), /Auto-accept/);
	assert.doesNotMatch(t.lastFrame(), /> x/);
});

test('audit entries are printed once, without content', async () => {
	const t = setup(undefined, armed);
	await t.settle();
	t.controller.emit({type: 'audit', entry: {outcome: 'allowed', toolName: 'Bash', summary: 'ls -la'}});
	t.controller.emit({type: 'audit', entry: {outcome: 'auto-accepted', toolName: 'Edit', summary: '/app/a.ts (+2 -1)'}});
	await t.settle();
	assert.equal(t.printed.length, 2);
	assert.match(t.printed[0] as string, /Allowed Bash: ls -la/);
	assert.match(t.printed[1] as string, /Auto-accepted Edit: \/app\/a\.ts \(\+2 -1\)/);
});

test('the status bar shows awaiting approval while a request is pending', async () => {
	const t = await withPrompt();
	assert.match(t.lastFrame(), /awaiting approval/);
	t.press('n');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /awaiting approval/);
});

test('leaving and unmounting with a pending prompt cancel it', async () => {
	const t = await withPrompt();
	t.unmount();
	assert.deepEqual(t.controller.calls.answers.map(a => a.decision.kind), ['cancel']);
	assert.equal(t.controller.calls.closes, 1);
});

test('the approval-fatigue counter appears from the fourth request of a turn', async () => {
	const t = setup(undefined, armed);
	t.controller.setState('running');
	await t.settle();
	for (let i = 1; i <= 4; i++) {
		t.controller.request(toolReq({id: `r${i}`}));
		await t.settle(ARM + 40);
		if (i < 4) {
			assert.doesNotMatch(t.lastFrame(), /approvals this turn/);
			t.press('y');
			await t.settle();
		}
	}
	assert.match(t.lastFrame(), /4 approvals this turn/);
});

test('question prompt: single choice, multi choice and Other', async () => {
	const single = await withPrompt(questionReq());
	assert.match(single.lastFrame(), /Question from yena \(not a permission request\)/);
	single.press('2');
	await single.settle();
	assert.deepEqual(single.controller.calls.answers.map(a => a.decision), [{kind: 'answers', answers: {'Which color?': 'Blue'}}]);

	const multi = await withPrompt(
		questionReq({
			questions: [
				{
					question: 'Pick',
					header: 'P',
					multiSelect: true,
					options: [
						{label: 'Red', description: ''},
						{label: 'Blue', description: ''},
					],
				},
			],
		}),
	);
	multi.press(ENTER);
	await multi.settle();
	assert.equal(multi.controller.calls.answers.length, 0);
	multi.press(' ');
	await multi.settle();
	multi.press('\u001b[B');
	await multi.settle();
	multi.press(' ');
	await multi.settle();
	multi.press(ENTER);
	await multi.settle();
	assert.deepEqual(multi.controller.calls.answers.map(a => a.decision), [{kind: 'answers', answers: {Pick: 'Red, Blue'}}]);

	const other = await withPrompt(questionReq());
	other.press('o');
	await other.settle(ARM + 50);
	await typeText(other, 'Green');
	other.press(ENTER);
	await other.settle();
	assert.deepEqual(other.controller.calls.answers.map(a => a.decision), [{kind: 'answers', answers: {'Which color?': 'Green'}}]);

	const dismissed = await withPrompt(questionReq());
	dismissed.press('n');
	await dismissed.settle();
	assert.deepEqual(dismissed.controller.calls.answers.map(a => a.decision), [{kind: 'deny'}]);
});

function fakeHost(columns = 50) {
	const state = {focused: true, columns, moves: [] as string[], listeners: new Set<() => void>()};
	const host = {
		isFocused: () => state.focused,
		columns: () => state.columns,
		subscribe: (l: () => void) => {
			state.listeners.add(l);
			return () => void state.listeners.delete(l);
		},
		move: (d: 'left' | 'right') => {
			state.moves.push(d);
			return true;
		},
		isHostKey: (input: string, key?: {ctrl?: boolean}) => Boolean(key?.ctrl) && input === 't',
	};
	const set = (patch: Partial<{focused: boolean; columns: number}>) => {
		Object.assign(state, patch);
		for (const l of state.listeners) l();
	};
	return {host, state, set};
}

test('with a host: input is read only while focused', async () => {
	const f = fakeHost();
	const t = setup(undefined, {host: f.host});
	await t.settle();
	f.set({focused: false});
	await t.settle();
	t.press('abc');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /> abc/);
	f.set({focused: true});
	await t.settle();
	t.press('abc');
	await t.settle();
	assert.match(t.lastFrame(), /> abc/);
});

test('with a host: the host key is never typed, → on an empty draft moves focus, Esc idle stays', async () => {
	const f = fakeHost();
	const t = setup(undefined, {host: f.host});
	await t.settle();
	t.press('ab');
	await t.settle();
	t.press('\x14');
	await t.settle();
	assert.match(t.lastFrame(), /> ab/);
	t.press('\x15');
	await t.settle();
	t.press(`${ESC}[C`);
	await t.settle();
	assert.deepEqual(f.state.moves, ['right']);
	t.press('ab');
	await t.settle();
	t.press(`${ESC}[C`);
	await t.settle();
	assert.deepEqual(f.state.moves, ['right']);
	t.press(ESC);
	await t.settle(60);
	t.press(ESC);
	await t.settle(60);
	assert.equal(t.closed.count, 0);
});

test('with a host: lines fit the width the host gives', async () => {
	const f = fakeHost(30);
	const t = setup({columns: 100, rows: 24}, {host: f.host});
	await t.settle();
	t.press('x'.repeat(80));
	await t.settle();
	for (const line of t.lastFrame().split('\n')) assert.ok([...line].length <= 30, line);
});

test('with a host: Esc never opens the console (double Shift does that in core); it clears and interrupts', async () => {
	const f = fakeHost();
	let toggles = 0;
	const host = {...f.host, togglePanel: () => (toggles++, true)};
	const t = setup(undefined, {host});
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	t.press(ESC);
	await t.settle(40);
	assert.equal(toggles, 0);
	t.press('ab');
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	assert.doesNotMatch(t.lastFrame(), /> ab/, 'Esc clears the draft');
	t.controller.setState('running');
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	assert.equal(t.controller.calls.interrupts, 1, 'Esc interrupts while running');
	assert.equal(toggles, 0);
	assert.equal(t.closed.count, 0);
});

test('with a host title bar: the chat name and status go up there, without a price', async () => {
	const f = fakeHost();
	const bars: Array<[string | undefined, string | undefined]> = [];
	const host = {...f.host, setTitle: (title: string | undefined, detail?: string) => void bars.push([title, detail])};
	const t = setup(undefined, {host});
	await t.settle();
	assert.deepEqual(bars.at(-1), ['New chat', 'idle']);
	assert.doesNotMatch(t.lastFrame(), /idle$/);
	(t.controller as {title?: string}).title = 'Build fix';
	t.controller.emit({type: 'title', title: 'Build fix'});
	t.controller.ui({kind: 'result', ok: true, subtype: 'success', costUsd: 0.5});
	await t.settle();
	assert.equal(bars.at(-1)![0], 'Build fix');
	assert.doesNotMatch(bars.at(-1)![1] ?? '', /\$/);
});

test(':q in the chat quits through the host, or leaves the chat without one; it is never sent', async () => {
	const f = fakeHost();
	let quits = 0;
	const t = setup(undefined, {host: {...f.host, quit: () => void quits++}});
	await t.settle();
	t.press(':q');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.equal(quits, 1);
	assert.deepEqual(t.controller.calls.sent, []);
	const plain = setup();
	await plain.settle();
	plain.press(':q!');
	await plain.settle();
	plain.press(ENTER);
	await plain.settle();
	assert.equal(plain.closed.count, 1);
	assert.deepEqual(plain.controller.calls.sent, []);
});

test('the open checklist shows above the input and goes when everything is done', async () => {
	const t = setup();
	await t.settle();
	t.controller.ui({
		kind: 'tool-use',
		toolUseId: 't1',
		name: 'TodoWrite',
		input: {todos: [{content: 'Plan', status: 'completed'}, {content: 'Code', status: 'in_progress', activeForm: 'Coding'}]},
	});
	await t.settle();
	assert.match(t.lastFrame(), /⎿ {2}.*☒ Plan/);
	assert.match(t.lastFrame(), /^ {5}.*☐ Coding/m);
	t.controller.ui({kind: 'tool-use', toolUseId: 't2', name: 'TodoWrite', input: {todos: [{content: 'Plan', status: 'completed'}, {content: 'Code', status: 'completed'}]}});
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /☒ Plan/);
});

test('Enter while Claude answers queues the message and sends the queue when the turn ends', async () => {
	const t = setup();
	t.controller.setState('running');
	await t.settle();
	for (const text of ['first', 'second']) {
		t.press(text);
		await t.settle();
		t.press(ENTER);
		await t.settle();
	}
	assert.deepEqual(t.controller.calls.sent, []);
	assert.match(t.lastFrame(), /↳ queued: first/);
	assert.match(t.lastFrame(), /↳ queued: second/);
	assert.doesNotMatch(t.lastFrame(), /> second/);
	t.controller.setState('idle');
	t.controller.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['first\n\nsecond']);
	assert.doesNotMatch(t.lastFrame(), /queued/);
});

test('an interrupt puts the queued messages back into the draft', async () => {
	const t = setup();
	t.controller.setState('running');
	await t.settle();
	t.press('later');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	t.controller.setState('idle');
	t.controller.emit({type: 'turn-end', outcome: 'interrupted'});
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, []);
	assert.match(t.lastFrame(), /> later/);
});

test('the queue is capped with the busy hint', async () => {
	const t = setup();
	t.controller.setState('running');
	await t.settle();
	for (let i = 0; i <= MAX_QUEUED; i++) {
		t.press(`m${i}`);
		await t.settle(5);
		t.press(ENTER);
		await t.settle(5);
	}
	await t.settle();
	assert.ok(t.lastFrame().includes(BUSY_HINT));
	assert.match(t.lastFrame(), new RegExp(`> m${MAX_QUEUED}`));
});

test('↑ and ↓ walk through sent messages and bring the draft back', async () => {
	clearSentHistory();
	const t = setup();
	await t.settle();
	for (const text of ['one', 'two']) {
		t.press(text);
		await t.settle();
		t.press(ENTER);
		await t.settle();
		t.controller.setState('idle');
		await t.settle();
	}
	t.press('dra');
	await t.settle();
	t.press(`${ESC}[A`);
	await t.settle();
	assert.match(t.lastFrame(), /> two/);
	t.press(`${ESC}[A`);
	await t.settle();
	assert.match(t.lastFrame(), /> one/);
	t.press(`${ESC}[A`);
	await t.settle();
	assert.match(t.lastFrame(), /> one/);
	t.press(`${ESC}[B`);
	await t.settle();
	t.press(`${ESC}[B`);
	await t.settle();
	assert.match(t.lastFrame(), /> dra/);
	t.press(`${ESC}[1;2A`);
	await t.settle();
	assert.match(t.lastFrame(), /> dra/, 'Shift+↑ scrolls the transcript instead');
});

test('editing keys: Ctrl+W, Ctrl+Y, Ctrl+K and undo with Ctrl+_', async () => {
	const t = setup();
	await t.settle();
	t.press('hello big world');
	await t.settle();
	t.press('\u0017');
	await t.settle();
	assert.match(t.lastFrame(), /> hello big\s*$/m);
	t.press('\u0019');
	await t.settle();
	assert.match(t.lastFrame(), /> hello big world/);
	t.press('\u001f');
	await t.settle();
	assert.match(t.lastFrame(), /> hello big\s*$/m);
});

test('Ctrl+R finds an earlier message; Enter puts it in the input without sending', async () => {
	clearSentHistory();
	const t = setup();
	await t.settle();
	for (const text of ['deploy staging', 'run tests']) {
		t.press(text);
		await t.settle();
		t.press(ENTER);
		await t.settle();
		t.controller.setState('idle');
		await t.settle();
	}
	t.press('\u0012');
	await t.settle();
	t.press('dep');
	await t.settle();
	assert.match(t.lastFrame(), /reverse-i-search\) 'dep': deploy staging/);
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /> deploy staging/);
	assert.equal(t.controller.calls.sent.length, 2);
});

test('@ shows matching project files; Tab completes the mention', async () => {
	const t = setup(undefined, {files: () => ['src/app.tsx', 'src/api.ts', 'README.md']});
	await t.settle();
	t.press('look at @ap');
	await t.settle();
	assert.match(t.lastFrame(), /@src\/app\.tsx/);
	assert.match(t.lastFrame(), /@src\/api\.ts/);
	t.press(`${ESC}[B`);
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.match(t.lastFrame(), /> look at @src\/app\.tsx/, 'the shorter path is listed first, Down picks the second');
	assert.doesNotMatch(t.lastFrame(), /^\s+@src\/api/m);
});

test('Ctrl+G edits the draft in an external editor', async () => {
	const seen: string[] = [];
	const t = setup(undefined, {openEditor: async text => (seen.push(text), `${text} (edited)`)});
	await t.settle();
	t.press('draft');
	await t.settle();
	t.press('\u0007');
	await t.settle(60);
	assert.deepEqual(seen, ['draft']);
	assert.match(t.lastFrame(), /> draft \(edited\)/);
});

test('vim mode: Esc to NORMAL, dw deletes a word, i types again, Enter sends', async () => {
	const t = setup(undefined, {inputMode: () => 'vim'});
	await t.settle();
	t.press('one two');
	await t.settle();
	t.press(ESC);
	await t.settle(60);
	assert.match(t.lastFrame(), /-- NORMAL --/);
	t.press('0');
	await t.settle();
	t.press('d');
	await t.settle();
	t.press('w');
	await t.settle();
	assert.match(t.lastFrame(), /> two/);
	t.press('i');
	await t.settle();
	t.press('x');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /-- NORMAL --/);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['xtwo']);
});

test('Ctrl+O shows the full transcript with scrolling; Esc closes it', async () => {
	const lines = Array.from({length: 60}, (_v, i) => `row ${i}`);
	const t = setup({columns: 80, rows: 24}, {loadTranscript: async () => lines});
	await t.settle();
	t.press('\u000f');
	await t.settle(60);
	assert.match(t.lastFrame(), /row 59/);
	assert.match(t.lastFrame(), /Transcript 60\/60/);
	t.press('g');
	await t.settle();
	assert.match(t.lastFrame(), /row 0\b/);
	assert.doesNotMatch(t.lastFrame(), /row 59/);
	t.press('j');
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /row 0\b/);
	t.press(ESC);
	await t.settle(60);
	assert.doesNotMatch(t.lastFrame(), /Transcript/);
	assert.match(t.lastFrame(), /idle$/);
});

function mouseFakeHost() {
	const f = fakeHost(50);
	const listeners: Array<(e: unknown) => boolean | void> = [];
	const host = {
		...f.host,
		subscribeMouse: (l: (e: unknown) => boolean | void) => {
			listeners.push(l);
			return () => void listeners.splice(listeners.indexOf(l), 1);
		},
	};
	const send = (e: Record<string, unknown>) => {
		const l = listeners.at(-1);
		assert.ok(l, 'no mouse listener');
		return l({button: 'none', shift: false, meta: false, ctrl: false, width: 50, height: 10, ...e});
	};
	const click = (x: number, y: number, height = 10) => send({kind: 'press', button: 'left', x, y, height});
	return {host, listeners, send, click};
}

test('mouse: a click on the input moves the cursor there; malformed events are ignored', async () => {
	const m = mouseFakeHost();
	const t = setup(undefined, {host: m.host});
	await t.settle();
	assert.equal(m.listeners.length, 1);
	t.press('hello world');
	await t.settle();
	// The status bar is the bottom row, above it the rule under the input, then the input.
	assert.equal(m.click(7, 8), false);
	assert.equal(m.click(7, 7), true);
	assert.equal(m.send({kind: 'press', button: 'left', x: 60, y: 7}), false);
	assert.equal(m.send({kind: 'press', button: 'left', x: 2, y: 7, width: 'x'}), false);
	assert.equal(m.click(7, 2), false);
	assert.equal(m.send({kind: 'press', button: 'right', x: 2, y: 7}), false);
	t.press('X');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['helloX world']);
	t.unmount();
	assert.equal(m.listeners.length, 0);
});

test('mouse: in vim NORMAL the input sits above its rule and the mode line, and the cursor stays on a character', async () => {
	const m = mouseFakeHost();
	const t = setup(undefined, {host: m.host, inputMode: () => 'vim'});
	await t.settle();
	t.press('abc');
	await t.settle();
	t.press(ESC);
	await t.settle(60);
	// From the bottom: status bar, mode line, the rule under the input, the input.
	assert.equal(m.click(2, 8), false);
	assert.equal(m.click(2, 7), false);
	assert.equal(m.click(2, 6), true);
	t.press('x');
	await t.settle();
	assert.match(t.lastFrame(), /> bc/);
	assert.equal(m.click(40, 6), true);
	t.press('x');
	await t.settle();
	assert.match(t.lastFrame(), /> b(?!c)/);
});

test('mouse: the wheel is taken only while the transcript viewer is open', async () => {
	const m = mouseFakeHost();
	const lines = Array.from({length: 60}, (_v, i) => `row ${i}`);
	const t = setup({columns: 80, rows: 24}, {host: m.host, loadTranscript: async () => lines});
	await t.settle();
	assert.equal(m.send({kind: 'wheel', wheel: 'up', x: 1, y: 1}), false);
	t.press('\u000f');
	await t.settle(60);
	assert.match(t.lastFrame(), /row 59/);
	assert.equal(m.send({kind: 'wheel', wheel: 'up', x: 1, y: 1}), true);
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /row 59/);
	assert.match(t.lastFrame(), /row 56/);
	assert.equal(m.send({kind: 'wheel', wheel: 'down', x: 1, y: 1}), true);
	await t.settle();
	assert.match(t.lastFrame(), /row 59/);
	assert.equal(m.click(5, 8), false);
	t.press(ESC);
	await t.settle(60);
	assert.equal(m.send({kind: 'wheel', wheel: 'down', x: 1, y: 1}), false);
});

test('mouse: clicks during a permission prompt or while waiting for the answer are not taken', async () => {
	const m = mouseFakeHost();
	const t = setup(undefined, {...armed, host: m.host});
	await t.settle();
	t.press('draft');
	await t.settle();
	t.controller.request(toolReq());
	await t.settle(ARM + 50);
	assert.equal(m.click(3, 8), false);
	t.press('y');
	await t.settle();
	t.press('\x15');
	await t.settle();
	t.controller.setState('running');
	t.controller.emit({type: 'state', state: 'running'});
	await t.settle();
	assert.match(t.lastFrame(), /Working… \(\d+s · esc to interrupt\)/);
	assert.equal(m.click(3, 8), false);
});

test('mouse: a host without subscribeMouse changes nothing', async () => {
	const f = fakeHost();
	const t = setup(undefined, {host: f.host});
	await t.settle();
	t.press('abc');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['abc']);
});

test('thinking status shows the animated Claude Code spinner with seconds and the interrupt hint', async () => {
	const t = setup();
	await t.settle();
	t.controller.ui({kind: 'thinking'});
	await t.settle();
	const first = t.lastFrame().match(/([·✢✳✶✻✽]) Thinking… \(\d+s · esc to interrupt\)/);
	assert.ok(first, 'spinner frame before the status text');
	await t.settle(400);
	const later = t.lastFrame().match(/([·✢✳✶✻✽]) Thinking… \(\d+s · esc to interrupt\)/);
	assert.ok(later);
	assert.notEqual(later[1], first[1]);
});

function limitSetup(clock: {now: () => number; timeZone?: string}) {
	const f = fakeHost();
	const bars: Array<[string | undefined, string | undefined]> = [];
	const host = {...f.host, setTitle: (title: string | undefined, detail?: string) => void bars.push([title, detail])};
	const t = setup(undefined, {host, clock});
	return {...t, bars};
}

test('the limit indicator shows in the status, clears on allowed and on expiry', async () => {
	const nowMs = {value: Date.UTC(2026, 0, 1, 10, 0, 0)};
	const clock = {now: () => nowMs.value, timeZone: 'UTC'};
	const resetsAt = nowMs.value / 1000 + 3600;
	const t = limitSetup(clock);
	await t.settle();
	t.controller.ui({kind: 'rate-limit', info: {status: 'allowed_warning', type: 'five_hour', utilization: 0.85, resetsAt}});
	await t.settle();
	assert.match(t.bars.at(-1)![1] ?? '', /^5h limit 85%, resets 11:00 · idle$/);
	t.controller.ui({kind: 'rate-limit', info: {status: 'allowed'}});
	await t.settle();
	assert.doesNotMatch(t.bars.at(-1)![1] ?? '', /limit/);

	t.controller.ui({kind: 'rate-limit', info: {status: 'allowed_warning', type: 'five_hour', utilization: 0.9, resetsAt}});
	await t.settle();
	assert.match(t.bars.at(-1)![1] ?? '', /5h limit/);
	nowMs.value += 3600_000;
	t.controller.emit({type: 'title', title: 'again'});
	await t.settle();
	assert.doesNotMatch(t.bars.at(-1)![1] ?? '', /limit/);
});

test('the indicator disappears by itself when the reset time passes', async () => {
	const start = Date.now();
	const clock = {now: () => Date.now(), timeZone: 'UTC'};
	const t = limitSetup(clock);
	await t.settle();
	t.controller.ui({kind: 'rate-limit', info: {status: 'allowed_warning', type: 'five_hour', utilization: 0.5, resetsAt: start / 1000 + 1.5}});
	// The reset is 1.5 s away: wide enough to wait for a full render first.
	await t.settle();
	assert.match(t.bars.at(-1)![1] ?? '', /5h limit/);
	await new Promise(r => setTimeout(r, Math.max(0, start + 1700 - Date.now())));
	await t.settle();
	assert.doesNotMatch(t.bars.at(-1)![1] ?? '', /limit/);
});

test('after a limit the queued text goes back to the draft and nothing is sent', async () => {
	const t = setup();
	t.controller.setState('running');
	await t.settle();
	t.press('queued one');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	t.controller.setState('idle');
	t.controller.emit({type: 'turn-end', outcome: 'limit', error: 'You hit your limit'});
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, []);
	assert.match(t.lastFrame(), /> queued one/);
	assert.ok(t.printed.some(p => p.includes('You hit your limit')));
});

test('armExpiry re-arms after a capped wait and stops at the reset time', async () => {
	let now = 0;
	let fired = 0;
	const stop = armExpiry(100, {now: () => now}, () => void fired++, 20);
	cleanup.push(stop);
	await new Promise(r => setTimeout(r, 30));
	assert.equal(fired, 1, 'capped timer fired early');
	now = 100;
	await new Promise(r => setTimeout(r, 30));
	assert.equal(fired, 2, 're-armed timer fired once more');
	await new Promise(r => setTimeout(r, 30));
	assert.equal(fired, 2, 'nothing re-armed after the reset');
});

test('armExpiry cancel stops further firing', async () => {
	let fired = 0;
	const stop = armExpiry(1000, {now: () => 0}, () => void fired++, 10);
	await new Promise(r => setTimeout(r, 25));
	stop();
	const seen = fired;
	await new Promise(r => setTimeout(r, 40));
	assert.equal(fired, seen);
	assert.ok(seen >= 1);
});

const TABLE_TEXT = '| name | description | notes |\n| --- | --- | --- |\n| alpha | a rather long description of alpha | first |\n| beta | another long description for beta | second |';
const plainLen = (s: string) => [...s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')].length;

test('assistant tables are printed within the host width, and the last width is kept while it reads 0', async () => {
	const f = fakeHost(40);
	const t = setup(undefined, {host: f.host});
	await t.settle();
	t.controller.ui({kind: 'text', messageId: 'm1', text: TABLE_TEXT});
	await t.settle();
	assert.equal(t.printed.length, 1);
	for (const line of t.printed[0]!.split('\n')) assert.ok(plainLen(line) <= 39, line);
	f.set({columns: 0});
	await t.settle();
	t.controller.ui({kind: 'text', messageId: 'm2', text: TABLE_TEXT});
	await t.settle();
	assert.equal(t.printed.length, 2);
	for (const line of t.printed[1]!.split('\n')) assert.ok(plainLen(line) <= 39, line);
});

test('blocks are separated by one empty line; a notice line belongs to the block after it', async () => {
	const t = setup();
	await t.settle();
	t.controller.emit({type: 'sent', text: 'hi'});
	t.controller.ui({kind: 'text', messageId: 'm1', text: 'hello'});
	t.controller.emit({type: 'audit', entry: {outcome: 'allowed', toolName: 'Bash', summary: 'ls'}});
	t.controller.ui({kind: 'tool-use', toolUseId: 'b', name: 'Bash', input: {command: 'ls'}});
	t.controller.ui({kind: 'tool-result', toolUseId: 'b', isError: false, text: 'a.txt'});
	t.controller.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	const plain = (s: string) => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
	const shape = t.raw.map(s => (s === ' ' ? 'gap' : plain(s).split('\n')[0]!.slice(0, 12)));
	assert.deepEqual(shape, ['gap', ' > hi ', 'gap', '● hello', 'gap', 'Allowed Bash', '● Bash(ls)']);
});

test('the input sits between two rules, with the mode hint under it', async () => {
	const t = setup({columns: 40, rows: 20});
	await t.settle();
	const rule = '─'.repeat(39);
	assert.match(t.lastFrame(), new RegExp(`${rule}\\n> ?\\n${rule}`));
	t.controller.setMode('plan');
	await t.settle();
	assert.match(t.lastFrame(), /⏸ plan mode on \(shift\+tab to cycle\)/);
});

function commandFakeHost() {
	const f = fakeHost(60);
	const ran: string[] = [];
	const known = [
		{name: 'project', description: 'Projects in the workplace', usage: 'project list'},
		{name: 'settings', description: 'Open the settings'},
		{
			name: 'claude',
			description: 'Claude Code integration',
			subcommands: [
				{name: 'resume', description: 'Resume a chat'},
				{name: 'rename', description: 'Rename the chat'},
				{name: 'compact', description: 'Claude Code: compact the context', aliases: ['c']},
			],
		},
	];
	const host = {...f.host, runLine: (line: string) => known.some(c => line.split(' ')[0] === c.name) && (ran.push(line), true), listCommands: () => known};
	return {host, ran};
}

test('"/command" runs a yena command in the console; other slash lines and "//" go to Claude', async () => {
	const c = commandFakeHost();
	const t = setup(undefined, {host: c.host});
	await t.settle();
	t.press('/project list');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(c.ran, ['project list']);
	assert.deepEqual(t.controller.calls.sent, []);
	assert.match(t.printed.at(-1)!, /\/project list → console/);
	for (const [typed, sent] of [['/compact', '/compact'], ['//project list', '/project list']]) {
		t.press(typed);
		await t.settle();
		assert.doesNotMatch(t.lastFrame(), /Open the settings/, 'no hints for these');
		t.press(ENTER);
		await t.settle();
		assert.equal(t.controller.calls.sent.at(-1), sent);
		t.controller.emit({type: 'turn-end', outcome: 'ok'});
		t.controller.setState('idle');
		t.controller.emit({type: 'state', state: 'idle'});
		await t.settle();
	}
	assert.deepEqual(c.ran, ['project list']);
});

test('typing "/" lists matching commands; Tab or Enter takes the highlighted one, a full name runs', async () => {
	const c = commandFakeHost();
	const t = setup(undefined, {host: c.host});
	await t.settle();
	t.press('/');
	await t.settle();
	assert.match(t.lastFrame(), /\/project +Projects in the workplace/);
	assert.match(t.lastFrame(), /\/settings +Open the settings/);
	t.press('\u001b[B');
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.match(t.lastFrame(), /> \/settings\s*$/m);
	assert.doesNotMatch(t.lastFrame(), /Open the settings/);
	t.press('\u0015');
	await t.settle();
	t.press('/pro');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /> \/project\s*$/m);
	assert.deepEqual(c.ran, []);
	t.press('\u0015');
	await t.settle();
	t.press('/settings');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(c.ran, ['settings']);
});

test('after "/claude " the hints list its subcommands; Tab takes one, Enter after a space runs the line', async () => {
	const c = commandFakeHost();
	const t = setup(undefined, {host: c.host});
	await t.settle();
	t.press('/cla');
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.match(t.lastFrame(), /> \/claude\s*$/m);
	// The list stays and shows what comes next.
	assert.match(t.lastFrame(), /\/claude resume +Resume a chat/);
	assert.match(t.lastFrame(), /\/claude compact +Claude Code: compact the context/);
	t.press('re');
	await t.settle();
	assert.match(t.lastFrame(), /\/claude resume/);
	assert.match(t.lastFrame(), /\/claude rename/);
	assert.doesNotMatch(t.lastFrame(), /\/claude compact/);
	t.press('\u001b[B');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /> \/claude rename\s*$/m);
	assert.deepEqual(c.ran, [], 'Enter on a partial word only completes it');
	// Arguments get no hints; an alias leads to the same level as the name.
	assert.doesNotMatch(t.lastFrame(), /Resume a chat/);
	t.press('\u0015');
	await t.settle();
	t.press('/claude ');
	await t.settle();
	assert.match(t.lastFrame(), /Resume a chat/);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(c.ran, ['claude'], 'Enter right after a space runs what is typed');
});

test('Tab with nothing to complete opens or closes the console; with suggestions it completes; Shift+Tab cycles the mode', async () => {
	const c = commandFakeHost();
	let toggles = 0;
	const host = {...c.host, togglePanel: () => (toggles++, true)};
	const t = setup(undefined, {host});
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.equal(toggles, 1);
	t.press('hello');
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.equal(toggles, 2, 'a draft without suggestions toggles too');
	assert.match(t.lastFrame(), /> hello/, 'the draft stays');
	t.press('\u0015');
	await t.settle();
	t.press('/pro');
	await t.settle();
	t.press('\t');
	await t.settle();
	assert.equal(toggles, 2);
	assert.match(t.lastFrame(), /> \/project\s*$/m);
	t.press('\u001b[Z');
	await t.settle();
	assert.equal(toggles, 2);
});

test('a send refused because another session works keeps the text in the input', async () => {
	const t = setup();
	await t.settle();
	t.controller.send = () => {
		throw new Error('Another session is working right now. Your message stays in the input; send it when that session is done.');
	};
	t.press('hello there');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.match(t.lastFrame(), /> hello there/);
	assert.match(t.printed.join('\n'), /Another session is working right now/);
});

test('initialSend goes out once when the view mounts, shown as the user line', async () => {
	const t = setup(undefined, {initialSend: 'hello from the scheduler'});
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['hello from the scheduler']);
	assert.ok(t.printed.some(l => l.includes('hello from the scheduler')));
	await t.settle();
	assert.equal(t.controller.calls.sent.length, 1);
});

test('an answer with a code block is printed with a copy action on its header row', async () => {
	const prints: {text: string; options?: PrintOptions}[] = [];
	const t = setup(undefined, {print: (text, options) => void prints.push({text, ...(options && {options})})});
	await t.settle();
	t.controller.ui({kind: 'text', messageId: 'm1', text: 'Run:\n\n```sh\nnpm test\n```'});
	await t.settle();
	const answer = prints.find(p => p.text.includes('npm test'))!;
	const action = answer.options!.actions![0]!;
	assert.equal(action.copy, 'npm test');
	assert.match(answer.text.split('\n')[action.line]!, /copy/);
	t.controller.ui({kind: 'text', messageId: 'm2', text: 'plain answer'});
	await t.settle();
	const plain = prints.find(p => p.text.includes('plain answer'))!.options!;
	assert.equal(plain.actions, undefined);
	assert.equal(typeof plain.render, 'function');
});

test('an answer is laid out again at the width the transcript shows', async () => {
	const prints: {text: string; options?: PrintOptions}[] = [];
	const t = setup(undefined, {print: (text, options) => void prints.push({text, ...(options && {options})})});
	await t.settle();
	t.controller.ui({kind: 'text', messageId: 'm1', text: 'word '.repeat(60)});
	await t.settle();
	const answer = prints.find(p => p.text.includes('word'))!;
	const rowsAt = (w: number) => {
		const out = answer.options!.render!(w);
		return (typeof out === 'string' ? out : out.text).split('\n');
	};
	assert.ok(rowsAt(120).length < rowsAt(40).length);
	for (const row of rowsAt(40)) assert.ok(row.length <= 40, row);
});

test('onInbox hands out a sender that sends when idle, queues while answering, and is withdrawn on unmount', async () => {
	let deliver: ((text: string) => void) | undefined;
	const t = setup(undefined, {onInbox: d => (deliver = d)});
	await t.settle();
	deliver!('discuss the task');
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['discuss the task']);
	assert.ok(t.printed.some(l => l.includes('discuss the task')));
	t.controller.setState('running');
	await t.settle();
	deliver!('and one more');
	await t.settle();
	assert.equal(t.controller.calls.sent.length, 1);
	assert.match(t.lastFrame(), /↳ queued: and one more/);
	t.controller.setState('idle');
	t.controller.emit({type: 'turn-end', outcome: 'ok'});
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['discuss the task', 'and one more']);
	t.unmount();
	assert.equal(deliver, undefined);
});

test('a long message being typed wraps over rows: every word stays visible, nothing reaches the last column', async () => {
	const t = setup({columns: 40, rows: 24});
	await t.settle();
	const text = 'please look at the console panel where long error lines push the prompt off the screen';
	t.press(text);
	await t.settle(60);
	const rows = t.lastFrame().replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g'), '').split('\n');
	const input = rows.filter(r => r.startsWith('> ') || r.startsWith('  ')).join(' ');
	for (const w of text.split(' ')) assert.ok(input.split(/\s+/).includes(w), `"${w}" is visible in the input`);
	assert.doesNotMatch(input, /…/);
	assert.ok(rows.every(r => [...r].length <= 39), 'no row reaches the last column');
});
