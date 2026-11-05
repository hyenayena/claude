import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TurnSummary} from '../../src/chat/turn-stats.js';
import {stringCells, stripStyles, styledCells, withColorDepth} from '../../src/kit.js';
import {formatOut} from '../../src/ui/present.js';
import {formatTokens, showSummary, turnFilesRows, turnSummaryRow} from '../../src/ui/turn-summary.js';

const ESC = String.fromCharCode(27);

const S: TurnSummary = {
	durationMs: 134_000,
	tools: 5,
	files: [
		{path: '/proj/src/a.ts', added: 40, removed: 7},
		{path: '/proj/b.ts', added: 2, removed: 0, created: true},
	],
	filesTotal: 3,
	added: 42,
	removed: 7,
	outputTokens: 18_400,
};

const row = (summary: TurnSummary, outcome: Parameters<typeof turnSummaryRow>[1], width: number, ascii = false): string =>
	stripStyles(withColorDepth('none', () => turnSummaryRow(summary, outcome, width, {ascii})));

test('the full row', () => {
	assert.equal(row(S, 'ok', 120), '✓ 2m 14s · 3 files changed +42 −7 · 5 tools · ↓ 18k tokens · ctrl+o files');
});

test('marks per outcome, ascii', () => {
	assert.match(row(S, 'interrupted', 120), /^✗ interrupted 2m 14s/);
	assert.match(row(S, 'error', 120), /^✗ 2m 14s/);
	assert.match(row(S, 'ok', 120, true), /^v 2m/);
});

test('singular words and no empty parts', () => {
	const one = row({...S, tools: 1, files: [], filesTotal: 1, outputTokens: 0}, 'ok', 120);
	assert.match(one, /1 file changed/);
	assert.match(one, /1 tool\b(?!s)/);
	assert.ok(!one.includes('tokens'));
	assert.equal(row({...S, tools: 0, files: [], filesTotal: 0, added: 0, removed: 0, outputTokens: 0, durationMs: 31_000}, 'ok', 120), '✓ 31s');
});

test('drops from the right and never exceeds the width', () => {
	const seen = new Set<string>();
	for (const depth of ['truecolor', 'none'] as const) {
		for (let w = 1; w <= 120; w++) {
			const styled = withColorDepth(depth, () => turnSummaryRow(S, 'ok', w));
			assert.ok(styledCells(styled) <= w, `${depth} ${w}: ${stripStyles(styled)}`);
			seen.add(stripStyles(styled));
		}
	}
	assert.ok(seen.size > 3);
	assert.match(row(S, 'ok', 50), /^✓ 2m 14s · 3 files changed \+42 −7 · 5 tools$/);
	assert.equal(row(S, 'ok', 20), '✓ 2m 14s');
});

test('colour depth: styled in colour, plain markup only without', () => {
	assert.ok(withColorDepth('256', () => turnSummaryRow(S, 'ok', 120)).includes(ESC));
	assert.ok(!stripStyles(withColorDepth('16', () => turnSummaryRow(S, 'ok', 120))).includes(ESC));
});

test('showSummary: not ok, a tool, or 30 s', () => {
	const quiet = {...S, tools: 0, durationMs: 29_999};
	assert.equal(showSummary(quiet, 'ok'), false);
	assert.equal(showSummary(quiet, 'error'), true);
	assert.equal(showSummary({...quiet, tools: 1}, 'ok'), true);
	assert.equal(showSummary({...quiet, durationMs: 30_000}, 'ok'), true);
});

test('formatTokens', () => {
	assert.deepEqual([0, 999, 1500, 18_400, 2_500_000].map(formatTokens), ['0', '999', '1.5k', '18k', '2.5M']);
});

test('formatOut prints the summary row within the width', () => {
	const out = stripStyles(withColorDepth('none', () => formatOut({kind: 'turn-summary', summary: S, outcome: 'ok'}, s => s, s => s, 50)));
	assert.ok(stringCells(out) <= 49);
	assert.match(out, /^✓ 2m 14s/);
});

test('files section: relative scrubbed paths, middle cut, more row', () => {
	const plain = (summary: TurnSummary, width: number, scrub: (s: string) => string = s => s) =>
		withColorDepth('none', () => turnFilesRows(summary, width, scrub, '/proj')).map(stripStyles);
	const rows = plain(S, 60, s => s.replace('b.ts', 'B.ts'));
	assert.equal(rows[0], 'Changed in the last turn');
	assert.match(rows[1]!, /^✎ src\/a\.ts +\+40 −7$/);
	assert.match(rows[2]!, /^✎ B\.ts +\+2 −0$/);
	assert.equal(rows[3], '… +1 more');
	assert.ok(rows.every(r => stringCells(r) <= 60));
	const long = plain({...S, files: [{path: `/proj/${'d/'.repeat(40)}file.ts`, added: 1, removed: 1}], filesTotal: 1}, 30);
	assert.ok(stringCells(long[1]!) <= 30);
	assert.match(long[1]!, /…/);
	assert.match(long[1]!, /file\.ts/);
	assert.deepEqual(plain({...S, files: []}, 60), []);
});

test('hostile path text does not reach the rows raw', () => {
	const hostile = `/p/a${ESC}]0;x${String.fromCharCode(7)}b.ts`;
	const rows = withColorDepth('none', () => turnFilesRows({...S, files: [{path: hostile, added: 1, removed: 0}], filesTotal: 1}, 60, s => s, '/p'));
	assert.ok(!stripStyles(rows.slice(1).join('\n')).includes(ESC));
	assert.ok(!rows.slice(1).join('\n').includes(String.fromCharCode(7)));
});
