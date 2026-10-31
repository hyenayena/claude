import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AgentItem, ChatEvent, UiEvent} from '../../src/chat/events.js';
import {AGENTS_CAPS, focusAgent, initialAgents, reduceAgents, SEED_NOTICE, seedFromTasks, type AgentsState} from '../../src/ui/agents.js';

const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});
const spawn = (id: string, input: Record<string, unknown> = {}): ChatEvent => ui({kind: 'tool-use', toolUseId: id, name: 'Agent', input});
const msg = (agentId: string, items: AgentItem[], model?: string): ChatEvent =>
	ui({kind: 'agent-message', agentId, items, ...(model !== undefined && {model})});
const run = (events: ChatEvent[], from: AgentsState = initialAgents()): AgentsState => events.reduce(reduceAgents, from);

test('a main Agent or Task call creates a box with its name, prompt, model and background flag', () => {
	const s = run([
		{type: 'state', state: 'running'},
		spawn('a1', {subagent_type: 'Explore', description: 'Look', prompt: 'Find it', model: 'haiku'}),
		ui({kind: 'tool-use', toolUseId: 'a2', name: 'Task', input: {subagent_type: 'Explore', run_in_background: true}}),
		spawn('a3', {name: 'helper'}),
		spawn('a4'),
		ui({kind: 'tool-use', toolUseId: 'r', name: 'Read', input: {}}),
	]);
	assert.deepEqual(s.order, ['a1', 'a2', 'a3', 'a4']);
	const a1 = s.boxes.get('a1')!;
	assert.equal(a1.name, 'Explore');
	assert.equal(a1.description, 'Look');
	assert.equal(a1.prompt, 'Find it');
	assert.equal(a1.model, 'haiku');
	assert.equal(a1.background, false);
	assert.equal(a1.status, 'running');
	assert.equal(s.boxes.get('a2')!.name, 'Explore 2');
	assert.equal(s.boxes.get('a2')!.background, true);
	assert.equal(s.boxes.get('a3')!.name, 'helper');
	assert.equal(s.boxes.get('a4')!.name, 'agent');
	assert.equal(s.turn, 1);
});

test('subagent messages fill the history; results complete the pending tool; the first model wins', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]};
	const s = run([
		spawn('a1', {model: 'sonnet'}),
		msg('a1', [{type: 'thinking', text: 'hm'}, {type: 'text', text: 'Reading'}, {type: 'tool-use', toolUseId: 't1', name: 'Edit', input: {file_path: '/x'}}], 'claude-haiku-4-5'),
		msg('a1', [{type: 'tool-result', toolUseId: 't1', isError: false, text: 'ok', patch}]),
		msg('a1', [{type: 'text', text: '  '}], 'claude-opus-4-1'),
	]);
	const b = s.boxes.get('a1')!;
	assert.equal(b.model, 'claude-haiku-4-5');
	assert.deepEqual(b.history, [
		{kind: 'thinking', text: 'hm'},
		{kind: 'text', text: 'Reading'},
		{kind: 'tool', toolUseId: 't1', name: 'Edit', input: {file_path: '/x'}, done: true, isError: false, text: 'ok', patch},
	]);
	assert.equal(b.pending.size, 0);
});

test('a message for an unknown agent creates a placeholder box', () => {
	const s = run([msg('ghost', [{type: 'text', text: 'hi'}])]);
	assert.equal(s.boxes.get('ghost')!.name, 'agent');
	assert.equal(s.boxes.get('ghost')!.history.length, 1);
});

