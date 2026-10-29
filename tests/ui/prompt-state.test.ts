import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Key} from 'ink';
import type {PermissionRequest, ToolRequest} from '../../src/chat/permission.js';
import {
	ARM_MS,
	choicesFor,
	clipBody,
	initQuestionPrompt,
	initToolPrompt,
	layoutPrompt,
	normalizeKey,
	questionPromptKey,
	toolBodyRows,
	toolPromptKey,
	type PromptKey,
	type QuestionPromptState,
	type ToolPromptState,
} from '../../src/ui/prompt-state.js';
import {questionReq, toolReq} from './testkit.js';

const ch = (c: string): PromptKey => ({name: 'char', char: c});
const k = (name: PromptKey['name']): PromptKey => ({name});
const T0 = 1_000;
const OPEN = T0 + ARM_MS;

const fresh = (req: ToolRequest = toolReq()): ToolPromptState => initToolPrompt(req, T0);
const tool = (state: ToolPromptState, key: PromptKey, req: ToolRequest = toolReq(), now = OPEN) =>
	toolPromptKey(state, req, key, now);

test('normalizeKey maps Ink keys and rejects chunks that are not one key', () => {
	const key = (over: Partial<Key>): Key => ({
		upArrow: false,
		downArrow: false,
		leftArrow: false,
		rightArrow: false,
		pageDown: false,
		pageUp: false,
		home: false,
		end: false,
		return: false,
		escape: false,
		ctrl: false,
		shift: false,
		tab: false,
		backspace: false,
		delete: false,
		meta: false,
		super: false,
		hyper: false,
		capsLock: false,
		numLock: false,
		...over,
	});
	assert.deepEqual(normalizeKey('y', key({})), {name: 'char', char: 'y'});
	assert.deepEqual(normalizeKey('', key({tab: true, shift: true})), {name: 'shiftTab'});
	assert.deepEqual(normalizeKey('', key({tab: true})), {name: 'tab'});
	assert.deepEqual(normalizeKey('c', key({ctrl: true})), {name: 'ctrlC'});
	assert.deepEqual(normalizeKey('x', key({ctrl: true})), {name: 'other'});
	assert.deepEqual(normalizeKey('', key({escape: true})), {name: 'esc'});
	assert.deepEqual(normalizeKey('', key({return: true})), {name: 'enter'});
	assert.deepEqual(normalizeKey(' ', key({})), {name: 'space'});
	assert.deepEqual(normalizeKey('yy', key({})), {name: 'other'});
	assert.deepEqual(normalizeKey('y', key({meta: true})), {name: 'other'});
	assert.deepEqual(normalizeKey('😀', key({})), {name: 'char', char: '😀'});
});

test('tool prompt key table', () => {
	const cases: Array<[PromptKey, unknown, boolean?]> = [
		[ch('y'), {kind: 'allow'}],
		[ch('a'), {kind: 'allow', always: true}],
		[ch('n'), {kind: 'deny'}],
		[k('esc'), {kind: 'deny'}],
		[ch('s'), {kind: 'deny', stop: true}, true],
		[k('ctrlC'), {kind: 'deny', stop: true}, true],
	];
	for (const [key, decision, stop] of cases) {
		const r = tool(fresh(), key);
		assert.deepEqual(r.decision, decision, JSON.stringify(key));
		assert.equal(r.stopTurn, stop);
	}
	assert.equal(tool(fresh(), ch('x')).decision, undefined);
	assert.equal(tool(fresh(), k('other')).decision, undefined);
});

test('Enter confirms the highlighted choice and arrows wrap', () => {
	const ids = choicesFor(toolReq()).map(c => c.id);
	assert.deepEqual(ids, ['allow', 'always', 'deny', 'reason', 'stop']);
	let s = fresh();
	assert.deepEqual(tool(s, k('enter')).decision, {kind: 'allow'});
	s = tool(s, k('down')).state;
	assert.deepEqual(tool(s, k('enter')).decision, {kind: 'allow', always: true});
	s = tool(s, k('tab')).state;
	assert.deepEqual(tool(s, k('enter')).decision, {kind: 'deny'});
	s = tool(fresh(), k('up')).state;
	assert.equal(s.selected, 4);
	assert.deepEqual(tool(s, k('enter')).decision, {kind: 'deny', stop: true});
	assert.equal(tool(s, k('enter')).stopTurn, true);
	assert.equal(tool(tool(fresh(), k('down')).state, k('shiftTab')).state.selected, 0);
});

