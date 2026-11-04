import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatAssistantBlock, formatToolBlock, formatUserLine} from '../../src/ui/present.js';

const KEYS = ['NO_COLOR', 'YENA_COLOR', 'COLORTERM', 'TERM'];

test('laying out thousands of blocks reads the environment at most once per key', () => {
	// A fresh process per test file: the depth has not been detected yet.
	const reads = new Map<string, number>();
	const real = process.env;
	process.env = new Proxy(real, {
		get(target, key, receiver) {
			if (typeof key === 'string' && KEYS.includes(key)) reads.set(key, (reads.get(key) ?? 0) + 1);
			return Reflect.get(target, key, receiver);
		},
	});
	const scrub = (s: string) => s;
	try {
		for (const width of [80, 120]) {
			for (let i = 0; i < 2000; i++) {
				formatUserLine(`line ${i}`, scrub);
				formatAssistantBlock(`- item ${i}\n\n\`code\` and **bold**`, scrub, false, width);
				formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: i % 2 === 0, text: 'out'}, scrub, width);
			}
		}
	} finally {
		process.env = real;
	}
	for (const k of KEYS) assert.ok((reads.get(k) ?? 0) <= 1, `${k} read ${reads.get(k)} times`);
});

test('resizing over file cards highlights each card once', async () => {
	const {preloadHighlighter, resetHighlighterForTests} = await import('../../src/ui/highlight.js');
	let calls = 0;
	const html = (code: string) => code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	resetHighlighterForTests(async spec => ({
		default: spec.endsWith('/core')
			? {newInstance: () => ({highlight: (code: string) => (calls++, {value: html(code)}), registerLanguage: () => {}})}
			: () => ({}),
	}));
	assert.equal(await preloadHighlighter(), true);
	const scrub = (s: string) => s;
	const cards = Array.from({length: 20}, (_, i) => ({
		name: 'Edit',
		input: {file_path: `/src/file${i}.ts`},
		isError: false,
		text: '',
		patch: {hunks: [{oldStart: 1, newStart: 1, lines: [' keep', `-const a${i} = 1;`, `+const a${i} = 2;`]}]},
	}));
	for (const width of [40, 60, 80, 120, 160, 80]) for (const c of cards) formatToolBlock(c, scrub, width);
	assert.equal(calls, cards.length * 2);
	resetHighlighterForTests();
});
