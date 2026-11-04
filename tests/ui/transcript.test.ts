import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEvent, UiEvent} from '../../src/chat/events.js';
import type {ToolRequest} from '../../src/chat/permission.js';
import {initialTranscript, reduceTranscript, resetTranscript, type Out, type TranscriptState} from '../../src/ui/transcript.js';

const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});

function run(events: ChatEvent[]): {state: TranscriptState; out: Out[]} {
	let state = initialTranscript();
	const out: Out[] = [];
	for (const e of events) {
		const step = reduceTranscript(state, e);
		state = step.state;
		out.push(...step.out);
	}
	return {state, out};
}

test('deltas accumulate raw and the text event is the single flush', () => {
	const {state, out} = run([
		{type: 'state', state: 'running'},
		ui({kind: 'text-delta', text: 'Hel'}),
		ui({kind: 'text-delta', text: 'lo'}),
	]);
	assert.equal(state.liveRaw, 'Hello');
	assert.equal(state.phase, 'running');
	assert.deepEqual(out, []);

	const done = run([
		ui({kind: 'text-delta', text: 'Hello'}),
		ui({kind: 'text', messageId: 'm1', text: 'Hello'}),
		ui({kind: 'result', ok: true, subtype: 'success', costUsd: 0.5}),
		{type: 'turn-end', outcome: 'ok'},
		{type: 'state', state: 'idle'},
	]);
	assert.deepEqual(
		done.out.map(o => o.kind),
		['assistant', 'blank'],
	);
	assert.equal(done.state.liveRaw, '');
	assert.equal(done.state.costUsd, 0.5);
	assert.equal(done.state.phase, 'idle');
});

test('unfinished text is printed once, marked interrupted', () => {
	const {out, state} = run([
		{type: 'state', state: 'running'},
		ui({kind: 'text-delta', text: 'partial'}),
		{type: 'turn-end', outcome: 'interrupted'},
		{type: 'state', state: 'idle'},
	]);
	const assistants = out.filter(o => o.kind === 'assistant');
	assert.equal(assistants.length, 1);
	assert.deepEqual(assistants[0], {kind: 'assistant', text: 'partial', interrupted: true});
	assert.ok(out.some(o => o.kind === 'outcome' && o.outcome === 'interrupted'));
	assert.equal(state.liveRaw, '');
});

test('aborted text block is marked interrupted', () => {
	const {out} = run([ui({kind: 'text', messageId: 'm', text: 'cut', aborted: true})]);
	assert.deepEqual(out[0], {kind: 'assistant', text: 'cut', interrupted: true});
});

test('tool lifecycle: running, progress, result prints once', () => {
	const events: ChatEvent[] = [
		ui({kind: 'tool-use', toolUseId: 't1', name: 'Bash', input: {command: 'ls'}}),
		ui({kind: 'tool-progress', toolUseId: 't1', name: 'Bash', elapsedSeconds: 4}),
	];
	const mid = run(events);
	assert.equal(mid.state.tools.get('t1')?.elapsedSeconds, 4);
	const end = run([...events, ui({kind: 'tool-result', toolUseId: 't1', isError: false, text: 'a\nb'})]);
	assert.equal(end.state.tools.size, 0);
	assert.deepEqual(end.out, [{kind: 'tool', name: 'Bash', input: {command: 'ls'}, isError: false, text: 'a\nb', durationMs: 4000}]);
});

test('non-ok outcomes print an error; ok prints none', () => {
	for (const outcome of ['error', 'timeout', 'max-turns'] as const) {
		const {out} = run([{type: 'turn-end', outcome, error: 'boom'}]);
		assert.ok(out.some(o => o.kind === 'outcome' && o.outcome === outcome));
	}
	assert.deepEqual(run([{type: 'turn-end', outcome: 'ok'}]).out, []);
});

