import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stringCells} from '../../src/kit.js';
import {cursorFromClick, inputRows} from '../../src/ui/InputLine.js';

const FAMILY = '\u{1f468}‍\u{1f469}‍\u{1f467}';
const PIECES = ['a', '日', '本', FAMILY, '😀', 'é', ' ', '\n', 'zz', '🇺🇦'];

function build(seed: number): string {
	let s = seed;
	let out = '';
	for (let i = 0; i < 40; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		out += PIECES[s % PIECES.length];
	}
	return out;
}

test('every rendered input row fits the columns for wide, ZWJ and flag text, at any cursor', () => {
	for (let seed = 1; seed <= 40; seed++) {
		const text = build(seed);
		for (const columns of [11, 12, 20, 33]) {
			for (const cursor of [0, Math.floor(text.length / 2), text.length]) {
				const rows = inputRows(text, cursor, columns, 3);
				assert.ok(rows.length >= 1 && rows.length <= 3);
				for (const r of rows) {
					const cells = 2 + stringCells(r.before) + stringCells(r.cell ?? '') + stringCells(r.after);
					assert.ok(cells <= columns, `${JSON.stringify({text, columns, cursor, r})} is ${cells} cells`);
				}
			}
		}
	}
});

test('clicking a rendered cell of the cursor row maps to a grapheme boundary of the text', () => {
	for (let seed = 1; seed <= 40; seed++) {
		const text = build(seed);
		const cursor = text.length;
		const rows = inputRows(text, cursor, 20, 3);
		for (let row = 0; row < rows.length; row++) {
			for (let cell = 0; cell < 20; cell++) {
				const off = cursorFromClick(text, cursor, 20, 3, row, cell);
				assert.ok(off !== undefined && off >= 0 && off <= text.length);
				const code = text.charCodeAt(off as number);
				assert.ok(!(code >= 0xdc00 && code <= 0xdfff), 'never lands inside a surrogate pair');
				assert.ok(text.charCodeAt((off as number) - 1) !== 0x200d, 'never lands right after a ZWJ');
			}
		}
	}
});
