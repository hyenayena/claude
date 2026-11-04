import '../helpers/sgr16.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';
import {stripStyles, styledCells, withColorDepth, type ColorDepth} from '../../src/kit.js';
import {CODE_BLOCK_ROWS, renderMarkdown, renderMarkdownRows} from '../../src/ui/markdown.js';
import {formatAssistantBlock} from '../../src/ui/present.js';

const ESC = String.fromCharCode(27);
const scrub = makeScrub(s => s);
const plainRows = (md: string, width = 60, depth: ColorDepth = 'none'): string[] => withColorDepth(depth, () => renderMarkdownRows(md, {width}).rows.map(stripStyles));

const DOC = [
	'# Title',
	'## Sub',
	'### Third',
	'Some **bold**, *italic*, ~~strike~~ and `code` with a [link](https://x.dev/path) and https://bare.example/x.',
	'',
	'- one',
	'  - two that is long enough to need a wrapped second row under the marker',
	'    - three',
	'1. first',
	'2. second',
	'- [x] done',
	'- [ ] todo',
	'> quoted text that is long enough to wrap inside the quote rule, twice over probably yes',
	'> > nested',
	'---',
	'```typescript',
	'const x = "a very long string literal that must wrap in the frame"; // trailing',
	'```',
	'| a | b |',
	'|---|--:|',
	'| 1 | 日本語 |',
].join('\n');

test('every element is drawn and keeps its text', () => {
	const rows = plainRows(DOC, 40);
	assert.deepEqual(rows.slice(0, 3), ['Title', 'Sub', 'Third']);
	assert.ok(rows.includes('• one'));
	assert.ok(rows.includes('  ◦ two that is long enough to need a'));
	assert.ok(rows.some(r => r.startsWith('    ▪ three')));
	assert.ok(rows.includes('1. first') && rows.includes('2. second'));
	assert.ok(rows.includes('☑ done') && rows.includes('☐ todo'));
	assert.ok(rows.some(r => r.startsWith('│ quoted')));
	assert.ok(rows.some(r => r.startsWith('│ │ nested')));
	assert.ok(rows.includes('─'.repeat(40)));
	assert.ok(rows.some(r => r.startsWith('╭─ typescript ')));
	assert.ok(rows.some(r => r.startsWith('│↪')));
	assert.ok(rows.some(r => r.startsWith('╰──')));
	assert.ok(rows.some(r => r.startsWith('╭─') && r.includes('┬')));
});

test('list items wrap under their text, not under the marker', () => {
	const rows = plainRows('- alpha beta gamma delta epsilon zeta eta theta', 20);
	assert.deepEqual(rows, ['• alpha beta gamma', '  delta epsilon zeta', '  eta theta']);
	const numbered = plainRows('9. one\n10. two words that wrap around', 16);
	assert.equal(numbered[0], ' 9. one');
	assert.equal(numbered[1], '10. two words');
	assert.equal(numbered[2], '    that wrap');
});

test('inline styling: link text and muted url, code tint, bold, italic', () => {
	const row = (depth: ColorDepth, md: string): string => withColorDepth(depth, () => renderMarkdownRows(md, {width: 80}).rows[0]!);
	const t = row('truecolor', 'a `c` **b** *i* [l](http://u.v/w)');
	assert.ok(t.includes(`${ESC}[38;2;209;154;102mc`));
	assert.ok(t.includes(`${ESC}[1mb`) && t.includes(`${ESC}[3mi`));
	assert.ok(t.includes(`${ESC}[4;38;2;86;182;194ml`));
	assert.ok(t.includes(`${ESC}[38;2;139;139;139m (http://u.v/w)`));
	assert.equal(stripStyles(t), 'a c b i l (http://u.v/w)');
	assert.equal(stripStyles(row('none', 'a `c` [l](http://u.v/w)')), 'a `c` l (http://u.v/w)');
	assert.equal(stripStyles(row('none', '[http://u.v](http://u.v)')), 'http://u.v');
	assert.ok(row('none', '**b**').includes(`${ESC}[1m`));
	assert.ok(row('16', '`c`').includes(`${ESC}[33mc`));
});

test('headings use the heading tone for levels 1-2 and plain bold below', () => {
	const rows = (md: string): string => withColorDepth('truecolor', () => renderMarkdownRows(md, {width: 40}).rows[0]!);
	assert.ok(rows('# h').startsWith(`${ESC}[1;38;2;97;175;239mh`));
	assert.ok(rows('### h').startsWith(`${ESC}[1mh`));
	assert.ok(rows('## a **b** c').includes(`${ESC}[1;38;2;97;175;239m`));
});

test('a quote keeps its rule on every wrapped row, muted and italic', () => {
	const rows = plainRows('> one two three four five six seven', 14).map(r => r.trimEnd());
	assert.deepEqual(rows, ['│ one two', '│ three four', '│ five six', '│ seven']);
	const styled = withColorDepth('16', () => renderMarkdownRows('> q', {width: 20}).rows[0]!);
	assert.ok(styled.includes(`${ESC}[2m${ESC}[3m`));
	assert.deepEqual(plainRows('>', 10), ['│']);
});