test('defaultToNo, oversize and ineligible requests open on Deny with y and a disabled', () => {
	for (const req of [toolReq({defaultToNo: true}), toolReq({oversize: true}), toolReq({defaultToNo: true, always: false})]) {
		const s = fresh(req);
		assert.equal(choicesFor(req)[s.selected]?.id, 'deny');
		assert.equal(choicesFor(req).some(c => c.id === 'always'), false);
		const y = tool(s, ch('y'), req);
		assert.equal(y.decision, undefined);
		assert.ok(y.notice);
		assert.equal(tool(s, ch('a'), req).decision, undefined);
		assert.deepEqual(tool(s, k('enter'), req).decision, {kind: 'deny'});
		const allow = tool(tool(s, k('up'), req).state, k('enter'), req);
		assert.deepEqual(allow.decision, {kind: 'allow'});
	}
	const noAlways = toolReq({always: false});
	assert.equal(tool(fresh(noAlways), ch('a'), noAlways).decision, undefined);
	assert.deepEqual(tool(fresh(noAlways), ch('y'), noAlways).decision, {kind: 'allow'});
});

test('typeahead guard: ignored at 0 and 399 ms, accepted at 400 ms, Ctrl+C always works', () => {
	const s = fresh();
	for (const now of [T0, T0 + 1, T0 + ARM_MS - 1]) {
		const r = toolPromptKey(s, toolReq(), ch('y'), now);
		assert.equal(r.decision, undefined);
		assert.equal(r.state, s);
	}
	assert.deepEqual(toolPromptKey(s, toolReq(), ch('y'), T0 + ARM_MS).decision, {kind: 'allow'});
	assert.deepEqual(toolPromptKey(s, toolReq(), k('ctrlC'), T0).decision, {kind: 'deny', stop: true});
});

test('transitions between views re-arm', () => {
	const req = toolReq();
	const reason = tool(fresh(), ch('r')).state;
	assert.equal(reason.view, 'reason');
	assert.equal(reason.armedAt, OPEN + ARM_MS);
	assert.equal(toolPromptKey(reason, req, ch('x'), OPEN + ARM_MS - 1).state, reason);
	const back = toolPromptKey(reason, req, k('esc'), OPEN + ARM_MS).state;
	assert.equal(back.view, 'choose');
	assert.equal(back.armedAt, OPEN + 2 * ARM_MS);
	assert.equal(toolPromptKey(back, req, ch('y'), OPEN + 2 * ARM_MS - 1).decision, undefined);
	assert.equal(tool(fresh(), ch('v')).state.armedAt, OPEN + ARM_MS);
});

test('reason mode edits, caps at 500 chars and sends or returns', () => {
	const req = toolReq();
	let s = tool(fresh(), ch('r')).state;
	const at = OPEN + ARM_MS;
	for (const key of [ch('n'), k('space'), ch('o'), ch('x'), k('backspace')]) s = toolPromptKey(s, req, key, at, undefined).state;
	assert.equal(s.reason, 'n o');
	assert.deepEqual(toolPromptKey(s, req, k('enter'), at).decision, {kind: 'deny', reason: 'n o'});
	assert.deepEqual(toolPromptKey({...s, reason: '  '}, req, k('enter'), at).decision, {kind: 'deny'});
	assert.equal(toolPromptKey({...s, reason: 'a'.repeat(500)}, req, ch('b'), at).state.reason.length, 500);
	assert.equal(toolPromptKey(s, req, ch('y'), at).decision, undefined);
	assert.deepEqual(toolPromptKey(s, req, k('ctrlC'), at).decision, {kind: 'deny', stop: true});
});

test('view full scrolls within bounds and returns on Esc, q or v', () => {
	const req = toolReq();
	const at = OPEN + ARM_MS;
	const pager = {max: 30, page: 9};
	let s = tool(fresh(), ch('v')).state;
	assert.equal(s.view, 'full');
	const press = (key: PromptKey) => (s = toolPromptKey(s, req, key, at, pager).state);
	press(k('up'));
	assert.equal(s.scroll, 0);
	press(k('down'));
	assert.equal(s.scroll, 1);
	press(k('pageDown'));
	assert.equal(s.scroll, 10);
	press(k('end'));
	assert.equal(s.scroll, 30);
	press(k('down'));
	assert.equal(s.scroll, 30);
	press(k('pageUp'));
	assert.equal(s.scroll, 21);
	press(k('home'));
	assert.equal(s.scroll, 0);
	assert.equal(toolPromptKey(s, req, ch('y'), at, pager).decision, undefined);
	for (const back of [k('esc'), ch('q'), ch('v')]) {
		assert.equal(toolPromptKey(s, req, back, at, pager).state.view, 'choose');
	}
});

