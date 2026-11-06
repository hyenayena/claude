import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AgentItem, ChatEvent, UiEvent} from '../../src/deps/chat.js';
import {AGENT_STALE_GRACE_MS, initialAgents, reconcileAgents, reduceAgents, RESUMED_NOTICE, type AgentsState} from '../../src/ui/agents.js';

const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});
const spawn = (id: string, input: Record<string, unknown> = {}): ChatEvent => ui({kind: 'tool-use', toolUseId: id, name: 'Agent', input});
const send = (id: string, to: string): ChatEvent => ui({kind: 'tool-use', toolUseId: id, name: 'SendMessage', input: {to, message: 'go on'}});
const msg = (agentId: string, items: AgentItem[], taskId?: string): ChatEvent =>
	ui({kind: 'agent-message', agentId, items, ...(taskId !== undefined && {taskId})});
const say = (text: string): AgentItem => ({type: 'text', text});
const handback = (message: string): AgentItem => ({type: 'tool-use', toolUseId: `h-${message}`, name: 'SubagentHandback', input: {message}});
const task = (e: Partial<Extract<UiEvent, {kind: 'task'}>> & {id: string}): ChatEvent => ui({kind: 'task', status: 'running', ...e});
const result = (id: string, text = 'ok'): ChatEvent => ui({kind: 'tool-result', toolUseId: id, isError: false, text});
const run = (events: ChatEvent[], from: AgentsState = initialAgents()): AgentsState => events.reduce((s, e) => reduceAgents(s, e), from);
const T0 = 1_000_000;
const runAt = (events: ChatEvent[], now: number, from: AgentsState = initialAgents()): AgentsState => events.reduce((s, e) => reduceAgents(s, e, now), from);

const finishedArchitect = (): AgentsState =>
	run([
		{type: 'state', state: 'running'},
		spawn('a1', {name: 'architect', subagent_type: 'Plan'}),
		task({id: 'T1', toolUseId: 'a1'}),
		msg('a1', [say('thinking')], 'T1'),
		result('a1', 'report'),
	]);

test('SendMessage to a finished agent reopens its box; the resumed messages land in it, no placeholder appears', () => {
	let s = finishedArchitect();
	assert.equal(s.boxes.get('a1')!.status, 'completed');
	s = run([send('s1', 'architect'), msg('s1', [say('more')], 'T1')], s);
	assert.deepEqual(s.order, ['a1']);
	const b = s.boxes.get('a1')!;
	assert.equal(b.status, 'running');
	assert.equal(b.finishedTurn, undefined);
	assert.equal(b.report, undefined);
	assert.equal(b.background, true);
	assert.deepEqual(b.history.map(e => (e.kind === 'text' || e.kind === 'notice' ? e.text : '')), ['thinking', RESUMED_NOTICE, 'more']);
});

test('a resumed agent finishes on its task notification with the SendMessage id or without any id', () => {
	for (const toolUseId of ['s1', undefined]) {
		let s = run([send('s1', 'architect'), msg('s1', [say('more')], 'T1')], finishedArchitect());
		s = run([task({id: 'T1', status: 'completed', summary: 'done', ...(toolUseId !== undefined && {toolUseId})})], s);
		const b = s.boxes.get('a1')!;
		assert.equal(b.status, 'completed');
		assert.equal(b.report, 'done');
		assert.equal(s.order.length, 1);
	}
});

test('a finished agent that gets only a new parent id and its task id is reopened, then done on its hand-back', () => {
	let s = finishedArchitect();
	s = run([msg('s9', [say('fixing')], 'T1')], s);
	let b = s.boxes.get('a1')!;
	assert.equal(b.status, 'running');
	assert.ok(b.aliases?.includes('s9'));
	assert.equal(s.order.length, 1);
	s = run([msg('s9', [handback('all fixed')], 'T1')], s);
	b = s.boxes.get('a1')!;
	assert.equal(b.status, 'completed');
	assert.equal(b.report, 'all fixed');
});

