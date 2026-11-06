import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {UiEvent} from '../../src/deps/chat.js';
import {MAX_PLAN_PENDING, PlanTracker} from '../../src/chat/plan.js';
import {MAX_PLAN_ITEMS, MAX_PLAN_TEXT, PLAN_TOOLS, parseTodos, planChanges, type PlanItem} from '../../src/deps/chat.js';

const use = (toolUseId: string, name: string, input: unknown): UiEvent => ({kind: 'tool-use', toolUseId, name, input});
const result = (toolUseId: string, text: string, isError = false): UiEvent => ({kind: 'tool-result', toolUseId, isError, text});

function call(t: PlanTracker, id: string, name: string, input: unknown, text: string, isError = false): PlanItem[] | undefined {
	assert.equal(t.onUi(use(id, name, input)), undefined);
	return t.onUi(result(id, text, isError));
}

const create = (t: PlanTracker, n: number, subject: string, activeForm?: string) =>
	call(t, `c${n}`, 'TaskCreate', {subject, description: 'd', ...(activeForm !== undefined && {activeForm})}, `Task #${n} created successfully: ${subject}`);

describe('PlanTracker', () => {
	it('knows the five plan tools', () => {
		assert.deepEqual([...PLAN_TOOLS].sort(), ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TodoWrite']);
	});

	it('TodoWrite replaces the list on a successful result only', () => {
		const t = new PlanTracker();
		const todos = [{content: 'A', status: 'in_progress', activeForm: 'Doing A'}, {content: 'B', status: 'pending'}];
		assert.equal(call(t, 'w1', 'TodoWrite', {todos}, 'Todos modified', true), undefined);
		assert.deepEqual(t.items, []);
		assert.deepEqual(call(t, 'w2', 'TodoWrite', {todos}, 'ok'), [
			{content: 'A', status: 'in_progress', activeForm: 'Doing A'},
			{content: 'B', status: 'pending'},
		]);
		assert.equal(call(t, 'w3', 'TodoWrite', {todos}, 'ok'), undefined);
		assert.equal(call(t, 'w4', 'TodoWrite', {}, 'ok'), undefined);
	});

	it('TaskCreate appends a pending item with the id from the result', () => {
		const t = new PlanTracker();
		assert.deepEqual(create(t, 1, 'Write tests', 'Writing tests'), [{id: '1', content: 'Write tests', status: 'pending', activeForm: 'Writing tests'}]);
		assert.deepEqual(create(t, 2, 'Docs')?.map(i => i.id), ['1', '2']);
	});

	it('TaskCreate keeps an item without an id when the result does not parse', () => {
		const t = new PlanTracker();
		const items = call(t, 'c', 'TaskCreate', {subject: 'S'}, 'created');
		assert.deepEqual(items, [{content: 'S', status: 'pending'}]);
		assert.equal(call(t, 'c2', 'TaskCreate', {subject: '  '}, 'Task #9 created successfully'), undefined);
		assert.equal(call(t, 'c3', 'TaskCreate', {subject: 'x'}, 'Task #1 failed', true), undefined);
	});

	it('TaskCreate after an all-done list starts a new list', () => {
		const t = new PlanTracker();
		create(t, 1, 'A');
		call(t, 'u', 'TaskUpdate', {taskId: '1', status: 'completed'}, 'Updated task #1 status');
		assert.deepEqual(create(t, 2, 'B')?.map(i => i.content), ['B']);
	});

	it('TaskUpdate patches status, subject and activeForm; deleted removes', () => {
		const t = new PlanTracker();
		create(t, 1, 'A');
		create(t, 2, 'B');
		assert.deepEqual(call(t, 'u1', 'TaskUpdate', {taskId: '1', status: 'in_progress', subject: 'A2', activeForm: 'Doing A2'}, 'Updated task #1 status, subject')?.[0], {
			id: '1',
			content: 'A2',
			status: 'in_progress',
			activeForm: 'Doing A2',
		});
		assert.deepEqual(call(t, 'u2', 'TaskUpdate', {taskId: '2', status: 'deleted'}, 'Updated task #2 deleted')?.map(i => i.id), ['1']);
	});

	it('TaskUpdate for an unknown id, an error text or an invalid status changes nothing', () => {
		const t = new PlanTracker();
		create(t, 1, 'A');
		assert.equal(call(t, 'u1', 'TaskUpdate', {taskId: '7', status: 'completed'}, 'Updated task #7'), undefined);
		assert.equal(call(t, 'u2', 'TaskUpdate', {taskId: '1', status: 'completed'}, 'Task #1 not found'), undefined);
		assert.equal(call(t, 'u3', 'TaskUpdate', {taskId: '1', status: 'completed'}, 'boom', true), undefined);
		assert.equal(call(t, 'u4', 'TaskUpdate', {taskId: '1', status: 'bogus'}, 'Updated task #1'), undefined);
		assert.equal(t.items[0]!.status, 'pending');
	});

	it('TaskList rebuilds the list, keeps known content and strips the blocked suffix', () => {
		const t = new PlanTracker();
		create(t, 1, 'Known subject', 'Knowing');
		const out = call(
			t,
			'l',
			'TaskList',
			{},
			['#1 [in_progress] other text', '#2 [pending] Second (alice) [blocked by #1]', '#3 [completed] Third', 'noise'].join('\n'),
		);
		assert.deepEqual(out, [
			{id: '1', content: 'Known subject', status: 'in_progress', activeForm: 'Knowing'},
			{id: '2', content: 'Second (alice)', status: 'pending'},
			{id: '3', content: 'Third', status: 'completed'},
		]);
	});

	it('TaskList: No tasks found empties the list; unparsable text changes nothing', () => {
		const t = new PlanTracker();
		create(t, 1, 'A');
		assert.equal(call(t, 'l1', 'TaskList', {}, 'something odd'), undefined);
		assert.deepEqual(call(t, 'l2', 'TaskList', {}, 'No tasks found'), []);
		assert.equal(call(t, 'l3', 'TaskList', {}, 'No tasks found'), undefined);
	});

	it('TaskGet and other tools are ignored', () => {
		const t = new PlanTracker();
		create(t, 1, 'A');
		assert.equal(call(t, 'g', 'TaskGet', {taskId: '1'}, '#1 [completed] A'), undefined);
		assert.equal(t.onUi(use('b', 'Bash', {})), undefined);
		assert.equal(t.onUi(result('b', 'x')), undefined);
		assert.equal(t.onUi({kind: 'text-delta', text: 'x'}), undefined);
	});

	it('caps the list, the pending calls and the id length', () => {
		const t = new PlanTracker();
		for (let i = 1; i <= MAX_PLAN_ITEMS + 5; i++) create(t, i, `t${i}`);
		assert.equal(t.items.length, MAX_PLAN_ITEMS);
		for (let i = 0; i < MAX_PLAN_PENDING + 5; i++) t.onUi(use(`p${i}`, 'TaskGet', {}));
		assert.equal(t.onUi(result('p0', 'x')), undefined);
		const long = call(new PlanTracker(), 'c', 'TaskCreate', {subject: 'S'}, `Task #${'9'.repeat(40)} created successfully`);
		assert.equal(long![0]!.id, undefined);
	});

	it('returns copies and reset clears everything', () => {
		const t = new PlanTracker();
		const out = create(t, 1, 'A')!;
		out[0]!.content = 'changed';
		assert.equal(t.items[0]!.content, 'A');
		t.onUi(use('pending', 'TaskUpdate', {taskId: '1'}));
		t.reset();
		assert.deepEqual(t.items, []);
		assert.equal(t.onUi(result('pending', 'Updated task #1')), undefined);
	});
});