test('fenced code is framed and markup inside it is left alone', () => {
	const rows = plainRows('```ts\nconst x = "**hi**"; // note\n```\nafter', 40);
	assert.deepEqual(rows, ['╭─ ts ' + '─'.repeat(33) + '╮', '│ const x = "**hi**"; // note', '╰' + '─'.repeat(38) + '╯', 'after']);
	assert.deepEqual(plainRows('```\nopen', 20), ['╭' + '─'.repeat(18) + '╮', '│ open']);
});

test('code blocks report their top border row and the whole code', () => {
	const md = 'Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n```\n```\n\n~~~sh\necho hi';
	const r = renderMarkdownRows(md, {width: 40});
	assert.deepEqual(r.codeBlocks, [
		{row: 2, code: 'const a = 1;\nconst b = 2;'},
		{row: 10, code: 'echo hi'},
	]);
	const rows = r.rows.map(stripStyles);
	assert.ok(rows[2]!.startsWith('╭─ ts ') && !rows[2]!.includes('copy'));
	assert.equal(renderMarkdown(md, {width: 40}), r.rows.join('\n'));
	const labelled = renderMarkdownRows(md, {width: 40, copyLabel: true}).rows.map(stripStyles);
	assert.ok(labelled[2]!.endsWith(' copy ─╮') && labelled[2]!.startsWith('╭─ ts '));
	assert.ok(!labelled[7]!.includes('copy'));
	assert.ok(labelled[10]!.includes(' sh ') && labelled[10]!.endsWith(' copy ─╮'));
});

test('a long code block shows 120 rows and a footer; full shows everything', () => {
	const md = ['```', ...Array.from({length: 150}, (_, i) => `l${i}`), '```'].join('\n');
	const rows = plainRows(md, 30);
	assert.equal(rows.length, 1 + CODE_BLOCK_ROWS + 1);
	assert.ok(rows.at(-1)!.startsWith('╰─ ⋯ +30 lines '));
	const full = renderMarkdownRows(md, {width: 30, full: true}).rows;
	assert.equal(full.length, 152);
	assert.equal(renderMarkdownRows(md, {width: 30}).codeBlocks[0]!.code.split('\n').length, 150);
});

test('an open fence has no bottom border and drops the empty partial line', () => {
	assert.deepEqual(plainRows('```ts\nfoo\n', 20).slice(1), ['│ foo']);
	assert.deepEqual(plainRows('```ts\nfoo\nba', 20).slice(1), ['│ foo', '│ ba']);
});

test('rows never exceed the width at 10..200 and at every depth', () => {
	const hostile = `${DOC}\n${'日本語'.repeat(30)}\n- ${'x'.repeat(200)}\n> ${'y'.repeat(200)}\n\`\`\`\n${'z'.repeat(300)}\n\`\`\``;
	for (const depth of ['none', '16', '256', 'truecolor'] as const) {
		for (let w = 10; w <= 200; w += 7) {
			for (const row of withColorDepth(depth, () => renderMarkdownRows(hostile, {width: w, copyLabel: true}).rows)) {
				assert.ok(styledCells(row) <= w, `${depth} ${w}: ${stripStyles(row)}`);
			}
		}
	}
	for (const w of [1, 2, 3, 4, 5]) for (const row of plainRows(hostile, w)) assert.ok(styledCells(row) <= w, `${w}: ${row}`);
});

test('hostile escapes, OSC 8 and C1 never reach the rows, before or after the scrub', () => {
	const evil = `x ${ESC}]8;;http://evil${String.fromCharCode(7)}click${ESC}]8;;${String.fromCharCode(7)} ${String.fromCharCode(0x9b)}31m \`${ESC}[31mred\` [l${ESC}[2J](u${ESC}x)`;
	for (const out of [renderMarkdown(evil), formatAssistantBlock(evil, scrub)]) {
		const rest = out.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
		assert.ok(!rest.includes(ESC), 'escape');
		assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(rest.replace(/\n/g, '')), 'control');
		assert.ok(!out.includes(`${ESC}]`), 'osc');
	}
});

test('the depth none form keeps attributes and drops colour', () => {
	const out = withColorDepth('none', () => renderMarkdown('# H\n**b** `c` [l](http://u.v)\n> q'));
	assert.ok(!/\x1b\[(3[0-7]|9[0-7]|38|48)/.test(out));
	assert.ok(out.includes(`${ESC}[1m`) && out.includes(`${ESC}[4m`));
});

test('table row cap and a code line wider than the frame', () => {
	const rows = plainRows(['| a |', '|---|', ...Array.from({length: 300}, (_, i) => `| ${i} |`)].join('\n'), 20);
	assert.equal(rows.length, 3 + 200 + 1 + 1);
	assert.equal(rows.at(-1), '⋯ +100 rows');
});