test('a late message on a known id does not reopen a finished box', () => {
	let s = finishedArchitect();
	s = run([msg('a1', [say('late')], 'T1')], s);
	assert.equal(s.boxes.get('a1')!.status, 'completed');
	s = run([send('s1', 'architect'), result('s1', 'Resuming agent architect'), msg('s1', [handback('x')], 'T1'), msg('s1', [say('late')], 'T1')], s);
	assert.equal(s.boxes.get('a1')!.status, 'completed');
	assert.equal(s.boxes.get('a1')!.report, 'x');
});

test('a task event with a new tool_use id resolves by task id and reopens a finished box', () => {
	let s = finishedArchitect();
	s = run([task({id: 'T1', toolUseId: 's5'})], s);
	const b = s.boxes.get('a1')!;
	assert.equal(b.status, 'running');
	assert.ok(b.aliases?.includes('s5'));
	assert.equal(s.order.length, 1);
});

test('a background agent stays running after its launch result and finishes on the task notification', () => {
	let s = run([spawn('b1', {name: 'coder', run_in_background: true}), task({id: 'TB', toolUseId: 'b1', background: true}), result('b1', 'Async agent launched')]);
	assert.equal(s.boxes.get('b1')!.status, 'running');
	s = run([task({id: 'TB', status: 'completed', summary: 'built'})], s);
	assert.equal(s.boxes.get('b1')!.status, 'completed');
	assert.equal(s.boxes.get('b1')!.report, 'built');
});

test('a background agent finishes on its SubagentHandback alone', () => {
	let s = run([spawn('b1', {run_in_background: true}), result('b1', 'Async agent launched'), msg('b1', [say('work')])]);
	assert.equal(s.boxes.get('b1')!.status, 'running');
	s = run([msg('b1', [handback('report')])], s);
	assert.equal(s.boxes.get('b1')!.status, 'completed');
	assert.equal(s.boxes.get('b1')!.report, 'report');
});

test('a rate-limited agent stopped by an error turn-end is resumed by task id and completes', () => {
	let s = run([{type: 'state', state: 'running'}, spawn('a1', {name: 'doc'}), task({id: 'T1', toolUseId: 'a1'}), msg('a1', [say('x')], 'T1')]);
	s = run([{type: 'turn-end', outcome: 'error'}], s);
	assert.equal(s.boxes.get('a1')!.status, 'stopped');
	s = run([{type: 'state', state: 'running'}, send('s1', 'T1'), msg('s1', [say('again')], 'T1')], s);
	assert.equal(s.boxes.get('a1')!.status, 'running');
	s = run([task({id: 'T1', status: 'completed', toolUseId: 's1'})], s);
	assert.equal(s.boxes.get('a1')!.status, 'completed');
});

test('a placeholder is removed when idle with no running task; a finished one goes on the next user message', () => {
	let s = runAt([msg('ghost', [say('hm')], 'TX')], T0);
	assert.equal(s.boxes.get('ghost')!.placeholder, true);
	const r = reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS);
	assert.equal(r.state.boxes.size, 0);
	s = run([task({id: 'TX', status: 'completed'})], s);
	assert.equal(s.boxes.get('ghost')!.status, 'completed');
	s = run([{type: 'sent', text: 'next'}], s);
	assert.equal(s.boxes.size, 0);
});

test('a stale named box is stopped; a reopened box without new messages gets its earlier status back', () => {
	const named = runAt([spawn('a1', {name: 'coder'})], T0);
	const stopped = reconcileAgents(named, [], T0 + AGENT_STALE_GRACE_MS).state.boxes.get('a1')!;
	assert.equal(stopped.status, 'stopped');
	assert.notEqual(stopped.finishedTurn, undefined);

	let s = run([{type: 'state', state: 'idle'}], finishedArchitect());
	const before = s.boxes.get('a1')!;
	s = runAt([send('s1', 'architect')], T0, s);
	assert.equal(s.boxes.get('a1')!.status, 'running');
	const back = reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS).state.boxes.get('a1')!;
	assert.equal(back.status, 'completed');
	assert.equal(back.finishedTurn, before.finishedTurn);
	assert.equal(back.report, before.report);

	s = runAt([msg('s1', [say('new')], 'T1')], T0, s);
	assert.equal(reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS).state.boxes.get('a1')!.status, 'stopped');
});

