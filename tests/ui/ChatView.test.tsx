import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React, {createElement} from 'react';
void React;
import {makeScrub} from '../../src/chat/scrub.js';
import type {PermissionRequest} from '../../src/chat/permission.js';
import {makeReveal} from '../../src/chat/reveal.js';
import {BUSY_HINT, ChatView, clearSentHistory, MAX_QUEUED, type ChatViewProps} from '../../src/ui/ChatView.js';
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

function setup(size?: {columns: number; rows: number}, label = 'API key', extra: Partial<ChatViewProps> = {}) {
	const controller: FakeController = fakeController();
	const printed: string[] = [];
	const closed = {count: 0};
	const h = mountHarness(
		createElement(ChatView, {
			controller,
			print: s => printed.push(s),
			close: () => closed.count++,
			scrub,
			credentialLabel: label,
			...extra,
		}),
		size,
	);
	cleanup.push(() => h.unmount());
	return {controller, printed, closed, ...h};
}

test('createChatElement returns a renderable element', async () => {
	const controller = fakeController();
	const h = mountHarness(
		createChatElement({controller, print() {}, close() {}, scrub, credentialLabel: 'API key'}) as never,
	);
	cleanup.push(() => h.unmount());
	await h.settle();
	assert.match(h.lastFrame(), /API key/);
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

test('status bar shows the label and never a secret', async () => {
	const t = setup(undefined, `subscription token ${SECRET}`);
	t.controller.ui({kind: 'session', sessionId: 'abcdef123456', model: `model-${SECRET}`});
	t.controller.ui({kind: 'result', ok: true, subtype: 'success', costUsd: 0.0123});
	await t.settle();
	const frame = t.lastFrame();
	assert.ok(!frame.includes(SECRET));
	assert.match(frame, /\[redacted\] · abcdef12 · idle/);
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
	const t = setup(size, 'API key', armed);
	await t.settle();
	t.controller.request(req);
	await t.settle(ARM + 50);
	return t;
}

test('the modal takes focus: keys never reach the draft and Enter never submits it', async () => {
	const t = setup(undefined, 'API key', armed);
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
		const t = setup(undefined, 'API key', armed);
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
	const t = setup(undefined, 'API key', {reveal, projectDir: '/app'});
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
	const t = setup(undefined, 'API key', armed);
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
		assert.match(bash.lastFrame(), /API key/);

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
		assert.match(edit.lastFrame(), /API key/);
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
	const t = setup(undefined, 'API key', armed);
	await t.settle();
	t.press(SHIFT_TAB);
	await t.settle(ARM + 50);
	assert.match(t.lastFrame().replace(/\s+/g, ' '), /Auto-accept Edit\/Write inside \/app for this chat\? Enter to confirm, any other key cancels\./);
	assert.equal(t.controller.calls.modes.length, 0);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits']);
	assert.match(t.lastFrame(), /mode: accept edits/);
	assert.ok(t.printed.some(p => p.includes('auto-accept edits (this chat only)')));
	t.press(SHIFT_TAB);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan'], 'plan needs no confirmation');
	assert.match(t.lastFrame(), /mode: plan/);
	t.press(SHIFT_TAB);
	await t.settle(ARM + 50);
	assert.match(t.lastFrame().replace(/\s+/g, ' '), /Let a model classifier approve or deny tool calls/);
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan']);
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan', 'auto']);
	assert.match(t.lastFrame(), /mode: auto/);
	assert.ok(t.printed.some(p => p.includes('Mode: auto (a classifier approves')));
	t.press(SHIFT_TAB);
	await t.settle();
	assert.deepEqual(t.controller.calls.modes, ['acceptEdits', 'plan', 'auto', 'default']);
	assert.match(t.lastFrame(), /mode: default/);
});

test('any other key cancels the accept-edits confirmation and Enter before arming does not apply it', async () => {
	const t = setup(undefined, 'API key', {reveal, projectDir: '/app'});
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
	const t = setup(undefined, 'API key', armed);
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
	const t = setup(undefined, 'API key', armed);
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
	assert.match(single.lastFrame(), /Question from Claude \(not a permission request\)/);
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
	const t = setup(undefined, 'API key', {host: f.host});
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
	const t = setup(undefined, 'API key', {host: f.host});
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
	const t = setup({columns: 100, rows: 24}, 'API key', {host: f.host});
	await t.settle();
	t.press('x'.repeat(80));
	await t.settle();
	for (const line of t.lastFrame().split('\n')) assert.ok([...line].length <= 30, line);
});

test('with a host: Esc twice on an idle, empty chat opens the console', async () => {
	const f = fakeHost();
	let toggles = 0;
	const host = {...f.host, togglePanel: () => (toggles++, true)};
	const t = setup(undefined, 'API key', {host});
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	t.press(ESC);
	await t.settle(40);
	assert.equal(toggles, 1);
	t.press('ab');
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	t.press(ESC);
	await t.settle(40);
	assert.equal(toggles, 1, 'the first Esc only clears the draft');
	t.press(ESC);
	await t.settle(40);
	assert.equal(toggles, 2);
	t.controller.setState('running');
	await t.settle();
	t.press(ESC);
	await t.settle(40);
	t.press(ESC);
	await t.settle(40);
	assert.equal(toggles, 2, 'Esc interrupts while running');
	assert.equal(t.closed.count, 0);
});

test('with a host title bar: the chat name and status go up there, without a price', async () => {
	const f = fakeHost();
	const bars: Array<[string | undefined, string | undefined]> = [];
	const host = {...f.host, setTitle: (title: string | undefined, detail?: string) => void bars.push([title, detail])};
	const t = setup(undefined, 'API key', {host});
	await t.settle();
	assert.deepEqual(bars.at(-1), ['New chat', 'API key · idle · mode: default']);
	assert.doesNotMatch(t.lastFrame(), /API key · idle/);
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
	const t = setup(undefined, 'API key', {host: {...f.host, quit: () => void quits++}});
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
	assert.match(t.lastFrame(), /☑ Plan/);
	assert.match(t.lastFrame(), /◐ Coding/);
	t.controller.ui({kind: 'tool-use', toolUseId: 't2', name: 'TodoWrite', input: {todos: [{content: 'Plan', status: 'completed'}, {content: 'Code', status: 'completed'}]}});
	await t.settle();
	assert.doesNotMatch(t.lastFrame(), /☑ Plan/);
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
	const t = setup(undefined, 'API key', {files: () => ['src/app.tsx', 'src/api.ts', 'README.md']});
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
	const t = setup(undefined, 'API key', {openEditor: async text => (seen.push(text), `${text} (edited)`)});
	await t.settle();
	t.press('draft');
	await t.settle();
	t.press('\u0007');
	await t.settle(60);
	assert.deepEqual(seen, ['draft']);
	assert.match(t.lastFrame(), /> draft \(edited\)/);
});

test('vim mode: Esc to NORMAL, dw deletes a word, i types again, Enter sends', async () => {
	const t = setup(undefined, 'API key', {inputMode: () => 'vim'});
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
	const t = setup({columns: 80, rows: 24}, 'API key', {loadTranscript: async () => lines});
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
	assert.match(t.lastFrame(), /API key/);
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
	const t = setup(undefined, 'API key', {host: m.host});
	await t.settle();
	assert.equal(m.listeners.length, 1);
	t.press('hello world');
	await t.settle();
	// The status bar is the bottom row, the input the one above it.
	assert.equal(m.click(7, 8), true);
	assert.equal(m.send({kind: 'press', button: 'left', x: 60, y: 8}), false);
	assert.equal(m.send({kind: 'press', button: 'left', x: 2, y: 8, width: 'x'}), false);
	assert.equal(m.click(7, 2), false);
	assert.equal(m.send({kind: 'press', button: 'right', x: 2, y: 8}), false);
	t.press('X');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['helloX world']);
	t.unmount();
	assert.equal(m.listeners.length, 0);
});

test('mouse: in vim NORMAL the row above the mode line is the input and the cursor stays on a character', async () => {
	const m = mouseFakeHost();
	const t = setup(undefined, 'API key', {host: m.host, inputMode: () => 'vim'});
	await t.settle();
	t.press('abc');
	await t.settle();
	t.press(ESC);
	await t.settle(60);
	assert.equal(m.click(2, 8), false);
	assert.equal(m.click(2, 7), true);
	t.press('x');
	await t.settle();
	assert.match(t.lastFrame(), /> bc/);
	assert.equal(m.click(40, 7), true);
	t.press('x');
	await t.settle();
	assert.match(t.lastFrame(), /> b(?!c)/);
});

test('mouse: the wheel is taken only while the transcript viewer is open', async () => {
	const m = mouseFakeHost();
	const lines = Array.from({length: 60}, (_v, i) => `row ${i}`);
	const t = setup({columns: 80, rows: 24}, 'API key', {host: m.host, loadTranscript: async () => lines});
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
	const t = setup(undefined, 'API key', {...armed, host: m.host});
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
	assert.match(t.lastFrame(), /Waiting for the answer/);
	assert.equal(m.click(3, 8), false);
});

test('mouse: a host without subscribeMouse changes nothing', async () => {
	const f = fakeHost();
	const t = setup(undefined, 'API key', {host: f.host});
	await t.settle();
	t.press('abc');
	await t.settle();
	t.press(ENTER);
	await t.settle();
	assert.deepEqual(t.controller.calls.sent, ['abc']);
});
