import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InputQueue} from '../../src/chat/input-queue.js';

test('push before next is buffered in order', async () => {
	const q = new InputQueue<number>();
	q.push(1);
	q.push(2);
	const it = q[Symbol.asyncIterator]();
	assert.deepEqual(await it.next(), {value: 1, done: false});
	assert.deepEqual(await it.next(), {value: 2, done: false});
});

test('push after next resolves the pending next', async () => {
	const q = new InputQueue<number>();
	const it = q[Symbol.asyncIterator]();
	const p = it.next();
	q.push(7);
	assert.deepEqual(await p, {value: 7, done: false});
});

test('close resolves a pending next and rejects later push', async () => {
	const q = new InputQueue<number>();
	const it = q[Symbol.asyncIterator]();
	const p = it.next();
	q.close();
	assert.equal((await p).done, true);
	assert.throws(() => q.push(1), /closed/);
});

test('buffered items drain before done after close', async () => {
	const q = new InputQueue<number>();
	q.push(1);
	q.close();
	const it = q[Symbol.asyncIterator]();
	assert.equal((await it.next()).done, false);
	assert.equal((await it.next()).done, true);
});

test('return() closes the queue', async () => {
	const q = new InputQueue<number>();
	const it = q[Symbol.asyncIterator]();
	await it.return?.();
	assert.throws(() => q.push(1), /closed/);
});
