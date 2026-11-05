import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stringCells, stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {chatStatusRow, contextSegment, contextTone, shortModel, type StatusInput} from '../../src/ui/status-bar.js';

const ESC = String.fromCharCode(27);

const BASE: StatusInput = {
	phase: 'idle',
	status: null,
	awaiting: false,
	elapsedMs: 0,
	quietMs: 0,
	verb: 'Sniffing',
	model: 'claude-opus-4-5-20251101',
	route: 'task: light · chat: strong',
	context: {used: 96_000, limit: 200_000},
	account: 'work',
	limit: '5h 82%',
	tasks: [
		{status: 'running', background: false, taskType: 'local_agent'},
		{status: 'running', background: true, taskType: 'local_agent'},
	],
	project: 'yena',
	branch: 'develop',
	scrub: s => s,
};

const bar = (input: Partial<StatusInput>, width: number, depth: ColorDepth = 'none', ascii = false): string =>
	stripStyles(withColorDepth(depth, () => chatStatusRow({...BASE, ...input}, width, {frame: '✻', depth, ascii})));

test('idle, wide: every segment in the fixed order', () => {
	const row = bar({}, 200);
	const order = ['idle', 'opus-4-5 (task light', 'ctx ▰▰▰▱▱▱ 48%', 'work · 5h 82%', '2 agents', 'yena ⎇ develop'].map(p => row.indexOf(p));
	assert.ok(order.every(i => i >= 0), row);
	assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('running: spinner, verb, elapsed, tokens and the interrupt hint; shorter forms keep the activity', () => {
	const input = {phase: 'running' as const, elapsedMs: 72_000, status: {kind: 'thinking' as const, tokens: 1200}};
	assert.match(bar(input, 200), /^✻ Sniffing… 1m 12s · ↓ 1\.2k · esc to interrupt · opus/);
	assert.match(bar(input, 30), /^✻ 1m 12s/);
	assert.equal(bar({...input, model: undefined, route: undefined, context: undefined, account: undefined, tasks: [], project: undefined}, 14), '✻ 1m 12s');
	assert.match(bar({...input, model: undefined, route: undefined, context: undefined, account: undefined, tasks: [], project: undefined}, 30), /^✻ Sniffing… 1m 12s/);
});

test('awaiting approval, interrupting and quiet', () => {
	assert.match(bar({awaiting: true, phase: 'running'}, 100), /^awaiting approval · /);
	assert.match(bar({phase: 'interrupting'}, 100), /^Interrupting… · /);
	assert.match(bar({phase: 'running', status: {kind: 'thinking', tokens: 0}, quietMs: 65_000}, 200), /no response 1m 05s/);
});

test('context: tones by fraction, percent clamps, tokens only without a limit', () => {
	assert.equal(contextTone(0.59), 'muted');
	assert.equal(contextTone(0.6), 'warn');
	assert.equal(contextTone(0.85), 'error');
	const plain = (c: Parameters<typeof contextSegment>[0]) => stripStyles(contextSegment(c, {frame: '', depth: 'none'})!.forms[0]!);
	assert.equal(plain({used: 300_000, limit: 200_000}), 'ctx ▰▰▰▰▰▰ 100%');
	assert.equal(plain({used: 84_000}), 'ctx 84k');
	assert.equal(contextSegment(undefined, {frame: ''}), undefined);
	assert.deepEqual(contextSegment({used: 1, limit: 2}, {frame: '', depth: 'none'})!.forms.map(stripStyles), ['ctx ▰▰▰▱▱▱ 50%', 'ctx 50%']);
	const hot = withColorDepth('truecolor', () => contextSegment({used: 190_000, limit: 200_000}, {frame: '', depth: 'truecolor'})!.forms[0]!);
	assert.ok(hot.includes(`${ESC}[`) && hot.includes('95%'));
});

test('shortModel drops the prefix and the date, keeps [1m]', () => {
	assert.equal(shortModel('claude-opus-4-5-20251101'), 'opus-4-5');
	assert.equal(shortModel('claude-sonnet-4-5[1m]'), 'sonnet-4-5[1m]');
	assert.equal(shortModel('claude-sonnet-4-5-20250929[1m]'), 'sonnet-4-5[1m]');
});

test('account forms: pin star and the switch arrow', () => {
	assert.match(bar({pin: 'spare', limit: undefined}, 200), /work -> \*spare/);
	assert.match(bar({account: 'spare', pin: 'spare', limit: undefined}, 200), /\*spare/);
	assert.match(bar({account: undefined, pin: 'spare', limit: undefined}, 200), / \*spare/);
});

test('no branch, no agents: those parts are absent', () => {
	const row = bar({branch: undefined, tasks: []}, 200);
	assert.ok(row.endsWith('yena'));
	assert.ok(!row.includes('✦') && !row.includes('⎇'));
});

test('segments drop from the right as the width shrinks, never above the width, at every width and depth', () => {
	const input = {phase: 'running' as const, elapsedMs: 5000, status: {kind: 'thinking' as const, tokens: 10}};

	for (const depth of ['truecolor', '256', '16', 'none'] as ColorDepth[]) {
		for (let w = 1; w <= 200; w++) {
			const styled = withColorDepth(depth, () => chatStatusRow({...BASE, ...input}, w, {frame: '✻', depth}));
			assert.ok(styledCells(styled) <= w, `${depth} ${w}`);
		}
	}
	assert.ok(!bar(input, 60).includes('yena ⎇'));
	assert.ok(bar(input, 25).startsWith('✻'));
});

test('ascii replaces the meter and branch glyphs', () => {
	const row = bar({}, 200, 'none', true);
	assert.match(row, /ctx ###---/);
	assert.match(row, /yena @ develop/);
	assert.ok(!row.includes('⎇') && !row.includes('▰'));
});

test('hostile model, account, branch and project names are scrubbed and cut', () => {
	const evil = `x${ESC}]0;title${String.fromCharCode(7)}${ESC}[31my`;
	const long = 'L'.repeat(300);
	const styled = withColorDepth('none', () =>
		chatStatusRow({...BASE, model: evil, account: evil, branch: long, project: evil, route: evil, limit: evil}, 300, {frame: '✻', depth: 'none'}),
	);
	const plain = stripStyles(styled);
	assert.ok(!plain.includes(ESC) && !plain.includes(String.fromCharCode(7)));
	assert.ok(!plain.includes('L'.repeat(50)));
});