test('nested agents: the message chain gives the parent; parentTaskId overrides it', () => {
	let s = run([
		spawn('root', {subagent_type: 'planner'}),
		ui({kind: 'task', id: 'T1', status: 'running', toolUseId: 'root', taskType: 'local_agent'}),
		msg('root', [{type: 'tool-use', toolUseId: 'kid', name: 'Agent', input: {subagent_type: 'coder'}}]),
		spawn('other'),
		ui({kind: 'task', id: 'T9', status: 'running', toolUseId: 'other'}),
	]);
	assert.equal(s.boxes.get('kid')!.parent, 'root');
	assert.equal(s.boxes.get('kid')!.depth, 1);
	s = reduceAgents(s, ui({kind: 'task', id: 'T2', status: 'running', toolUseId: 'kid', parentTaskId: 'T9', subagentType: 'coder', prompt: 'do it'}));
	const kid = s.boxes.get('kid')!;
	assert.equal(kid.parent, 'other');
	assert.equal(kid.taskId, 'T2');
	assert.equal(kid.subagentType, 'coder');
	assert.equal(kid.prompt, 'do it');
	s = reduceAgents(s, msg('kid', [{type: 'tool-use', toolUseId: 'k2', name: 'Task', input: {}}]));
	s = reduceAgents(s, msg('k2', [{type: 'tool-use', toolUseId: 'k3', name: 'Task', input: {}}]));
	s = reduceAgents(s, msg('k3', [{type: 'tool-use', toolUseId: 'k4', name: 'Task', input: {}}]));
	s = reduceAgents(s, msg('k4', [{type: 'tool-use', toolUseId: 'k5', name: 'Task', input: {}}]));
	assert.equal(s.boxes.get('k5')!.depth, AGENTS_CAPS.depth);
});

test('a nested result finishes the nested foreground box', () => {
	const s = run([
		spawn('root'),
		msg('root', [{type: 'tool-use', toolUseId: 'kid', name: 'Agent', input: {}}]),
		msg('root', [{type: 'tool-result', toolUseId: 'kid', isError: true, text: 'broke'}]),
	]);
	assert.equal(s.boxes.get('kid')!.status, 'failed');
	assert.equal(s.boxes.get('kid')!.report, 'broke');
	assert.equal(s.boxes.get('root')!.status, 'running');
});

test('foreground boxes finish on the main result; background boxes only on the task notification', () => {
	let s = run([
		{type: 'state', state: 'running'},
		spawn('fg'),
		spawn('bg', {run_in_background: true}),
		ui({kind: 'task', id: 'B', status: 'running', toolUseId: 'bg'}),
		ui({kind: 'tool-result', toolUseId: 'fg', isError: false, text: 'the report'}),
		ui({kind: 'tool-result', toolUseId: 'bg', isError: false, text: 'launched'}),
	]);
	assert.equal(s.boxes.get('fg')!.status, 'completed');
	assert.equal(s.boxes.get('fg')!.report, 'the report');
	assert.equal(s.boxes.get('bg')!.status, 'running');
	s = reduceAgents(s, ui({kind: 'task', id: 'B', status: 'completed', summary: 'all done'}));
	assert.equal(s.boxes.get('bg')!.status, 'completed');
	assert.equal(s.boxes.get('bg')!.report, 'all done');
	const failed = run([spawn('x'), ui({kind: 'tool-result', toolUseId: 'x', isError: true, text: 'no'})]);
	assert.equal(failed.boxes.get('x')!.status, 'failed');
});

test('a task moved to the background is no longer finished by its launch result', () => {
	const s = run([
		spawn('a'),
		ui({kind: 'task', id: 'A', status: 'running', toolUseId: 'a'}),
		ui({kind: 'task', id: 'A', status: 'running', background: true}),
		ui({kind: 'tool-result', toolUseId: 'a', isError: false, text: 'moved'}),
	]);
	assert.equal(s.boxes.get('a')!.background, true);
	assert.equal(s.boxes.get('a')!.status, 'running');
});

test('lifecycle: sent clears finished foreground boxes; background ones stay until the end of the next turn', () => {
	let s = run([
		{type: 'state', state: 'running'},
		spawn('fg'),
		spawn('bg', {run_in_background: true}),
		ui({kind: 'task', id: 'B', status: 'running', toolUseId: 'bg'}),
		ui({kind: 'tool-result', toolUseId: 'fg', isError: false, text: 'r'}),
		ui({kind: 'task', id: 'B', status: 'completed'}),
		{type: 'turn-end', outcome: 'ok'},
	]);
	assert.deepEqual(s.order, ['fg', 'bg'], 'finished boxes stay until the next message');
	s = reduceAgents(s, {type: 'sent', text: 'next'});
	assert.deepEqual(s.order, ['bg']);
	s = run([{type: 'state', state: 'running'}, {type: 'state', state: 'running'}], s);
	assert.equal(s.turn, 2, 'a repeated running state is one turn');
	s = reduceAgents(s, {type: 'turn-end', outcome: 'ok'});
	assert.deepEqual(s.order, []);
});

