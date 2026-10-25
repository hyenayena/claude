import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';
import {renderMarkdown} from '../../src/ui/markdown.js';
import {formatAssistantBlock, formatThinking, SGR} from '../../src/ui/present.js';

const ESC = String.fromCharCode(27);
const plain = (s: string) => s.replace(new RegExp(ESC + '\\[[0-9;]*m', 'g'), '');
const scrub = makeScrub(s => s);

test('headings, emphasis, code spans, links, lists and quotes are styled and keep their text', () => {
	const md = ['# Title', 'Some **bold**, *italic* and `code`.', '- item', '- [x] done', '1. first', '> quoted', 'See [docs](https://x.dev).', '---'].join('\n');
	const out = renderMarkdown(md);
	assert.deepEqual(plain(out).split('\n'), ['Title', 'Some bold, italic and code.', '• item', '☑ done', '1. first', '│ quoted', 'See docs (https://x.dev).', '─'.repeat(40)]);
	assert.ok(out.includes(`${SGR.bold}bold${SGR.boldOff}`));
	assert.ok(out.includes(`${SGR.cyan}code${SGR.fgOff}`));
	assert.ok(out.includes(`${SGR.italic}italic${SGR.italicOff}`));
});

test('fenced code is framed and highlighted; markup inside it is left alone', () => {
	const out = renderMarkdown(['```ts', 'const x = "**hi**"; // note', '```', 'after'].join('\n'));
	assert.deepEqual(plain(out).split('\n'), ['╭─ ts', '│ const x = "**hi**"; // note', '╰─', 'after']);
	assert.ok(out.includes(`${SGR.magenta}const${SGR.fgOff}`));
	assert.ok(out.includes(`${SGR.green}"**hi**"${SGR.fgOff}`));
	assert.ok(!out.includes(`${SGR.bold}hi`));
	assert.equal(plain(renderMarkdown('```\nopen')), '╭─\n│ open\n╰─');
});

test('assistant blocks are rendered after scrubbing, so only constant codes appear', () => {
	const dirty = `**x${ESC}]0;evil\u0007** \`${ESC}[31mred\``;
	const out = formatAssistantBlock(dirty, scrub);
	let rest = out;
	for (const code of Object.values(SGR)) rest = rest.split(code).join('');
	assert.ok(!rest.includes(ESC));
	assert.ok(!rest.includes('\u0007'));
});

test('a thinking block is dim, labelled and cut to six lines', () => {
	const text = Array.from({length: 9}, (_v, i) => `step ${i}`).join('\n');
	const lines = plain(formatThinking(text, scrub)).split('\n');
	assert.equal(lines[0], '✻ Thinking…');
	assert.equal(lines.length, 8);
	assert.equal(lines.at(-1), '  … +3 lines (ctrl+o to expand)');
});

test('renderMarkdownBlocks reports each fenced block and labels it for copying when asked', async () => {
	const {renderMarkdownBlocks, renderMarkdown} = await import('../../src/ui/markdown.js');
	const strip = (s: string) => s.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '');
	const md = 'Intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\n```\n```\n\n~~~sh\necho hi';
	const plain = renderMarkdownBlocks(md);
	assert.deepEqual(plain.codeBlocks, [
		{header: 2, code: 'const a = 1;\nconst b = 2;'},
		{header: 10, code: 'echo hi'},
	]);
	assert.equal(strip(plain.text.split('\n')[2]!), '╭─ ts');
	assert.equal(renderMarkdown(md), plain.text);
	const labelled = renderMarkdownBlocks(md, {copyLabel: true}).text.split('\n').map(strip);
	assert.equal(labelled[2], '╭─ ts · copy');
	assert.equal(labelled[7], '╭─');
	assert.equal(labelled[10], '╭─ sh · copy');
});
