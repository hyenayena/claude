import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mouseHost, validEvent, type ViewMouseEvent} from '../../src/ui/view-mouse.js';

const ev = (patch: Partial<ViewMouseEvent> = {}): ViewMouseEvent => ({
	kind: 'press',
	button: 'left',
	x: 1,
	y: 1,
	width: 10,
	height: 5,
	shift: false,
	meta: false,
	ctrl: false,
	...patch,
});

test('mouseHost returns the bound subscription only when the host has one', () => {
	const seen: unknown[] = [];
	const host = {
		tag: 'h',
		subscribeMouse(this: {tag: string}, listener: unknown) {
			seen.push(this.tag, typeof listener);
			return () => {};
		},
	};
	const subscribe = mouseHost(host);
	assert.ok(subscribe);
	assert.equal(typeof subscribe(() => true), 'function');
	assert.deepEqual(seen, ['h', 'function']);
	assert.equal(mouseHost({}), undefined);
	assert.equal(mouseHost({subscribeMouse: 'no'}), undefined);
	assert.equal(mouseHost(undefined), undefined);
	assert.equal(mouseHost(null), undefined);
});

test('validEvent accepts well-formed events', () => {
	assert.ok(validEvent(ev()));
	assert.ok(validEvent(ev({x: 0, y: 0})));
	assert.ok(validEvent(ev({x: 9, y: 4})));
	assert.ok(validEvent(ev({kind: 'wheel', button: 'none', wheel: 'up'})));
	assert.ok(validEvent(ev({kind: 'release', button: 'none'})));
});

test('validEvent rejects malformed events', () => {
	for (const bad of [
		undefined,
		null,
		'press',
		ev({x: -1}),
		ev({x: 10}),
		ev({y: 5}),
		ev({x: 1.5}),
		ev({y: Number.NaN}),
		ev({width: Number.POSITIVE_INFINITY}),
		ev({width: 0, x: 0}),
		ev({kind: 'drag' as never}),
		ev({button: 'back' as never}),
		ev({kind: 'wheel'}),
		ev({kind: 'wheel', wheel: 'left' as never}),
		{...ev(), x: '1'},
	]) {
		assert.equal(validEvent(bad), false, JSON.stringify(bad));
	}
});
