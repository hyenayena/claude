import assert from 'node:assert/strict';
import {afterEach, test} from 'node:test';
import React from 'react';
void React;
import type {MountControl} from '../../../../src/api.js';
import {createShellPanel} from '../../src/chat/shell-panel.js';
import type {ShellCall, ShellSnapshot, ShellWatch} from '../../src/chat/shell-watch.js';
import {createShellElement} from '../../src/ui/mount.js';
import {mountHarness, wait} from './testkit.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const call = (id: string, startedAt: number, extra: Partial<ShellCall> = {}): ShellCall => ({
	toolUseId: id,
	command: `cmd ${id}`,
	startedAt,
	lines: [],
	bytes: 0,
	bound: 'file',
	...extra,
});

const fakeWatch = () => {
	let snap: ShellSnapshot = {calls: []};
	const subs = new Set<() => void>();
	const watch: ShellWatch = {
		feed: () => {},
		get: () => snap,
		subscribe: cb => {
			subs.add(cb);
			return () => void subs.delete(cb);
		},
		totalBytes: 0,
		close: () => {},
	};
	return {
		watch,
		set(calls: ShellCall[]) {
			snap = {calls};
			for (const cb of [...subs]) cb();
		},
	};
};

const setup = (opts: {focused?: boolean; reject?: boolean} = {}) => {
	const fw = fakeWatch();
	const log = makeFakeLog();
	let mounts = 0;
	let closes = 0;
	let settle: (() => void) | undefined;
	const options: unknown[] = [];
	const panel = createShellPanel({
		watch: fw.watch,
		mount: (build, o) => {
			options.push(o);
			mounts++;
			if (opts.reject) return Promise.reject(new Error('A view is already mounted'));
			return new Promise<void>(resolve => {
				const control: MountControl = {
					close: () => {
						closes++;
						resolve();
					},
				};
				build(control);
				settle = resolve;
			});
		},
		isFocused: () => opts.focused ?? true,
		build: () => ({}),
		hasTmp: true,
		log,
		showAfterMs: 40,
	});
	return {fw, panel, mounts: () => mounts, closes: () => closes, options, log, settle: () => settle};
};

afterEach(() => {});

test('mounts only after the threshold and closes with the last call', async () => {
	const s = setup();
	s.fw.set([call('a', Date.now())]);
	assert.equal(s.mounts(), 0);
	await wait(80);
	assert.equal(s.mounts(), 1);
	assert.deepEqual(s.options[0], {target: 'panel', activity: true});
	s.fw.set([call('a', Date.now()), call('b', Date.now())]);
	assert.equal(s.mounts(), 1);
	s.fw.set([]);
	assert.equal(s.closes(), 1);
	s.panel.dispose();
});

test('a call that ends before the threshold never mounts', async () => {
	const s = setup();
	s.fw.set([call('a', Date.now())]);
	s.fw.set([]);
	await wait(80);
	assert.equal(s.mounts(), 0);
	s.panel.dispose();
});

test('no mount without focus in the chat, and no retry until the next call', async () => {
	const s = setup({focused: false});
	s.fw.set([call('a', Date.now())]);
	await wait(80);
	s.fw.set([call('a', 0), call('b', 0)]);
	assert.equal(s.mounts(), 0);
	s.panel.dispose();
});

test('a rejected mount is not retried', async () => {
	const s = setup({reject: true});
	s.fw.set([call('a', 0)]);
	await wait(20);
	s.fw.set([call('a', 0)]);
	await wait(20);
	assert.equal(s.mounts(), 1);
	s.fw.set([call('a', 0), call('b', 0)]);
	await wait(20);
	assert.equal(s.mounts(), 2);
	s.panel.dispose();
});

test('dispose closes the view', async () => {
	const s = setup();
	s.fw.set([call('a', 0)]);
	await wait(20);
	s.panel.dispose();
	assert.equal(s.closes(), 1);
});

test('the view shows each command with its elapsed time and tail', async () => {
	const fw = fakeWatch();
	fw.set([call('a', Date.now() - 3000, {lines: ['out1', 'out2']}), call('b', Date.now())]);
	const h = mountHarness(createShellElement(fw.watch) as React.ReactElement, {columns: 60, rows: 20});
	await h.settle(80);
	const frame = h.lastFrame();
	assert.match(frame, /\$ cmd a · 3s/);
	assert.match(frame, /out2/);
	assert.match(frame, /\$ cmd b · 0s/);
	h.unmount();
});

test('logs only metadata for the shell view', async () => {
	const s = setup({reject: true});
	s.fw.set([call('a', 0, {command: 'secret-command'})]);
	await wait(20);
	const rec = s.log.records.filter(r => r.msg === 'shell view');
	assert.equal(rec.length, 1);
	assert.equal(rec[0]!.fields['fallback'], 'busy');
	assert.ok(!JSON.stringify(s.log.records).includes('secret-command'));
	s.panel.dispose();
});

test('the threshold counts from the binding time, not from earlier activity', async () => {
	const s = setup();
	s.fw.set([call('a', Date.now())]);
	await wait(20);
	assert.equal(s.mounts(), 0);
	await wait(60);
	assert.equal(s.mounts(), 1);
	s.panel.dispose();
});

test('the shown log carries the binding kind', async () => {
	const s = setup();
	s.fw.set([call('a', 0, {bound: 'task'})]);
	await wait(20);
	s.fw.set([]);
	await wait(10);
	const rec = s.log.records.find(r => r.msg === 'shell view');
	assert.equal(rec?.fields['shown'], true);
	assert.equal(rec?.fields['bound'], 'task');
	s.panel.dispose();
});
