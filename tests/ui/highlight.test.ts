import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
	HIGHLIGHT_LANGUAGES,
	highlighterFor,
	highlighterReady,
	languageFor,
	preloadHighlighter,
	resetHighlighterForTests,
	tokensFromHljsHtml,
} from '../../src/ui/highlight.js';

test('languageFor: extensions, basenames and shebangs', () => {
	const cases: [string, string | undefined][] = [
		['a/b.ts', 'typescript'],
		['A.TSX', 'typescript'],
		['x.mjs', 'javascript'],
		['x.jsonc', 'json'],
		['page.html', 'xml'],
		['style.scss', 'scss'],
		['README.md', 'markdown'],
		['ci.yml', 'yaml'],
		['conf.toml', 'ini'],
		['run.zsh', 'bash'],
		['main.go', 'go'],
		['lib.rs', 'rust'],
		['h.hpp', 'cpp'],
		['u.cs', 'csharp'],
		['q.sql', 'sql'],
		['x.patch', 'diff'],
		['rules.mk', 'makefile'],
		['Dockerfile', 'dockerfile'],
		['/x/Makefile', 'makefile'],
		['.bashrc', 'bash'],
		['image.png', undefined],
		['LICENSE', undefined],
	];
	for (const [path, language] of cases) assert.equal(languageFor(path), language, path);
	assert.equal(languageFor('run', '#!/usr/bin/env node'), 'javascript');
	assert.equal(languageFor('run', '#!/bin/bash -e'), 'bash');
	assert.equal(languageFor('run', '#!/usr/bin/env python3'), 'python');
	assert.equal(languageFor('run', '#!/usr/bin/env tsx'), 'typescript');
	assert.equal(languageFor('run', '#!/usr/bin/perl'), undefined);
	assert.equal(languageFor('run', 'plain text'), undefined);
	assert.equal(languageFor('a.ts', '#!/bin/sh'), 'typescript');
	for (const name of ['typescript', 'python', 'diff', 'makefile']) assert.ok((HIGHLIGHT_LANGUAGES as readonly string[]).includes(name));
});

test('tokensFromHljsHtml: entities, nested and cross-line spans, unknown tags literal', () => {
	assert.deepEqual(tokensFromHljsHtml('a &lt;b&gt; &amp; &quot;c&quot; &#x27;d&#39;'), [[{text: `a <b> & "c" 'd'`}]]);
	assert.deepEqual(tokensFromHljsHtml('<span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>'), [
		[{text: 'const', tone: 'code.keyword'}, {text: ' x = '}, {text: '1', tone: 'code.number'}],
	]);
	assert.deepEqual(tokensFromHljsHtml('<span class="hljs-comment">/* a\nb */</span>\nx'), [
		[{text: '/* a', tone: 'code.comment'}],
		[{text: 'b */', tone: 'code.comment'}],
		[{text: 'x'}],
	]);
	assert.deepEqual(tokensFromHljsHtml('<span class="hljs-string">"<span class="hljs-subst">${x}</span>"</span>'), [[{text: '"${x}"', tone: 'code.string'}]]);
	assert.deepEqual(tokensFromHljsHtml('<span class="hljs-title function_">f</span><span class="hljs-title class_">C</span>'), [
		[{text: 'f', tone: 'code.function'}, {text: 'C', tone: 'code.type'}],
	]);
	assert.deepEqual(tokensFromHljsHtml('<b>x</b></span>'), [[{text: '<b>x</b></span>'}]]);
});

test('a loaded highlighter paints a TypeScript sample with keyword and string tones', async () => {
	resetHighlighterForTests();
	assert.equal(highlighterReady(), false);
	assert.equal(highlighterFor('typescript'), undefined);
	assert.equal(await preloadHighlighter(), true);
	assert.equal(highlighterReady(), true);
	const hl = highlighterFor('typescript')!;
	const lines = ['const a: string = "x&y";', '// note', 'function f() {}'];
	const tokens = hl(lines)!;
	assert.equal(tokens.length, 3);
	for (const [i, row] of tokens.entries()) assert.equal(row.map(t => t.text).join(''), lines[i]);
	const tones = tokens.flat().map(t => t.tone);
	assert.ok(tones.includes('code.keyword'));
	assert.ok(tones.includes('code.string'));
	assert.ok(tones.includes('code.comment'));
	assert.equal(highlighterFor('klingon'), undefined);
	assert.equal(highlighterFor(undefined), undefined);
	assert.ok(highlighterFor('python')!(['def f():\n'.trim()])!.flat().some(t => t.tone === 'code.keyword'));
});

test('caps give undefined: many lines, a long line, too many characters', async () => {
	resetHighlighterForTests();
	await preloadHighlighter();
	const hl = highlighterFor('javascript')!;
	assert.equal(hl(Array.from({length: 2001}, () => 'x')), undefined);
	assert.equal(hl(['x'.repeat(1001)]), undefined);
	assert.equal(hl(Array.from({length: 100}, () => 'x'.repeat(900))), undefined);
});

test('a failed import leaves the highlighter off', async () => {
	resetHighlighterForTests(async () => {
		throw new Error('missing');
	});
	assert.equal(await preloadHighlighter(), false);
	assert.equal(highlighterReady(), false);
	assert.equal(highlighterFor('typescript'), undefined);
	resetHighlighterForTests();
});

test('fenceLanguage maps names, extensions and aliases, and refuses the rest', async () => {
	const {fenceLanguage} = await import('../../src/ui/highlight.js');
	const cases: Record<string, string | undefined> = {
		ts: 'typescript',
		TypeScript: 'typescript',
		tsx: 'typescript',
		js: 'javascript',
		node: 'javascript',
		py: 'python',
		python3: 'python',
		rs: 'rust',
		golang: 'go',
		sh: 'bash',
		shell: 'bash',
		console: 'bash',
		zsh: 'bash',
		yml: 'yaml',
		html: 'xml',
		'c++': 'cpp',
		'c#': 'csharp',
		jsonc: 'json',
		dockerfile: 'dockerfile',
		'.ts': 'typescript',
		diff: 'diff',
		'': undefined,
		text: undefined,
		nonsense: undefined,
		['x'.repeat(100)]: undefined,
	};
	for (const [tag, want] of Object.entries(cases)) assert.equal(fenceLanguage(tag), want, tag.slice(0, 20));
});
