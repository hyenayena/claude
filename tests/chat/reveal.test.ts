import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeReveal} from '../../src/chat/reveal.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const reveal = makeReveal(s => s.split(SECRET).join('[redacted]'));
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const C1 = String.fromCharCode(0x9b);
const t = (body: string) => `\u27e6${body}\u27e7`;

test('ESC, CSI and OSC sequences stay visible', () => {
	assert.equal(reveal('\u001b[31mred'), `${t('\\x1b')}[31mred`);
	assert.equal(reveal('\u001b]0;title\u0007x'), `${t('\\x1b')}]0;title${t('\\x07')}x`);
});

test('carriage return, tab and DEL become tokens, newline is kept', () => {
	assert.equal(reveal('a\rb\tc\nd\u007f'), `a${t('\\r')}b${t('⇥')}c\nd${t('\\x7f')}`);
});

test('C1, bidi, zero-width, ZWJ, tags and line separators are shown', () => {
	assert.equal(reveal(C1), t('\\x9b'));
	assert.equal(reveal(String.fromCharCode(0x202e)), t('\\u{202e}'));
	assert.equal(reveal(String.fromCharCode(0x200b)), t('\\u{200b}'));
	assert.equal(reveal(String.fromCharCode(0x200d)), t('\\u{200d}'));
	assert.equal(reveal(String.fromCodePoint(0xe0041)), t('\\u{e0041}'));
	assert.equal(reveal(LS + PS), t('\\u{2028}') + t('\\u{2029}'));
});

test('lone surrogates are shown, valid pairs kept', () => {
	assert.equal(reveal('\ud800x'), `${t('\\u{d800}')}x`);
	assert.equal(reveal('\udc00'), t('\\u{dc00}'));
	assert.equal(reveal('😀'), '😀');
});

test('no control or format character survives in the output', () => {
	const all = Array.from({length: 0x2100}, (_, i) => String.fromCharCode(i)).join('');
	const out = reveal(all);
	assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
	assert.doesNotMatch(out, /\p{Cf}/u);
});

test('plain text is unchanged', () => {
	assert.equal(reveal('ls -la "/tmp/é ü"'), 'ls -la "/tmp/é ü"');
	assert.equal(reveal('printf "a\\n" \\x1b'), 'printf "a\\n" \\x1b');
});

test('redaction runs after reveal', () => {
	assert.equal(reveal(`echo ${SECRET}\u001b`), `echo [redacted]${t('\\x1b')}`);
});

test('real control characters are distinguishable from literal look-alike text', () => {
	assert.notEqual(reveal('\u001b[31m'), reveal('\\x1b[31m'));
	assert.equal(reveal('\\x1b[31m'), '\\x1b[31m');
	assert.notEqual(reveal('\t'), reveal('⇥'));
	assert.equal(reveal('⇥'), '⇥');
	assert.notEqual(reveal('\r'), reveal('\\r'));
});

test('literal delimiters are revealed so a delimited token can only come from reveal', () => {
	const forged = '\u27e6\\x1b\u27e7';
	assert.equal(reveal(forged), `${t('\\u{27e6}')}\\x1b${t('\\u{27e7}')}`);
	assert.notEqual(reveal(forged), reveal('\u001b'));
	assert.equal(reveal('a\u27e6b'), `a${t('\\u{27e6}')}b`);
});