test('an interrupted turn stops running foreground boxes; background boxes keep running', () => {
	const s = run([
		{type: 'state', state: 'running'},
		spawn('fg'),
		spawn('bg', {run_in_background: true}),
		{type: 'turn-end', outcome: 'interrupted'},
	]);
	assert.equal(s.boxes.get('fg')!.status, 'stopped');
	assert.equal(s.boxes.get('bg')!.status, 'running');
	for (const outcome of ['error', 'timeout'] as const) {
		assert.equal(run([spawn('x'), {type: 'turn-end', outcome}]).boxes.get('x')!.status, 'stopped');
	}
	assert.equal(run([spawn('x'), {type: 'turn-end', outcome: 'ok'}]).boxes.get('x')!.status, 'running');
});

test('selection and open state are cleared when their box goes away', () => {
	let s = run([spawn('a'), ui({kind: 'tool-result', toolUseId: 'a', isError: false, text: ''})]);
	s = focusAgent(s, {selected: 'a', open: 'a'});
	assert.equal(s.open, 'a');
	assert.equal(focusAgent(s, {selected: 'zzz'}).selected, undefined);
	s = reduceAgents(s, {type: 'sent', text: 'x'});
	assert.equal(s.selected, undefined);
	assert.equal(s.open, undefined);
});

test('caps: at most 32 boxes, the oldest finished one is evicted, nothing is added when all run', () => {
	let s = initialAgents();
	for (let i = 0; i < AGENTS_CAPS.boxes; i++) s = reduceAgents(s, spawn(`a${i}`));
	s = reduceAgents(s, spawn('extra'));
	assert.equal(s.boxes.size, AGENTS_CAPS.boxes);
	assert.ok(!s.boxes.has('extra'));
	s = reduceAgents(s, msg('ghost', [{type: 'text', text: 'x'}]));
	assert.ok(!s.boxes.has('ghost'));
	s = reduceAgents(s, ui({kind: 'tool-result', toolUseId: 'a3', isError: false, text: ''}));
	s = reduceAgents(s, ui({kind: 'tool-result', toolUseId: 'a5', isError: false, text: ''}));
	s = reduceAgents(s, spawn('extra'));
	assert.ok(s.boxes.has('extra'));
	assert.ok(!s.boxes.has('a3'));
	assert.ok(s.boxes.has('a5'));
	assert.equal(s.order.at(-1), 'extra');
});

test('caps: history entries and bytes drop the oldest entries; the prompt is kept', () => {
	let s = run([spawn('a', {prompt: 'P'})]);
	for (let i = 0; i < AGENTS_CAPS.entries + 10; i++) s = reduceAgents(s, msg('a', [{type: 'text', text: `m${i}`}]));
	let b = s.boxes.get('a')!;
	assert.equal(b.history.length, AGENTS_CAPS.entries);
	assert.equal(b.dropped, 10);
	assert.equal(b.prompt, 'P');
	assert.deepEqual(b.history[0], {kind: 'text', text: 'm10'});
	s = run([spawn('b')]);
	for (let i = 0; i < 12; i++) s = reduceAgents(s, msg('b', [{type: 'text', text: 'x'.repeat(100_000)}]));
	b = s.boxes.get('b')!;
	assert.ok(b.bytes <= AGENTS_CAPS.bytes);
	assert.equal(b.history.length + b.dropped, 12);
	for (const e of b.history) assert.equal((e as {text: string}).text.length, AGENTS_CAPS.entryText);
	s = run([spawn('c')]);
	s = reduceAgents(s, msg('c', Array.from({length: 64}, (_, i) => ({type: 'tool-use' as const, toolUseId: `t${i}`, name: 'Read', input: {}}))));
	s = reduceAgents(s, msg('c', [{type: 'tool-use', toolUseId: 'last', name: 'Read', input: {}}]));
	assert.equal(s.boxes.get('c')!.pending.size, AGENTS_CAPS.pending);
	assert.ok(!s.boxes.get('c')!.pending.has('t0'));
	const long = run([spawn('d'), ui({kind: 'tool-result', toolUseId: 'd', isError: false, text: 'r'.repeat(100_000)})]);
	assert.equal(long.boxes.get('d')!.report!.length, AGENTS_CAPS.report);
});