const multiReq = (): PermissionRequest =>
	questionReq({
		questions: [
			{
				question: 'Pick',
				header: 'P',
				multiSelect: true,
				options: [
					{label: 'Red', description: ''},
					{label: 'Blue', description: ''},
					{label: 'Green', description: ''},
				],
			},
			{
				question: 'One',
				header: 'O',
				multiSelect: false,
				options: [
					{label: 'A', description: ''},
					{label: 'B', description: ''},
				],
			},
		],
	});

const q = (state: QuestionPromptState, key: PromptKey, req = questionReq(), now = OPEN) =>
	questionPromptKey(state, req, key, now);

test('question prompt: navigation, number keys, single answer', () => {
	const req = questionReq();
	let s = initQuestionPrompt(req, T0);
	assert.equal(questionPromptKey(s, req, ch('1'), T0 + ARM_MS - 1).decision, undefined);
	s = q(s, k('down')).state;
	assert.equal(s.cursor, 1);
	assert.deepEqual(q(s, k('enter')).decision, {kind: 'answers', answers: {'Which color?': 'Blue'}});
	assert.deepEqual(q(initQuestionPrompt(req, T0), ch('1')).decision, {kind: 'answers', answers: {'Which color?': 'Red'}});
	assert.equal(q(initQuestionPrompt(req, T0), ch('9')).decision, undefined);
	assert.deepEqual(q(initQuestionPrompt(req, T0), ch('n')).decision, {kind: 'deny'});
	assert.deepEqual(q(initQuestionPrompt(req, T0), k('esc')).decision, {kind: 'deny'});
	const stop = q(initQuestionPrompt(req, T0), ch('s'));
	assert.deepEqual(stop.decision, {kind: 'deny', stop: true});
	assert.equal(stop.stopTurn, true);
	assert.equal(q(initQuestionPrompt(req, T0), k('up')).state.cursor, 2);
});

test('question prompt: multi-select needs a selection, joins labels and moves on', () => {
	const req = multiReq() as Extract<PermissionRequest, {kind: 'question'}>;
	let s = initQuestionPrompt(req, T0);
	const none = q(s, k('enter'), req);
	assert.equal(none.decision, undefined);
	assert.ok(none.notice);
	s = q(s, k('space'), req).state;
	s = q(s, ch('3'), req).state;
	s = q(s, ch('1'), req).state;
	s = q(s, ch('1'), req).state;
	assert.deepEqual([...s.picked].sort(), [0, 2]);
	const next = q(s, k('enter'), req);
	assert.equal(next.decision, undefined);
	assert.equal(next.state.index, 1);
	assert.equal(next.state.armedAt, OPEN + ARM_MS);
	assert.deepEqual(q(next.state, ch('2'), req, OPEN + ARM_MS).decision, {
		kind: 'answers',
		answers: {Pick: 'Red, Green', One: 'B'},
	});
});

test('question prompt: Other collects free text, capped and sanitized', () => {
	const req = questionReq();
	let s = q(initQuestionPrompt(req, T0), ch('o')).state;
	assert.equal(s.view, 'other');
	const at = OPEN + ARM_MS;
	const none = questionPromptKey(s, req, k('enter'), at);
	assert.equal(none.decision, undefined);
	assert.ok(none.notice);
	for (const key of [ch('h'), k('space'), ch('i'), ch('x'), k('backspace')]) s = questionPromptKey(s, req, key, at).state;
	assert.equal(s.other, 'h i');
	assert.deepEqual(questionPromptKey(s, req, k('enter'), at).decision, {kind: 'answers', answers: {'Which color?': 'h i'}});
	assert.equal(questionPromptKey({...s, other: 'a'.repeat(500)}, req, ch('b'), at).state.other.length, 500);
	assert.equal(questionPromptKey(s, req, k('esc'), at).state.view, 'choose');
	const viaNumber = q(initQuestionPrompt(req, T0), ch('3')).state;
	assert.equal(viaNumber.view, 'other');
});

test('question prompt: Other in a multi-select joins after the picked labels', () => {
	const req = multiReq() as Extract<PermissionRequest, {kind: 'question'}>;
	let s = q(initQuestionPrompt(req, T0), ch('1'), req).state;
	s = q(s, ch('o'), req).state;
	const at = OPEN + ARM_MS;
	for (const c of 'Pink') s = questionPromptKey(s, req, ch(c), at, 400).state;
	s = questionPromptKey(s, req, k('enter'), at).state;
	assert.equal(s.view, 'choose');
	assert.equal(s.otherPicked, true);
	const done = questionPromptKey(s, req, k('enter'), at + ARM_MS);
	assert.equal(done.decision, undefined);
	assert.equal(done.state.answers['Pick'], 'Red, Pink');
});