test('session, status and retry update state', () => {
	const {state} = run([
		ui({kind: 'session', sessionId: 'abcdef123456', model: 'm1'}),
		ui({kind: 'retry', attempt: 2, maxRetries: 5, delayMs: 3000}),
	]);
	assert.equal(state.sessionId, 'abcdef123456');
	assert.equal(state.model, 'm1');
	assert.deepEqual(state.status, {kind: 'retry', attempt: 2, maxRetries: 5, delayMs: 3000});
	assert.equal(run([ui({kind: 'status', status: 'compacting'})]).state.status?.kind, 'compacting');
});

test('raw delta cap keeps the tail', () => {
	const {state} = run([ui({kind: 'text-delta', text: 'x'.repeat(2_500_000)})]);
	assert.equal(state.liveRaw.length, 2_000_000);
});

test('permission events track pending, the per-turn approval counter and the mode', () => {
	const req: ToolRequest = {
		kind: 'tool',
		id: 'r',
		seq: 1,
		toolName: 'Bash',
		input: {command: 'ls'},
		cwd: '/app',
		highlights: [],
		defaultToNo: false,
		always: false,
		oversize: false,
	};
	const a = run([
		{type: 'permission-requested', request: req, pending: 1},
		{type: 'permission-requested', request: {...req, id: 'r2'}, pending: 2},
		{type: 'permission-requested', request: {kind: 'question', id: 'q', seq: 3, questions: []}, pending: 3},
	]);
	assert.equal(a.state.pending, 3);
	assert.equal(a.state.approvals, 2);
	const b = run([
		{type: 'permission-requested', request: req, pending: 1},
		{type: 'permission-resolved', id: 'r', pending: 0},
		{type: 'turn-end', outcome: 'ok'},
	]);
	assert.equal(b.state.pending, 0);
	assert.equal(b.state.approvals, 0);

	const m = run([
		{type: 'mode', mode: 'acceptEdits'},
		{type: 'mode', mode: 'acceptEdits'},
		{type: 'audit', entry: {outcome: 'allowed', toolName: 'Bash', summary: 'ls'}},
	]);
	assert.equal(m.state.mode, 'acceptEdits');
	assert.deepEqual(
		m.out.map(o => o.kind),
		['mode', 'audit'],
	);
	assert.equal(initialTranscript().mode, 'default');
});

test('an api-error is held to turn-end and dropped for limit and context outcomes', () => {
	const held = run([ui({kind: 'api-error', code: 'rate_limit'})]);
	assert.deepEqual(held.out, []);
	for (const outcome of ['error', 'ok'] as const) {
		const r = run([ui({kind: 'api-error', code: 'x'}), {type: 'turn-end', outcome}]);
		assert.equal(r.out.filter(o => o.kind === 'api-error').length, 1, outcome);
		assert.equal(r.state.pendingApiError, undefined);
	}
	for (const outcome of ['limit', 'context'] as const) {
		const r = run([ui({kind: 'api-error', code: 'rate_limit'}), {type: 'turn-end', outcome, error: 'msg'}]);
		assert.deepEqual(r.out.map(o => o.kind), ['outcome', 'blank'], outcome);
		assert.equal(r.state.pendingApiError, undefined);
	}
});

test('an account change drops the held limit error: the notice is all the user sees', () => {
	const r = run([
		ui({kind: 'api-error', code: 'rate_limit'}),
		{type: 'account', account: 'spare', previous: 'work', reason: 'changed'},
		{type: 'turn-end', outcome: 'ok'},
	]);
	assert.deepEqual(r.out.map(o => o.kind), ['account']);
	assert.equal(r.state.account, 'spare');
	assert.equal(resetTranscript(r.state).account, 'spare');
});

test('an account pin sets the shown account', () => {
	const r = run([{type: 'account', account: 'work', previous: 'spare', reason: 'pinned'}]);
	assert.deepEqual(r.out.map(o => o.kind), ['account']);
	assert.equal(r.state.account, 'work');
});