test('caps: tool inputs count toward the bytes and a huge input is capped', () => {
	let s = run([spawn('a')]);
	for (let i = 0; i < 400; i++) s = reduceAgents(s, msg('a', [{type: 'tool-use', toolUseId: `t${i}`, name: 'Write', input: {file_path: `/f${i}`, content: 'x'.repeat(60_000)}}]));
	let b = s.boxes.get('a')!;
	assert.ok(b.bytes > 0);
	assert.ok(b.bytes <= AGENTS_CAPS.bytes, `${b.bytes}`);
	assert.ok(b.history.length < 10, `${b.history.length}`);
	assert.equal(b.history.length + b.dropped, 400);
	const total = b.history.reduce((n, e) => n + JSON.stringify(e.kind === 'tool' ? e.input : '').length, 0);
	assert.equal(b.bytes, total);
	s = reduceAgents(s, msg('a', [{type: 'tool-use', toolUseId: 'big', name: 'Write', input: {file_path: '/big', content: 'y'.repeat(1_000_000)}}]));
	b = s.boxes.get('a')!;
	const big = b.history.at(-1)!;
	assert.ok(big.kind === 'tool');
	const input = big.input as {file_path: string; content: string};
	assert.equal(input.file_path, '/big');
	assert.ok(JSON.stringify(input).length <= AGENTS_CAPS.entryText + 64);
	assert.ok(JSON.stringify(b.pending.get('big')!.input).length <= AGENTS_CAPS.entryText + 64);
	assert.ok(b.bytes <= AGENTS_CAPS.bytes);
});

test('caps: results filled into earlier calls evict the oldest entries too', () => {
	let s = run([spawn('a')]);
	const ids = Array.from({length: 20}, (_, i) => `t${i}`);
	s = reduceAgents(s, msg('a', ids.map(id => ({type: 'tool-use' as const, toolUseId: id, name: 'Read', input: {}}))));
	for (const id of ids) s = reduceAgents(s, msg('a', [{type: 'tool-result', toolUseId: id, isError: false, text: 'r'.repeat(60_000)}]));
	const b = s.boxes.get('a')!;
	assert.ok(b.bytes <= AGENTS_CAPS.bytes, `${b.bytes}`);
	assert.ok(b.dropped > 0);
	assert.equal(b.history.length + b.dropped, 20);
	assert.equal(b.bytes, b.history.reduce((n, e) => n + (e.kind === 'tool' ? (e.text?.length ?? 0) + JSON.stringify(e.input).length : e.text.length), 0));
});

test('seedFromTasks adds running agent tasks that have no box yet, with a notice', () => {
	const s0 = run([spawn('known')]);
	const s = seedFromTasks(s0, [
		{id: 'T1', status: 'running', background: true, taskType: 'local_agent', toolUseId: 'tu1', subagentType: 'Explore', description: 'Look'},
		{id: 'T2', status: 'running', background: false, taskType: 'local_agent', toolUseId: 'known'},
		{id: 'T3', status: 'completed', background: false, taskType: 'local_agent', toolUseId: 'tu3'},
		{id: 'T4', status: 'running', background: false, taskType: 'local_bash', toolUseId: 'tu4'},
		{id: 'T5', status: 'running', background: false, taskType: 'local_agent'},
	]);
	assert.deepEqual(s.order, ['known', 'tu1']);
	const b = s.boxes.get('tu1')!;
	assert.equal(b.name, 'Explore');
	assert.equal(b.taskId, 'T1');
	assert.equal(b.background, true);
	assert.deepEqual(b.history, [{kind: 'notice', text: SEED_NOTICE}]);
	assert.equal(seedFromTasks(s, [{id: 'T1', status: 'running', background: true, taskType: 'local_agent', toolUseId: 'tu1'}]), s);
});
