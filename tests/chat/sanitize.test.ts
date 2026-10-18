import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sanitizeForDisplay as s, sanitizeInput} from '../../src/chat/sanitize.js';

const ESC = '\u001b';

test('OSC 8 hyperlinks (BEL and ST) lose payload but keep label', () => {
	assert.equal(s(`${ESC}]8;;http://evil${'\u0007'}click${ESC}]8;;${'\u0007'}`), 'click');
	assert.equal(s(`${ESC}]8;;http://evil${ESC}\\click${ESC}]8;;${ESC}\\`), 'click');
});

test('OSC 52 and OSC 0 are removed with payload', () => {
	assert.equal(s(`a${ESC}]52;c;ZXZpbA==\u0007b`), 'ab');
	assert.equal(s(`a${ESC}]0;title${ESC}\\b`), 'ab');
});

test('unterminated OSC is stripped to the end', () => {
	assert.equal(s(`a${ESC}]52;c;AAAA tail`), 'a');
});

test('C1 CSI and OSC introducers are removed with payload', () => {
	assert.equal(s('a\u009b31mb'), 'ab');
	assert.equal(s('a\u009d0;title\u0007b'), 'ab');
	assert.equal(s('a\u0085b\u0080c'), 'abc');
});

test('DCS, APC, PM, SOS are removed', () => {
	assert.equal(s(`a${ESC}Pdata${ESC}\\b`), 'ab');
	assert.equal(s(`a${ESC}_data${ESC}\\b`), 'ab');
	assert.equal(s(`a${ESC}^data${ESC}\\b`), 'ab');
	assert.equal(s(`a${ESC}Xdata${ESC}\\b`), 'ab');
});

test('SGR and other CSI are removed', () => {
	assert.equal(s(`${ESC}[31;1mred${ESC}[0m ${ESC}[2J${ESC}[?25l`), 'red ');
});

test('lone ESC and two-character sequences are removed', () => {
	assert.equal(s(`a${ESC}b`), 'a');
	assert.equal(s(`a${ESC}\nb`), 'a\nb');
	assert.equal(s(`a${ESC}cb`), 'ab');
});

test('bidi, zero-width and tag characters are removed; ZWJ kept', () => {
	assert.equal(s('a‮b⁦c‎؜d'), 'abcd');
	assert.equal(s('a​b⁠c﻿d­e'), 'abcde');
	assert.equal(s('a\u{e0041}\u{e007f}b'), 'ab');
	assert.equal(s('\u{1f468}‍\u{1f469}'), '\u{1f468}‍\u{1f469}');
});

test('lone surrogates become U+FFFD, pairs survive', () => {
	assert.equal(s('a\ud800b'), 'a�b');
	assert.equal(s('a\udc00b'), 'a�b');
	assert.equal(s('\u{1f600}'), '\u{1f600}');
});

test('CR, BS, BEL, DEL, NUL are removed; CRLF becomes LF', () => {
	assert.equal(s('a\r\nb\rc'), 'a\nbc');
	assert.equal(s('a\bb\u0007c\u007fd\u0000e'), 'abcde');
	assert.equal(s('a b c'), 'a\nb\nc');
});

test('newline kept and tab expanded to 4 spaces', () => {
	assert.equal(s('a\tb\nc'), 'a    b\nc');
});

test('sanitizing the concatenation handles escapes split across chunks', () => {
	const chunks = [`a${ESC}]52;c;`, 'ZXZpbA==\u0007b'];
	assert.notEqual(chunks.map(s).join(''), 'ab');
	assert.equal(s(chunks.join('')), 'ab');
});

test('sanitizeInput keeps newline and tab, folds CR', () => {
	assert.equal(sanitizeInput('a\tb\r\nc\rd\u001b[31me‮f'), 'a\tb\nc\nde' + 'f');
});