test('the rate-limit report is kept and survives resetTranscript', () => {
	const info = {status: 'allowed_warning' as const, resetsAt: 100, utilization: 0.9};
	const r = run([ui({kind: 'rate-limit', info})]);
	assert.deepEqual(r.state.limit, info);
	assert.deepEqual(resetTranscript(r.state).limit, info);
	assert.equal(resetTranscript(initialTranscript()).limit, undefined);
});

test('the status line follows thinking estimates and tool input until the call arrives', () => {
	const thinking = run([
		{type: 'state', state: 'running'},
		ui({kind: 'thinking'}),
		ui({kind: 'thinking-tokens', tokens: 50}),
		ui({kind: 'thinking'}),
		ui({kind: 'thinking-tokens', tokens: 227}),
	]);
	assert.deepEqual(thinking.state.status, {kind: 'thinking', tokens: 227});
	const input = run([
		{type: 'state', state: 'running'},
		ui({kind: 'tool-input', name: 'Edit'}),
		ui({kind: 'tool-input-delta', chars: 30}),
		ui({kind: 'tool-input-delta', chars: 12}),
	]);
	assert.deepEqual(input.state.status, {kind: 'tool-input', name: 'Edit', chars: 42});
	const called = run([
		{type: 'state', state: 'running'},
		ui({kind: 'tool-input', name: 'Edit'}),
		ui({kind: 'tool-use', toolUseId: 't1', name: 'Edit', input: {}}),
		ui({kind: 'tool-input-delta', chars: 5}),
	]);
	assert.equal(called.state.status, null, 'a stray delta after the call changes nothing');
	assert.deepEqual(run([ui({kind: 'cli-state', state: 'running'})]).out, []);
});

test('a tool result passes its patch on to the printed tool', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]};
	const {out} = run([
		ui({kind: 'tool-use', toolUseId: 't1', name: 'Edit', input: {file_path: '/a'}}),
		ui({kind: 'tool-result', toolUseId: 't1', isError: false, text: 'ok', patch}),
	]);
	assert.deepEqual(out, [{kind: 'tool', name: 'Edit', input: {file_path: '/a'}, isError: false, text: 'ok', patch}]);
});

const use = (toolUseId: string, name: string, input: unknown, at?: number): ChatEvent => ui({kind: 'tool-use', toolUseId, name, input, ...(at !== undefined && {at})});
const result = (toolUseId: string, text = 'ok', extra: {isError?: boolean; durationMs?: number} = {}): ChatEvent =>
	ui({kind: 'tool-result', toolUseId, isError: extra.isError ?? false, text, ...(extra.durationMs !== undefined && {durationMs: extra.durationMs})});
const kinds = (out: Out[]): string[] => out.map(o => (o.kind === 'tool-group' ? `group:${o.items.length}` : o.kind === 'tool' ? `tool:${o.name}` : o.kind));

