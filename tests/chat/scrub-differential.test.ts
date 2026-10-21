import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sanitizeBlock, sanitizeMultilineInput} from '../../src/kit.js';
import {makeScrub} from '../../src/chat/scrub.js';

// Reference copy of the pre-kit claude implementation, kept to prove the kit is never weaker.
const OSC_LIKE = /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const C1_OSC_LIKE = /[\u009d\u0090\u0098\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]?/g;
const ESC_TWO = /\u001b[ -~]?/g;
const C1 = /[\u0080-\u009f]/g;
const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const FORMAT = /(?!‍)\p{Cf}/gu;
const TAGS = /[\u{e0000}-\u{e007f}]/gu;
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const SEP = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');
const oldStrip = (t: string): string =>
	t.replace(OSC_LIKE, '').replace(CSI, '').replace(C1_OSC_LIKE, '').replace(C1_CSI, '').replace(ESC_TWO, '')
		.replace(C1, '').replace(C0, '').replace(FORMAT, '').replace(TAGS, '').replace(LONE, '�');
const oldDisplay = (t: string): string => oldStrip(t.replace(/\r\n/g, '\n').replace(SEP, '\n')).replace(/\t/g, '    ');
const oldInput = (t: string): string => oldStrip(t.replace(/\r\n?/g, '\n').replace(SEP, '\n'));

// Lone surrogates are excluded from the differential: the old code let separated halves rejoin after stripping, the kit does not.
const LONE_ATOM = new RegExp(LONE.source, 'g');

const UNSAFE = new RegExp(
	`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]|(?!\\u200d)\\p{Cf}|[\\u{e0000}-\\u{e007f}]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]`,
	'u',
);

const ATOMS = [
	'\u001b', '\u009b', '\u009d', '\u0090', '\u009c', '\u0007', '\\', '[', ']', 'P', '_', '^', 'X', '(', 'B', '0', ';', 'm', 'a', ' ',
	'\n', '\r', '\t', '\u0000', '\u007f', '\u0085', '‍', '​', '‮', '⁦', ' ', ' ', '﻿', '­',
	'\u{e0041}', '\ud800', '\udc00', '😀', '漢', 'é', '́', '؜', '᠎', '\u{1d173}', '\u{e0001}',
];

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function sample(r: () => number): string {
	const n = Math.floor(r() * 24);
	let out = '';
	for (let i = 0; i < n; i++) out += ATOMS[Math.floor(r() * ATOMS.length)];
	return out;
}

test('kit sanitizeBlock and sanitizeMultilineInput never emit unsafe characters (fuzz)', () => {
	const r = rng(1234);
	for (let i = 0; i < 20000; i++) {
		const s = sample(r);
		for (const out of [sanitizeBlock(s), sanitizeMultilineInput(s)]) {
			assert.equal(UNSAFE.test(out), false, JSON.stringify({s, out}));
		}
	}
});

test('without escape introducers the kit equals the old sanitizer; with them the output is always safe (fuzz)', () => {
	const r = rng(99);
	let compared = 0;
	for (let i = 0; i < 20000; i++) {
		const s = sample(r).replace(LONE_ATOM, '');
		const hasIntroducer = /[\u001b\u0080-\u009f]/.test(s);
		const cases: Array<[string, string, string]> = [
			['block', sanitizeBlock(s), oldDisplay(s)],
			['input', sanitizeMultilineInput(s), oldInput(s)],
		];
		for (const [name, nu, old] of cases) {
			assert.equal(UNSAFE.test(nu), false, JSON.stringify({name, s, nu}));
			if (!hasIntroducer) {
				compared++;
				assert.equal(nu, old, JSON.stringify({name, s, nu, old}));
			}
		}
	}
	assert.ok(compared > 1000);
});

test('plain text, newlines, tabs and ZWJ emoji are preserved like before', () => {
	const samples = ['hello\nworld', 'a\tb', '👨‍👩‍👧 family', 'résumé 漢字', 'x\r\ny'];
	for (const s of samples) {
		assert.equal(sanitizeBlock(s), oldDisplay(s));
		assert.equal(sanitizeMultilineInput(s), oldInput(s));
	}
});

test('makeScrub sanitizes before redacting: a secret split by an escape is still redacted', () => {
	const order: string[] = [];
	const scrub = makeScrub(s => {
		order.push(s);
		return s.replace(/sk-ant-[a-z0-9]+/g, '[redacted]');
	});
	const out = scrub('key sk-ant-ab\u001b[31mcd‮ef end');
	assert.equal(order[0], 'key sk-ant-abcdef end');
	assert.equal(out, 'key [redacted] end');
	assert.equal(UNSAFE.test(scrub('\u001b]0;t\u0007\u009bx \ud800')), false);
});
