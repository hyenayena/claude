import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inlineTokens, openFenceLine, parseMarkdown, type InlineToken} from '../../src/ui/markdown-parse.js';

const kinds = (md: string): string[] => parseMarkdown(md).map(b => b.kind);

test('blocks and their boundaries', () => {
	const md = ['# Title', 'para one', 'para two', '', '- a', '  - b', '1. c', '> q', '---', '```ts', 'x', '```', '| a |', '|---|', '| 1 |'].join('\n');
	assert.deepEqual(kinds(md), ['heading', 'paragraph', 'blank', 'item', 'item', 'item', 'quote', 'rule', 'code', 'table']);
	const blocks = parseMarkdown(md);
	assert.deepEqual((blocks[1] as {lines: string[]}).lines, ['para one', 'para two']);
	assert.equal((blocks[0] as {level: number}).level, 1);
});

test('a paragraph stops at a block start, a heading needs a space after the hashes', () => {
	assert.deepEqual(kinds('text\n# h\nmore\n- item\ntail'), ['paragraph', 'heading', 'paragraph', 'item', 'paragraph']);
	assert.deepEqual(kinds('#nospace\n####### seven'), ['paragraph']);
});

test('list depth follows the indentation, with continuation lines joined to the item', () => {
	const items = parseMarkdown('- a\n    - b\n        - c\n          continued\n- d').filter(b => b.kind === 'item') as Array<{depth: number; lines: string[]}>;
	assert.deepEqual(items.map(i => i.depth), [0, 1, 2, 0]);
	assert.deepEqual(items[2]!.lines, ['c', 'continued']);
	const deep = parseMarkdown(Array.from({length: 12}, (_, i) => `${'  '.repeat(i)}- x`).join('\n')) as Array<{depth: number}>;
	assert.equal(Math.max(...deep.map(d => d.depth)), 5);
});

test('markers: bullets, numbers and tasks', () => {
	const [a, b, c, d] = parseMarkdown('* a\n+ b\n7) c\n- [x] d') as Array<{marker: string; number: number; checked: boolean}>;
	assert.equal(a!.marker, 'bullet');
	assert.equal(b!.marker, 'bullet');
	assert.deepEqual([c!.marker, c!.number], ['number', 7]);
	assert.deepEqual([d!.marker, d!.checked], ['task', true]);
	assert.deepEqual(kinds('**bold** start\n-1 not an item\n1.5 million'), ['paragraph']);
});

test('fences: tilde, longer markers, info text, indentation and unclosed', () => {
	let [b] = parseMarkdown('~~~sh\necho\n~~~') as Array<{lang: string; lines: string[]; closed: boolean}>;
	assert.deepEqual([b!.lang, b!.lines, b!.closed], ['sh', ['echo'], true]);
	[b] = parseMarkdown('````md\n```\ninner\n```\n````') as typeof b[];
	assert.deepEqual(b!.lines, ['```', 'inner', '```']);
	[b] = parseMarkdown('```ts title="x"\ncode\n') as typeof b[];
	assert.deepEqual([b!.lang, b!.closed], ['ts', false]);
	[b] = parseMarkdown('  ```py\n  a = 1\n    b = 2\n  ```') as typeof b[];
	assert.deepEqual(b!.lines, ['a = 1', '  b = 2']);
	assert.deepEqual(kinds('- item\n  ```sh\n  ls\n  ```\n- next'), ['item', 'code', 'item']);
	assert.deepEqual(kinds('``` a`b\nx'), ['paragraph']);
	assert.equal(openFenceLine('a\n```ts\nx'), '```ts');
	assert.equal(openFenceLine('```ts\nx\n```'), undefined);
	assert.equal(openFenceLine('~~~\n```\n'), '~~~');
});

test('partial streams: a table without its delimiter is a paragraph', () => {
	assert.deepEqual(kinds('| a | b |'), ['paragraph']);
	assert.deepEqual(kinds('| a | b |\n|---'), ['paragraph']);
	assert.deepEqual(kinds('| a | b |\n|---|---|'), ['table']);
});

const flat = (tokens: InlineToken[]): string =>
	tokens.map(t => (t.kind === 'text' || t.kind === 'escape' || t.kind === 'code' ? t.text : `<${t.kind}>${flat(t.children)}</>`)).join('');

test('inline tokens: code, emphasis, strike, links and escapes', () => {
	assert.equal(flat(inlineTokens('a **b** *c* ~~d~~ `e` [f](http://x.y) \\*g\\*')), 'a <bold>b</> <italic>c</> <strike>d</> e <link>f</> *g*');
	assert.equal(flat(inlineTokens('***both***')), '<bold><italic>both</></>');
	assert.equal(flat(inlineTokens('**bold `code *x*` more**')), '<bold>bold code *x* more</>');
	assert.equal(flat(inlineTokens('``a`b``')), 'a`b');
	assert.equal(flat(inlineTokens('snake_case_name and 2 * 3 * 4')), 'snake_case_name and 2 * 3 * 4');
	assert.equal(flat(inlineTokens('_it_ and __bo__')), '<italic>it</> and <bold>bo</>');
});

test('unclosed markers stay literal', () => {
	assert.equal(flat(inlineTokens('**open and `tick and [link](')), '**open and `tick and [link](');
	assert.equal(flat(inlineTokens('[a](b c) [d]')), '[a](b c) [d]');
});

test('links keep their url and nest inline tokens', () => {
	const [l] = inlineTokens('[**b** `c`](https://x.dev/a?b=1)') as Array<{kind: string; url: string; children: unknown[]}>;
	assert.equal(l!.kind, 'link');
	assert.equal(l!.url, 'https://x.dev/a?b=1');
	assert.equal(l!.children.length, 3);
});

const within = (ms: number, fn: () => void): void => {
	const t = Date.now();
	fn();
	assert.ok(Date.now() - t < ms, `took ${Date.now() - t} ms`);
};

test('pathological 100k inputs stay linear', () => {
	const inputs = [
		'*a '.repeat(33_000),
		'**a '.repeat(25_000),
		'`'.repeat(100_000),
		'` `` ``` '.repeat(12_000),
		'['.repeat(100_000),
		'[a](' + 'b'.repeat(100_000),
		'[a]'.repeat(33_000),
		'_a_ '.repeat(25_000),
		'\\'.repeat(100_000),
		'~~a '.repeat(25_000),
		'***'.repeat(33_000),
	];
	for (const text of inputs) within(2000, () => inlineTokens(text));
	const blocks = [
		'- '.repeat(50_000),
		'| a '.repeat(25_000),
		'| a |\n|---|\n'.repeat(5000),
		'> '.repeat(50_000),
		'```\n'.repeat(25_000),
		' '.repeat(100_000) + 'x',
		'-' + ' '.repeat(100_000) + 'x',
		'#'.repeat(100_000),
		'1.'.repeat(50_000),
		Array.from({length: 20_000}, (_, i) => `${'  '.repeat(i % 9)}- item ${i}`).join('\n'),
	];
	for (const text of blocks) within(2000, () => parseMarkdown(text));
});
