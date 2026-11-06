import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {PlanItem} from '../../src/deps/chat.js';
import {styledCells, stripStyles, withColorDepth} from '../../src/kit.js';
import {formatOut, formatToolBlock, toolHeader} from '../../src/ui/present.js';
import {PLAN, planDone, planViewerRows, planVisible, planWidgetRows, type PlanView} from '../../src/ui/plan-widget.js';

const id = (s: string) => s;
const ESC = String.fromCharCode(27);

const items: PlanItem[] = [
	{id: '1', content: 'Read the code', status: 'completed'},
	{id: '2', content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests'},
	{id: '3', content: 'Update the docs', status: 'pending'},
	{id: '4', content: 'Ship', status: 'pending'},
];
const view = (patch: Partial<PlanView> = {}): PlanView => ({items, running: true, stale: false, expanded: false, ...patch});
const look = (patch: Partial<Parameters<typeof planWidgetRows>[1]> = {}) => ({columns: 80, rows: 30, scrub: id, spinner: '⠹', now: 0, ...patch});
const rows = (v: PlanView, l = look()): string[] => withColorDepth('none', () => planWidgetRows(v, l).map(stripStyles));

test('visibility: no plan, stale, and a finished plan once idle are hidden', () => {
	assert.equal(planVisible(view()), true);
	assert.equal(planVisible(view({items: []})), false);
	assert.equal(planVisible(view({stale: true})), false);
	const done = items.map(i => ({...i, status: 'completed' as const}));
	assert.equal(planDone(done), true);
	assert.equal(planVisible(view({items: done, running: true})), true);
	assert.equal(planVisible(view({items: done, running: false})), false);
	assert.equal(planVisible(view({running: false})), true, 'an open plan stays while idle');
});

test('summary at 24 rows or more: header, active form with the spinner, next item', () => {
	assert.deepEqual(rows(view()), ['☰ Plan 1/4 ▰▱▱▱', '  ⠹ Writing tests', '  ○ Update the docs']);
	assert.deepEqual(rows(view({running: false})), ['☰ Plan 1/4 ▰▱▱▱', '  › Writing tests', '  ○ Update the docs']);
});

test('below 24 rows it collapses to one row; below 10 rows or 30 columns it is hidden', () => {
	assert.equal(rows(view(), look({rows: 23})).length, 1);
	assert.match(rows(view(), look({rows: 23, columns: 100}))[0]!, /^☰ Plan 1\/4 ▰▱▱▱ · ⠹ Writing tests · next: Update the docs$/);
	assert.deepEqual(rows(view(), look({rows: PLAN.minRows - 1})), []);
	assert.deepEqual(rows(view(), look({columns: PLAN.minColumns - 1})), []);
	assert.equal(rows(view(), look({rows: PLAN.minRows, columns: PLAN.minColumns})).length, 1);
});

test('expanded lists every item within min(10, 30% of rows) and counts the rest', () => {
	const many: PlanItem[] = Array.from({length: 25}, (_, i) => ({id: String(i), content: `Step ${i}`, status: i < 10 ? 'completed' : i === 10 ? 'in_progress' : 'pending'}));
	const out = rows(view({items: many, expanded: true}));
	assert.equal(out.length, 9);
	assert.ok(out.some(r => r.includes('Step 10')));
	assert.match(out.at(-1)!, /… \+\d+ more/);
	assert.equal(rows(view({expanded: true})).length, 5, 'a short list shows whole');
	assert.equal(rows(view({items: many, expanded: true}), look({rows: 40})).length, 10);
});

test('the flash shows ok text on the header row until it expires', () => {
	const flash = {text: 'Read the code', until: 1000};
	assert.match(rows(view({flash}), look({now: 999}))[0]!, /✓ Read the code$/);
	assert.doesNotMatch(rows(view({flash}), look({now: 1000}))[0]!, /Read the code/);
	const done = items.map(i => ({...i, status: 'completed' as const}));
	assert.match(rows(view({items: done}))[0]!, /Plan 4\/4 ▰▰▰▰ +✓ done$/);
});

test('every row fits columns - 1, wide text included, in colour', () => {
	const wide: PlanItem[] = [
		{id: '1', content: '漢字'.repeat(60), status: 'completed'},
		{id: '2', content: 'x', status: 'in_progress', activeForm: '界'.repeat(120)},
		{id: '3', content: 'y'.repeat(300), status: 'pending'},
	];
	withColorDepth('16', () => {
		for (const columns of [30, 40, 80, 200]) {
			for (const r of [10, 20, 24, 50]) {
				for (const expanded of [false, true]) {
					for (const row of planWidgetRows(view({items: wide, expanded, flash: {text: '漢字'.repeat(40), until: 1}}), look({columns, rows: r, now: 0}))) {
						assert.ok(styledCells(row) <= columns - 1, `${columns}x${r}: ${styledCells(row)}`);
					}
				}
			}
		}
	});
});

test('item text is scrubbed and colour depth is honoured', () => {
	const hostile: PlanItem[] = [{content: `a${ESC}[31mred`, status: 'in_progress'}];
	const out = withColorDepth('none', () => planWidgetRows(view({items: hostile}), look({scrub: s => s.split(ESC).join('?')})));
	assert.ok(out.join('').includes('a?[31mred'));
	assert.ok(!/38;|\[9[0-9]m/.test(out.join('')));
	assert.ok(withColorDepth('16', () => planWidgetRows(view(), look())).join('').includes(`${ESC}[`));
});

test('the viewer lists every item at the width', () => {
	const out = withColorDepth('none', () => planViewerRows(items, 60, id).map(stripStyles));
	assert.deepEqual(out, ['☰ Plan 1/4 ▰▱▱▱', '  ✓ Read the code', '  › Writing tests', '  ○ Update the docs', '  ○ Ship']);
	assert.deepEqual(planViewerRows([], 60, id), []);
});

test('transcript notes read as one block per change', () => {
	const text = withColorDepth('none', () =>
		stripStyles(
			formatOut(
				{
					kind: 'plan-note',
					notes: [
						{kind: 'new', steps: 7},
						{kind: 'added', steps: 1},
						{kind: 'done', text: 'Write tests'},
						{kind: 'more-done', count: 2},
						{kind: 'finished', done: 7, total: 7},
					],
				},
				id,
			),
		),
	);
	assert.equal(text, ['☰ Plan · 7 steps', '☰ Plan +1 step', '✓ Write tests', '✓ +2 more done', '✓ Plan done · 7/7'].join('\n'));
});

test('plan tool rows: one-liners and the TodoWrite summary', () => {
	assert.equal(toolHeader('TaskCreate', {subject: 'Write tests', description: 'd'}, id), 'TaskCreate(Write tests)');
	assert.equal(toolHeader('TaskUpdate', {taskId: '3', status: 'completed'}, id), 'TaskUpdate(Task #3 → completed)');
	assert.equal(toolHeader('TaskUpdate', {taskId: '3', subject: 'New'}, id), 'TaskUpdate(Task #3: New)');
	const todos = [{content: 'a', status: 'completed'}, {content: 'b', status: 'pending'}];
	assert.equal(toolHeader('TodoWrite', {todos}, id), 'TodoWrite(2 items)');
	const block = stripStyles(formatToolBlock({name: 'TodoWrite', input: {todos}, isError: false, text: 'Todos have been modified'}, id));
	assert.match(block, /TodoWrite 2 items +· 1\/2 done/);
});
