import React from 'react';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stringCells, stripStyles, withColorDepth} from '../../src/kit.js';
import {LiveTools, toolLayout} from '../../src/ui/LiveTools.js';
import type {RunningTool, ToolOut} from '../../src/ui/transcript.js';
import {mountHarness} from './testkit.js';

const id = (s: string): string => s;
const tool = (n: number, extra: Partial<RunningTool> = {}): RunningTool => ({id: `t${n}`, name: 'Bash', input: {command: `sleep ${n}`}, elapsedSeconds: 0, ...extra});
const done = (path: string): ToolOut => ({kind: 'tool', name: 'Read', input: {file_path: path}, isError: false, text: 'x'});

async function frame(element: React.ReactElement, columns = 40): Promise<string[]> {
	const h = mountHarness(element, {columns, rows: 24});
	await h.settle(60);
	const rows = stripStyles(h.lastFrame()).split('\n');
	h.unmount();
	return rows;
}

test('the pending fold is the first row, then the running tools with their elapsed time', async () => {
	const rows = await withColorDepth('16', () =>
		frame(<LiveTools tools={[tool(1, {startedAt: 1000})]} fold={[done('/a.ts'), done('/b.ts')]} scrub={id} maxRows={4} width={39} now={4000} />),
	);
	assert.match(rows[0]!, /^✓ ▤ Read 2 files/);
	assert.match(rows[1]!, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \$ sleep 1 +3\.0s$/);
});

test('every row stays inside columns - 1 and extra tools collapse into a muted row', async () => {
	const tools = [1, 2, 3, 4, 5, 6, 7].map(n => tool(n, {startedAt: 0}));
	const rows = await frame(<LiveTools tools={tools} fold={[done('/a'), done('/b')]} scrub={id} maxRows={5} width={29} now={90_000} />, 30);
	const live = rows.filter(r => r.trim() !== '');
	assert.ok(live.length <= 5, String(live.length));
	for (const r of live) assert.ok(stringCells(r) <= 29, r);
	assert.match(live.at(-1)!, /^\+\d+ more$/);
});

test('nothing renders without tools or a fold', async () => {
	const rows = await frame(<LiveTools tools={[]} fold={[]} scrub={id} maxRows={4} width={39} />);
	assert.equal(rows.join('').trim(), '');
});

test('toolLayout counts the fold row like a tool', () => {
	assert.deepEqual(toolLayout(0, 5), {shown: 0, more: 0, rows: 0});
	assert.equal(toolLayout(3, 5).shown, 3);
	assert.ok(toolLayout(30, 5).rows <= 5);
});