test('a run of one finished read prints as a single tool; two or more as one group', () => {
	const one = run([use('a', 'Read', {file_path: '/a'}), result('a'), {type: 'turn-end', outcome: 'ok'}]);
	assert.deepEqual(kinds(one.out).slice(0, 1), ['tool:Read']);
	const two = run([use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Grep', {pattern: 'x'}), result('b'), {type: 'turn-end', outcome: 'ok'}]);
	const group = two.out.find(o => o.kind === 'tool-group');
	assert.ok(group && group.kind === 'tool-group' && group.items.length === 2);
	assert.equal(two.out.filter(o => o.kind === 'tool').length, 0);
});

test('finished foldable results wait in state.fold and print nothing', () => {
	const r = run([use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Read', {file_path: '/b'}), result('b')]);
	assert.deepEqual(r.out, []);
	assert.equal(r.state.fold.length, 2);
});

test('any other Out flushes the run first, in order', () => {
	const events: ChatEvent[][] = [
		[ui({kind: 'text', messageId: 'm', text: 'hello'})],
		[ui({kind: 'thinking-text', text: 'hmm'})],
		[use('c', 'Bash', {command: 'ls'}), result('c')],
		[{type: 'audit', entry: {outcome: 'allowed', toolName: 'Bash', summary: 'ls'}}],
	];
	for (const tail of events) {
		const r = run([use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Read', {file_path: '/b'}), result('b'), ...tail]);
		assert.equal(r.out[0]!.kind, 'tool-group', kinds(r.out).join());
		assert.equal(r.state.fold.length, 0);
	}
});

test('an error ends the run and prints on its own; the run before it is flushed', () => {
	const r = run([use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Read', {file_path: '/b'}), result('b'), use('c', 'Read', {file_path: '/c'}), result('c', 'nope', {isError: true})]);
	assert.deepEqual(kinds(r.out), ['group:2', 'tool:Read']);
	assert.equal(r.out[1]!.kind === 'tool' && r.out[1].isError, true);
	assert.equal(r.state.fold.length, 0);
});

test('turn-end, idle and a permission request flush the run', () => {
	const base = [use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Read', {file_path: '/b'}), result('b')];
	const request: ToolRequest = {kind: 'tool', id: 'p1', seq: 1, toolName: 'Bash', input: {command: 'x'}, cwd: '/app', highlights: [], defaultToNo: false, always: false, oversize: false};
	for (const e of [{type: 'turn-end', outcome: 'ok'}, {type: 'state', state: 'idle'}, {type: 'permission-requested', request, pending: 1}] as ChatEvent[]) {
		const r = run([...base, e]);
		assert.equal(r.out.filter(o => o.kind === 'tool-group').length, 1, e.type);
		assert.equal(r.state.fold.length, 0, e.type);
	}
});

test('the run is flushed at 100 items', () => {
	const events: ChatEvent[] = [];
	for (let i = 0; i < 100; i++) events.push(use(`r${i}`, 'Read', {file_path: `/f${i}`}), result(`r${i}`));
	const r = run(events);
	assert.deepEqual(kinds(r.out), ['group:100']);
	assert.equal(r.state.fold.length, 0);
});

test('a tool-use of another tool running in parallel does not flush the run', () => {
	const r = run([use('a', 'Read', {file_path: '/a'}), result('a'), use('b', 'Bash', {command: 'sleep 1'}), use('c', 'Read', {file_path: '/c'}), result('c')]);
	assert.deepEqual(r.out, []);
	assert.equal(r.state.fold.length, 2);
	assert.equal(r.state.tools.size, 1);
});

test('durationMs comes from the event, then from the last progress; startedAt from at', () => {
	const timed = run([use('a', 'Bash', {command: 'x'}, 5000), result('a', 'ok', {durationMs: 1234})]);
	assert.deepEqual(timed.out[0], {kind: 'tool', name: 'Bash', input: {command: 'x'}, isError: false, text: 'ok', durationMs: 1234, startedAt: 5000});
	const progress = run([use('a', 'Bash', {command: 'x'}), ui({kind: 'tool-progress', toolUseId: 'a', name: 'Bash', elapsedSeconds: 7}), result('a')]);
	assert.equal(progress.out[0]!.kind === 'tool' && progress.out[0].durationMs, 7000);
	const none = run([use('a', 'Bash', {command: 'x'}), result('a')]);
	assert.ok(none.out[0]!.kind === 'tool' && !('durationMs' in none.out[0]) && !('startedAt' in none.out[0]));
	assert.equal(run([use('a', 'Bash', {command: 'x'}, 42)]).state.tools.get('a')!.startedAt, 42);
});

test('thinking-text keeps its duration on the printed thought, and none when the engine sent none', () => {
	const timed = run([ui({kind: 'thinking-text', text: 'hmm', durationMs: 3000})]);
	assert.deepEqual(timed.out, [{kind: 'thinking', text: 'hmm', durationMs: 3000}]);
	const plain = run([ui({kind: 'thinking-text', text: 'hmm'})]);
	assert.deepEqual(plain.out, [{kind: 'thinking', text: 'hmm'}]);
});
