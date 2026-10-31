import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPinWatch} from '../../src/chat/pin-watch.js';

test('the pin watch caches the value and notifies only on a change', () => {
	let value: string | undefined = 'a';
	let reads = 0;
	const w = createPinWatch(() => (reads++, value));
	assert.equal(w.current(), 'a');
	assert.equal(w.current(), 'a');
	assert.equal(reads, 1);
	let calls = 0;
	const off = w.subscribe(() => calls++);
	w.refresh();
	assert.equal(calls, 0);
	value = 'b';
	w.refresh();
	assert.equal([w.current(), calls].join(), 'b,1');
	value = undefined;
	w.refresh();
	assert.equal(w.current(), undefined);
	assert.equal(calls, 2);
	off();
	value = 'c';
	w.refresh();
	assert.equal(w.current(), 'c');
	assert.equal(calls, 2);
});

test('a failing read keeps the old value', () => {
	let fail = false;
	const w = createPinWatch(() => {
		if (fail) throw new Error('unreadable');
		return 'a';
	});
	let calls = 0;
	w.subscribe(() => calls++);
	fail = true;
	w.refresh();
	assert.equal(w.current(), 'a');
	assert.equal(calls, 0);
	assert.equal(createPinWatch(() => {
		throw new Error('unreadable');
	}).current(), undefined);
});
