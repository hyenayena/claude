import assert from 'node:assert/strict';
import {test} from 'node:test';
import {stringCells} from '../../src/kit.js';
import {formatBanner, MASCOT, PLAIN_LOGO, WORDMARK} from '../../src/ui/banner.js';

const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const id = (s: string): string => s;
const build = {
	version: '0.1.0',
	modules: [
		{name: 'account', version: '0.4.0'},
		{name: 'claude', version: '0.8.0'},
		{name: 'core', version: '0.9.0'},
		{name: 'dev', version: '0.2.0'},
		{name: 'http', version: '0.3.0'},
		{name: 'md', version: '0.1.0'},
		{name: 'project', version: '0.1.0'},
		{name: 'scheduler', version: '0.1.0'},
		{name: 'task', version: '0.2.0'},
	],
};

const rowsOf = (columns: number, extra: Partial<Parameters<typeof formatBanner>[0]> = {}): string[] =>
	plain(formatBanner({build, model: 'claude-opus-5-5', columns, ...extra}, id)).split('\n');
const has = (rows: string[], s: string): boolean => rows.some(r => r.includes(s));

test('a wide chat puts the versions and model to the right of the paw and wordmark', () => {
	const rows = rowsOf(120);
	assert.equal(rows.length, 2 + MASCOT.length);
	assert.ok(rows[1]!.includes(MASCOT[0]!) && rows[1]!.includes('yena 0.1.0 · model claude-opus-5-5'));
	assert.ok(has(rows, 'modules  account 0.4.0'));
	for (const m of build.modules) assert.ok(has(rows, `${m.name} ${m.version}`), m.name);
});

test('the paw and the wordmark start on the same row', () => {
	const rows = rowsOf(80);
	for (let i = 0; i < MASCOT.length; i++) {
		assert.ok(rows[1 + i]!.includes(MASCOT[i]!) && rows[1 + i]!.includes(WORDMARK[i]!), `row ${i}`);
	}
});

test('without room on the right the info goes below the logo', () => {
	const rows = rowsOf(80);
	const last = rows.findIndex(r => r.includes(WORDMARK.at(-1)!));
	const head = rows.findIndex(r => r.includes('yena 0.1.0 · model claude-opus-5-5'));
	assert.ok(head > last);
});

test('a narrower chat shows only the paw, then only the plain word', () => {
	const paw = rowsOf(50);
	assert.ok(has(paw, MASCOT[1]!) && !has(paw, WORDMARK[0]!));
	const word = rowsOf(20);
	assert.ok(word[1]!.includes(PLAIN_LOGO));
	assert.ok(!has(word, MASCOT[1]!) && !has(word, WORDMARK[0]!));
});

test('every row of the box has the same width and never exceeds the chat or 100 cells', () => {
	for (const columns of [140, 100, 90, 80, 60, 50, 30, 20, 12, 8]) {
		const rows = rowsOf(columns);
		assert.equal(new Set(rows.map(stringCells)).size, 1, `columns ${columns}`);
		assert.ok(stringCells(rows[0]!) <= Math.min(columns, 100), `columns ${columns}`);
	}
});

test('the module list wraps beside its label, moves under it when narrow, and is dropped when nothing fits', () => {
	const beside = rowsOf(30);
	assert.ok(has(beside, 'modules  account 0.4.0'));
	for (const m of build.modules) assert.ok(has(beside, `${m.name} ${m.version}`), m.name);
	const under = rowsOf(20);
	assert.ok(under.some(r => /│ modules +│/.test(r)));
	assert.ok(has(under, '│ scheduler 0.1.0'));
	const none = rowsOf(12);
	assert.ok(!has(none, 'modules'));
	assert.ok(has(none, 'yena 0.'));
});

test('the head splits into version and model when it does not fit on one line', () => {
	const rows = rowsOf(30);
	assert.ok(has(rows, '│ yena 0.1.0 ') && has(rows, '│ model claude-opus-5-5'));
});

test('missing build info and model fall back to plain words, and no folder is shown', () => {
	const text = plain(formatBanner({columns: 80}, id));
	assert.ok(text.includes('yena unknown') && text.includes('model default'));
	assert.ok(!text.includes('modules'));
	assert.ok(!text.includes('folder'));
});

test('a chat too narrow for a box gets no banner', () => {
	assert.equal(formatBanner({build, columns: 7}, id), '');
});

test('every untrusted string goes through scrub', () => {
	const seen: string[] = [];
	const scrub = (s: string): string => {
		seen.push(s);
		return s.replace(/x/g, '?');
	};
	const text = formatBanner({build: {version: 'x1', modules: [{name: 'mx', version: 'vx'}]}, model: 'mx2', columns: 80}, scrub);
	assert.ok(!plain(text).includes('x'));
	assert.deepEqual([...new Set(seen)].sort(), ['mx', 'mx2', 'vx', 'x1'].sort());
});

test('the module list is never dropped just to keep the info on the right', () => {
	for (const model of [undefined, 'opus', 'claude-opus-5-5']) {
		for (let columns = 19; columns <= 140; columns++) {
			const text = plain(formatBanner({build, ...(model && {model}), columns}, id));
			assert.ok(text.includes('modules'), `model ${model ?? 'default'}, columns ${columns}`);
		}
	}
});