test('the grace period keeps a fresh box, reports the recheck time, and a running task or a running turn keeps it', () => {
	const s = runAt([spawn('a1', {name: 'coder'})], T0);
	const early = reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS - 1);
	assert.equal(early.state.boxes.get('a1')!.status, 'running');
	assert.equal(early.recheckAt, T0 + AGENT_STALE_GRACE_MS);
	assert.equal(reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS).state.boxes.get('a1')!.status, 'stopped');
	assert.equal(reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS).recheckAt, undefined);

	const withTask = reconcileAgents(s, [{id: 'T1', status: 'running', background: false, toolUseId: 'a1'}], T0 + 5 * AGENT_STALE_GRACE_MS);
	assert.equal(withTask.state.boxes.get('a1')!.status, 'running');
	const byTaskId = run([task({id: 'T1', toolUseId: 'a1'})], s);
	assert.equal(reconcileAgents(byTaskId, [{id: 'T1', status: 'running', background: false}], T0 + 5 * AGENT_STALE_GRACE_MS).state.boxes.get('a1')!.status, 'running');

	const busy = run([{type: 'state', state: 'running'}], s);
	assert.equal(reconcileAgents(busy, [], T0 + 5 * AGENT_STALE_GRACE_MS).state.boxes.get('a1')!.status, 'running');
});

test('SendMessage to an unknown, empty, broadcast or oversized target creates and changes nothing', () => {
	const before = finishedArchitect();
	for (const to of ['nobody', '', '*', 'x'.repeat(5000), '__proto__']) {
		const s = run([send('s1', to)], before);
		assert.deepEqual(s.order, ['a1']);
		assert.equal(s.boxes.get('a1')!.status, 'completed');
	}
	const odd = run([ui({kind: 'tool-use', toolUseId: 's2', name: 'SendMessage', input: {to: 42}}), ui({kind: 'tool-use', toolUseId: 's3', name: 'SendMessage', input: null})], before);
	assert.equal(odd.boxes.get('a1')!.status, 'completed');
});

test('the alias list of a box is capped and the recheck time is the earliest expiry', () => {
	let s = finishedArchitect();
	for (let i = 0; i < 40; i++) s = run([send(`s${i}`, 'architect')], s);
	assert.ok(s.boxes.get('a1')!.aliases!.length <= 16);

	const a = runAt([spawn('b1', {name: 'one'})], T0);
	const both = runAt([spawn('b2', {name: 'two'})], T0 + 3000, a);
	const r = reconcileAgents(both, [], T0 + 4000);
	assert.equal(r.recheckAt, T0 + AGENT_STALE_GRACE_MS);
	assert.equal(r.state.order.length, 2);
});

test('a box the safety net stopped during a long silent step runs again on its next message, then finishes on its hand-back', () => {
	let s = runAt([send('s1', 'architect'), msg('s1', [say('running a long check')], 'T1')], T0, finishedArchitect());
	s = runAt([{type: 'state', state: 'idle'}], T0, s);
	s = reconcileAgents(s, [], T0 + AGENT_STALE_GRACE_MS + 1).state;
	assert.equal(s.boxes.get('a1')!.status, 'stopped');
	s = runAt([msg('s1', [say('check passed')], 'T1')], T0 + 60_000, s);
	let b = s.boxes.get('a1')!;
	assert.equal(b.status, 'running');
	assert.equal(b.staleStopped, undefined);
	assert.equal(b.finishedTurn, undefined);
	s = runAt([msg('s1', [handback('done')], 'T1')], T0 + 61_000, s);
	b = s.boxes.get('a1')!;
	assert.equal(b.status, 'completed');
	assert.equal(b.report, 'done');
	assert.equal(s.order.length, 1);
});
