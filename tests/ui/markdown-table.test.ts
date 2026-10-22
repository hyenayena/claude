import assert from 'node:assert/strict';
import {test} from 'node:test';
import {styledCells} from '../../src/kit.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {renderMarkdown} from '../../src/ui/markdown.js';
import {formatAssistantBlock} from '../../src/ui/present.js';

const ESC = String.fromCharCode(27);
const plain = (s: string) => s.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
const lines = (md: string, width?: number) => plain(renderMarkdown(md, width === undefined ? {} : {width})).split('\n');

test('basic table is drawn as a rounded box with a separator under the header only', () => {
	assert.deepEqual(lines('| a | bb |\n|---|---|\n| 1 | 2 |\n| 333 | 4 |'), [
		'╭─────┬────╮',
		'│ a   │ bb │',
		'├─────┼────┤',
		'│ 1   │ 2  │',
		'│ 333 │ 4  │',
		'╰─────┴────╯',
	]);
});

test('alignment: left, right, center with the odd cell on the right', () => {
	assert.deepEqual(lines('| l | r | c |\n|:--|--:|:-:|\n| x | y | z |\n| aaaa | bbbb | cc |'), [
		'╭──────┬──────┬────╮',
		'│ l    │    r │ c  │',
		'├──────┼──────┼────┤',
		'│ x    │    y │ z  │',
		'│ aaaa │ bbbb │ cc │',
		'╰──────┴──────┴────╯',
	]);
});

test('things that are not tables stay plain', () => {
	for (const md of ['| a | b |\n|---|', '| a | b |\n| 1 | 2 |', 'a | b\nplain', '| a | b |\n|--', '```\n| a |\n|---|\n```']) {
		assert.ok(!plain(renderMarkdown(md)).includes('╭─') || md.startsWith('```'), md);
		assert.ok(!plain(renderMarkdown(md)).includes('┬'), md);
	}
	assert.ok(plain(renderMarkdown('```\n| a |\n|---|\n```')).includes('│ | a |'));
});

test('escaped pipes and pipes in code spans stay in the cell', () => {
	const out = lines('| a | b |\n|---|---|\n| x \\| y | `p|q` |');
	assert.equal(out.length, 5);
	assert.ok(out[3]!.includes('x | y') && out[3]!.includes('p|q'));
});

test('short rows are padded, extra cells dropped, header-only table renders', () => {
	const out = lines('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
	assert.deepEqual(out.slice(3, 5), ['│ 1 │   │', '│ 1 │ 2 │']);
	assert.deepEqual(lines('| a | b |\n|---|---|'), ['╭───┬───╮', '│ a │ b │', '├───┼───┤', '╰───┴───╯']);
});

test('inline styling in cells keeps every line the same width', () => {
	const out = renderMarkdown('| **h** | x |\n|---|---|\n| **bold** `code` | y |');
	assert.ok(out.includes(`${ESC}[1m`) && out.includes(`${ESC}[36mcode`));
	const widths = out.split('\n').map(styledCells);
	assert.equal(new Set(widths).size, 1);
});

test('CJK and emoji cells align by cell width', () => {
	const out = renderMarkdown('| a | b |\n|---|---|\n| 日本語 | 😀 |\n| x | yy |');
	assert.equal(new Set(out.split('\n').map(styledCells)).size, 1);
});

test('narrow width wraps cells, keeps words and the line bound', () => {
	const md = '| name | description |\n|---|---:|\n| ab | one two three four five six seven eight |\n| cd | nine ten eleven twelve |';
	const out = lines(md, 40);
	assert.ok(out.length > 6);
	for (const l of out) assert.ok(styledCells(l) <= 39, l);
	assert.equal(new Set(renderMarkdown(md, {width: 40}).split('\n').map(styledCells)).size, 1);
	const text = out.join(' ');
	for (const w of 'one two three four five six seven eight nine ten eleven twelve ab cd'.split(' ')) assert.ok(text.includes(w), w);
});

test('too narrow for a box falls back to records; default width is 100', () => {
	const md = '| k | v |\n|---|---|\n| a | 1 |\n| b | 2 |';
	const rec = lines(md, 8);
	assert.ok(!rec.join('').includes('╭'));
	assert.ok(rec.includes('k: a') && rec.includes('v: 2'));
	const long = `| h |\n|---|\n| ${'word '.repeat(60)} |`;
	for (const l of lines(long)) assert.ok(styledCells(l) <= 99, l);
});

test('a blank line, heading or quote ends the table', () => {
	const out = renderMarkdown('| a |\n|---|\n| 1 |\n\n**after**');
	assert.ok(out.endsWith(`${ESC}[1mafter${ESC}[22m`));
	const h = lines('| a |\n|---|\n| 1 |\n# Title');
	assert.deepEqual(h.slice(-2), ['╰───╯', 'Title']);
});

test('65 columns is not a table; a large table stays bounded', () => {
	const row = (c: string) => `|${Array.from({length: 65}, () => c).join('|')}|`;
	assert.ok(!renderMarkdown(`${row('a')}\n${row('-')}\n${row('1')}`).includes('╭'));
	const big = ['| a | b |', '|---|---|', ...Array.from({length: 500}, (_, i) => `| ${i} | x |`)].join('\n');
	assert.equal(renderMarkdown(big).split('\n').length, 504);
});

test('escape sequences in cells are scrubbed before rendering', () => {
	const scrub = makeScrub(s => s);
	const out = formatAssistantBlock(`| a |\n|---|\n| x${ESC}]0;evil\u0007y${ESC}[31mz |`, scrub);
	const rest = out.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
	assert.ok(!rest.includes(ESC));
	assert.ok(!out.includes(`${ESC}[31m`));
});

test('every width keeps lines within the budget, boxes uniform, records included', () => {
	const md = '| name | note `some long code span here` |\n|---|---|\n| alpha | **bold** [link](http://x.y/zzzzzzzzzz) text |\n| 日本語日本語 | 😀 smile |';
	for (const w of [5, 8, 12, 20, 30, 40, 100]) {
		const out = renderMarkdown(md, {width: w}).split('\n');
		for (const l of out) assert.ok(styledCells(l) <= w - 1, `${w}: ${plain(l)}`);
		if (out[0]!.includes('╭')) assert.equal(new Set(out.map(styledCells)).size, 1, String(w));
	}
});

test('ASCII records stay within a one-cell budget and never throw', () => {
	const md = '| k | v |\n|---|---|\n| abc | defgh |';
	for (const w of [0, 1, 2, 3]) {
		const out = lines(md, w);
		assert.ok(out.length > 0);
		for (const l of out) assert.ok(styledCells(l) <= Math.max(1, w - 1), `${w}: ${l}`);
	}
	assert.doesNotThrow(() => renderMarkdown(md, {width: NaN}));
});

test('interrupted partial tables stay plain text', () => {
	assert.equal(plain(renderMarkdown('| a | b |', {width: 10})), '| a | b |');
	assert.equal(plain(renderMarkdown('| a | b |\n|---|', {width: 10})), '| a | b |\n|---|');
	assert.ok(lines('| a | b |\n|---|---|\n| 1', 10).includes('╰───┴───╯'));
});

test('a link in a header cell does not leak bold into later cells', () => {
	const out = renderMarkdown('| [x](http://a.b) | y |\n|---|---|\n| 1 | 2 |');
	assert.equal(new Set(out.split('\n').map(styledCells)).size, 1);
});