test('layoutPrompt budget follows the live-region cap', () => {
	const big = layoutPrompt(24, 80);
	assert.equal(big.budget, 21);
	assert.equal(big.compactChoices, false);
	assert.equal(big.bodyRows, 11);
	assert.equal(big.width, 76);
	const small = layoutPrompt(10, 80);
	assert.equal(small.budget, 8);
	assert.equal(small.compactChoices, true);
	assert.equal(small.showHint, false);
	assert.equal(small.bodyRows, 3);
	assert.equal(small.bodyHidden, false);
	assert.equal(layoutPrompt(8, 80).bodyHidden, true);
	assert.ok(layoutPrompt(2, 5).bodyRows >= 1);
	assert.equal(layoutPrompt(30, 40).pagerRows, 25);
});

test('toolBodyRows reveals, wraps and labels content; clipBody marks cuts', () => {
	const reveal = (s: string) => s.replaceAll('\u001b', '\\x1b');
	const req = toolReq({
		input: {command: `echo \u001b[31m${'z'.repeat(200)}`, timeout: 5000},
		description: 'does things',
		cliNote: {text: 'needs care'},
		highlights: [{level: 'warn', text: 'sudo'}],
		oversize: true,
	});
	const rows = toolBodyRows(req, reveal, 40);
	const text = rows.map(r => r.text).join('\n');
	assert.match(text, /Too large to review/);
	assert.match(text, /Notable: sudo/);
	assert.match(text, /echo \\x1b\[31m/);
	assert.ok(!text.includes('\u001b'));
	assert.match(text, /timeout: 5s/);
	assert.match(text, /Note: needs care/);
	assert.ok(rows.every(r => r.text.length <= 40 + 4));
	assert.match(toolBodyRows(req, reveal, 100).map(r => r.text).join('\n'), /yena's description \(not verified\): does things/);
	assert.equal(rows[0]?.tone, 'warn');

	assert.equal(clipBody(rows, rows.length, false), rows);
	const clipped = clipBody(rows, 3, false);
	assert.equal(clipped.length, 3);
	assert.match(clipped[2]?.text ?? '', /more rows/);
	assert.deepEqual(clipBody(rows, 5, true).map(r => r.text), ['(press v to view)']);
});

test('toolBodyRows shows the resolved target only when it differs, revealed', () => {
	const reveal = (s: string) => s.replaceAll('\u001b', '<ESC>');
	const base = toolReq({toolName: 'Write', path: '/app/sub/link', input: {file_path: 'sub/link', content: 'x'}, always: false});
	const text = (r: ToolRequest, w = 80) => toolBodyRows(r, reveal, w).map(x => x.text).join('\n');
	assert.doesNotMatch(text(base), /resolves to/);
	assert.doesNotMatch(text({...base, resolvedPath: '/app/sub/link'}), /resolves to/);
	const linked = {...base, resolvedPath: '/app/package\u001b[31m.json'};
	assert.match(text(linked), /resolves to: \/app\/package<ESC>\[31m\.json/);
	assert.ok(!text(linked).includes('\u001b'));
});

test('blind mode (nothing reviewable on screen) only refuses', () => {
	const req = toolReq();
	const s = fresh();
	const press = (key: PromptKey) => toolPromptKey(s, req, key, OPEN, undefined, ARM_MS, true);
	for (const key of [ch('y'), ch('a'), ch('r'), ch('v'), k('space'), k('down')]) {
		assert.equal(press(key).decision, undefined, JSON.stringify(key));
		assert.equal(press(key).state.view, 'choose');
	}
	assert.deepEqual(press(k('enter')).decision, {kind: 'deny'});
	assert.deepEqual(press(ch('n')).decision, {kind: 'deny'});
	assert.deepEqual(press(k('esc')).decision, {kind: 'deny'});
	assert.deepEqual(press(ch('s')).decision, {kind: 'deny', stop: true});
	assert.deepEqual(press(k('ctrlC')).stopTurn, true);

	const qreq = questionReq();
	const qs = initQuestionPrompt(qreq, T0);
	const qpress = (key: PromptKey) => questionPromptKey(qs, qreq, key, OPEN, ARM_MS, true);
	for (const key of [ch('1'), ch('o'), k('enter'), k('space')]) assert.equal(qpress(key).decision, undefined);
	assert.deepEqual(qpress(ch('n')).decision, {kind: 'deny'});
	assert.deepEqual(qpress(ch('s')).decision, {kind: 'deny', stop: true});
});
