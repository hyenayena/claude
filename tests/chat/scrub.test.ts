import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makeScrub} from '../../src/chat/scrub.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const redact = (s: string) => s.split(SECRET).join('[redacted]');

test('a secret split by an escape sequence is still redacted', () => {
	const scrub = makeScrub(redact);
	const split = `${SECRET.slice(0, 12)}\u001b[31m${SECRET.slice(12, 20)}\u001b]0;x\u0007${SECRET.slice(20)}`;
	const out = scrub(split);
	assert.equal(out, '[redacted]');
	assert.ok(!out.includes('TESTVALUE'));
});

test('a secret split by a zero-width char is redacted', () => {
	assert.equal(makeScrub(redact)(`${SECRET.slice(0, 10)}​${SECRET.slice(10)}`), '[redacted]');
});
