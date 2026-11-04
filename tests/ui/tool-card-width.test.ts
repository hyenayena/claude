import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';
import {stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {formatToolCard, formatToolGroup, runningToolRow, type ToolLike} from '../../src/ui/tool-card.js';
import {isFoldable} from '../../src/ui/tool-kind.js';

const ESC = String.fromCharCode(27);
const scrub = makeScrub(s => s);
const wide = `日本語のコマンド\t😀 tab\there ${'語'.repeat(80)}`;

const calls: ToolLike[] = [
	{name: 'Bash', input: {command: wide}, isError: false, text: `${wide}\n${wide}\n`, durationMs: 4000},
	{name: 'Bash', input: {command: `${ESC}]0;t\u0007${wide}`}, isError: true, text: `Exit code 127\n${wide}`, durationMs: 61_000},
	{name: 'Read', input: {file_path: `/${'日本'.repeat(60)}/😀.ts`}, isError: false, text: wide, durationMs: 2000},
	{name: 'mcp__yena__run_command', input: {command: wide}, isError: false, text: wide},
	{name: 'mcp__yena__list_commands', input: {}, isError: false, text: wide},
	{name: `mcp__${wide}__t`, input: {a: wide}, isError: true, text: wide},
	{name: 'Agent', input: {subagent_type: 'coder', description: wide}, isError: false, text: wide, durationMs: 90_000},
];

test('rows stay inside the width at 40 to 200 columns with wide, tabbed and hostile text', () => {
	for (const width of [40, 80, 120, 160, 200]) {
		for (const depth of ['truecolor', '16', 'none'] as ColorDepth[]) {
			withColorDepth(depth, () => {
				const rows = [
					...calls.flatMap(c => formatToolCard(c, scrub, width).split('\n')),
					...formatToolGroup([calls[2]!, calls[2]!], scrub, width).split('\n'),
					...runningToolRow({id: 't', name: 'Bash', input: calls[0]!.input, elapsedSeconds: 3}, scrub, width, '⠋', 0).split('\n'),
				];
				for (const row of rows) {
					assert.ok(styledCells(row) <= width, `${width}/${depth}: ${stripStyles(row)}`);
					assert.ok(!row.includes(`${ESC}]`) && !row.includes('\t'), JSON.stringify(row));
				}
			});
		}
	}
});

test('success and failure differ by shape, not only by colour', () => {
	const ok = withColorDepth('none', () => formatToolCard(calls[2]!, scrub, 80));
	const bad = withColorDepth('none', () => formatToolCard(calls[1]!, scrub, 80));
	assert.ok(stripStyles(ok).startsWith('✓'), ok);
	assert.ok(stripStyles(bad).startsWith('✗'), bad);
});

test('Agent calls and yena console tools never fold', () => {
	for (const name of ['Agent', 'Task', 'mcp__yena__run_command', 'mcp__yena__list_commands', 'Bash', 'Edit']) assert.equal(isFoldable(name), false, name);
});
