import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEvent, UiEvent} from '../../src/deps/chat.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {stringCells, type SpanRow} from '../../src/kit.js';
import {layoutPanel, navigate, PANEL, revealAgent} from '../../src/ui/agent-panel.js';
import {focusAgent, initialAgents, reduceAgents, type AgentsState} from '../../src/ui/agents.js';

const SECRET = 'sk-ant-oat-PANELSECRET0123456789abcdef';
const scrub = makeScrub(s => s.split(SECRET).join('[redacted]'));
const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});
const spawn = (id: string, input: Record<string, unknown> = {}): ChatEvent => ui({kind: 'tool-use', toolUseId: id, name: 'Agent', input});
const run = (events: ChatEvent[], from: AgentsState = initialAgents()): AgentsState => events.reduce(reduceAgents, from);
const text = (row: SpanRow): string => row.map(s => s.text).join('');
const cells = (row: SpanRow): number => stringCells(text(row));
const all = (rows: SpanRow[]): string => rows.map(text).join('\n');

const agents = (n: number): AgentsState => {
	let s = initialAgents();
	for (let i = 0; i < n; i++) s = reduceAgents(s, spawn(`a${i}`, {subagent_type: `Worker${i}`}));
	return s;
};

test('no panel without boxes or on a short screen', () => {
	assert.equal(layoutPanel(initialAgents(), {columns: 100, rows: 40, scrub}).height, 0);
	assert.equal(layoutPanel(agents(1), {columns: 100, rows: PANEL.minRows - 1, scrub}).height, 0);
	assert.equal(layoutPanel(agents(1), {columns: 5, rows: 40, scrub}).height, 0);
});

test('every row is exactly columns - 1 cells wide and the panel stays within 40% of the rows', () => {
	for (const n of [1, 2, 3, 5, 9, 32]) {
		for (const columns of [13, 20, 29, 40, 57, 80, 121, 200]) {
			for (const rows of [12, 20, 37, 60]) {
				let s = agents(n);
				s = reduceAgents(s, {type: 'ui', event: {kind: 'agent-message', agentId: 'a0', items: [{type: 'text', text: '日本語のテキスト '.repeat(20)}]}});
				const p = layoutPanel(s, {columns, rows, scrub});
				assert.ok(p.height <= Math.floor(rows * PANEL.share), `${n}/${columns}/${rows}: ${p.height}`);
				assert.equal(p.rows.length, p.height);
				for (const row of p.rows) {
					if (row.length === 1 && /^[↑↓]/.test(row[0]!.text)) assert.ok(cells(row) <= columns - 1);
					else assert.equal(cells(row), columns - 1, `${n}/${columns}/${rows}: ${text(row)}`);
				}
			}
		}
	}
});

test('boxes are full height when they fit, then shrink, then scroll with more-indicators', () => {
	const full = layoutPanel(agents(2), {columns: 81, rows: 40, scrub});
	assert.equal(full.height, PANEL.fullHeight);
	const short = layoutPanel(agents(6), {columns: 81, rows: 30, scrub});
	assert.equal(short.height, 3 * PANEL.shortHeight, 'three grid rows of short boxes');
	const scrolled = layoutPanel(agents(12), {columns: 81, rows: 30, scrub});
	assert.ok(scrolled.height <= 12);
	assert.match(text(scrolled.rows.at(-1)!), /^↓ \d+ more$/);
	assert.ok(scrolled.visibleIds.length < 12);
	assert.equal(scrolled.ids.length, 12);
	const down = layoutPanel({...agents(12), scroll: 1}, {columns: 81, rows: 30, scrub});
	assert.match(text(down.rows[0]!), /^↑ 2 more$/);
	assert.equal(down.scroll, 1);
	const clamped = layoutPanel({...agents(12), scroll: 99}, {columns: 81, rows: 30, scrub});
	assert.equal(clamped.scroll, clamped.maxScroll);
	assert.ok(!/↓/.test(all(clamped.rows)));
});

test('revealAgent scrolls the selected or open box into view', () => {
	const look = {columns: 81, rows: 30, scrub};
	const s = revealAgent(focusAgent(agents(20), {selected: 'a19'}), look);
	assert.ok(layoutPanel(s, look).visibleIds.includes('a19'));
	const back = revealAgent({...focusAgent(agents(20), {open: 'a0'}), scroll: 5}, look);
	assert.equal(back.scroll, 0);
	assert.ok(layoutPanel(back, look).visibleIds.includes('a0'));
	const unfocused = {...agents(20), scroll: 3};
	assert.equal(revealAgent(unfocused, look), unfocused);
});

test('the layout only clamps the scroll, so the wheel can move away from an open or selected box', () => {
	const look = {columns: 81, rows: 30, scrub};
	for (const focus of [{open: 'a0'}, {selected: 'a0'}]) {
		const p = layoutPanel({...focusAgent(agents(12), focus), scroll: 5}, look);
		assert.equal(p.maxScroll, 4);
		assert.equal(p.scroll, 4);
		assert.ok(!p.visibleIds.includes('a0'));
	}
});

test('a parent and its callees share a group frame with caller and callee footers', () => {
	const s = run([
		spawn('solo', {subagent_type: 'Lone'}),
		spawn('root', {subagent_type: 'Planner'}),
		{type: 'ui', event: {kind: 'agent-message', agentId: 'root', items: [{type: 'tool-use', toolUseId: 'kid', name: 'Agent', input: {subagent_type: 'Coder'}}]}},
	]);
	const p = layoutPanel(s, {columns: 121, rows: 60, scrub});
	const out = all(p.rows);
	assert.match(out, /Planner · 2 agents/);
	assert.match(out, /by Planner/);
	assert.match(out, /calls 1/);
	assert.deepEqual(p.ids, ['solo', 'root', 'kid']);
});

test('box content: spinner, name, short model, one-liners and the thinking row; badges when finished', () => {
	let s = run([
		spawn('a', {subagent_type: 'Explore', model: 'claude-haiku-4-5-20251001'}),
		{
			type: 'ui',
			event: {
				kind: 'agent-message',
				agentId: 'a',
				items: [
					{type: 'text', text: `First line ${SECRET}\nsecond`},
					{type: 'tool-use', toolUseId: 't', name: 'Read', input: {file_path: 'foo.ts'}},
				],
			},
		},
	]);
	const live = all(layoutPanel(s, {columns: 81, rows: 40, scrub, spinner: '✶', corner: '◳'}).rows);
	assert.match(live, /✶ Explore/);
	assert.match(live, /haiku-4\.5/);
	assert.match(live, /● First line \[redacted\]/);
	assert.ok(!live.includes(SECRET));
	assert.ok(!live.includes('second'));
	assert.match(live, /Read foo\.ts/);
	assert.match(live, /◳ [A-Z][a-z]+…/);
	for (const [outcome, word] of [
		[{kind: 'tool-result', toolUseId: 'a', isError: false, text: ''}, 'DONE'],
		[{kind: 'tool-result', toolUseId: 'a', isError: true, text: ''}, 'FAILED'],
	] as const) {
		const done = layoutPanel(reduceAgents(s, {type: 'ui', event: outcome}), {columns: 81, rows: 40, scrub});
		const rows = done.rows;
		assert.match(all(rows), new RegExp(word));
		assert.doesNotMatch(all(rows), /◳ [A-Z][a-z]+…/);
		const badge = rows.flat().find(sp => sp.text === word)!;
		assert.equal(badge.tone, word === 'DONE' ? 'add' : 'del');
	}
	s = reduceAgents(s, {type: 'turn-end', outcome: 'interrupted'});
	const stopped = layoutPanel(s, {columns: 81, rows: 40, scrub}).rows;
	assert.equal(stopped.flat().find(sp => sp.text === 'STOPPED')!.tone, 'warn');
	assert.ok(stopped.flat().some(sp => sp.tone === 'dim' && sp.text.includes('╭')), 'a finished box is grey');
});

test('selected and open boxes are highlighted', () => {
	const sel = layoutPanel(focusAgent(agents(2), {selected: 'a1'}), {columns: 81, rows: 40, scrub});
	assert.ok(sel.rows.flat().some(sp => sp.tone === 'info' && sp.bold === true && sp.text.includes('╭')));
	const open = layoutPanel(focusAgent(agents(2), {open: 'a0'}), {columns: 81, rows: 40, scrub});
	assert.ok(open.rows.flat().some(sp => sp.inverse === true && sp.text.includes('Worker0')));
});

test('hit test maps panel cells to boxes', () => {
	const p = layoutPanel(agents(2), {columns: 81, rows: 40, scrub});
	assert.equal(p.hit(0, 0), 'a0');
	assert.equal(p.hit(39, 3), 'a0');
	assert.equal(p.hit(40, 3), 'a1');
	assert.equal(p.hit(79, 6), 'a1');
	assert.equal(p.hit(80, 0), undefined);
	assert.equal(p.hit(0, 7), undefined);
	assert.equal(p.hit(-1, 0), undefined);
	const scrolled = layoutPanel({...agents(12), scroll: 1}, {columns: 81, rows: 30, scrub});
	assert.equal(scrolled.hit(0, 0), undefined, 'the indicator row is not a box');
	assert.equal(scrolled.hit(0, 1), 'a2');
});

test('navigate moves across the grid; up from the top row leaves the panel', () => {
	const p = layoutPanel(agents(5), {columns: 81, rows: 60, scrub});
	assert.equal(navigate(p, 'a0', 'right'), 'a1');
	assert.equal(navigate(p, 'a0', 'left'), 'a0');
	assert.equal(navigate(p, 'a0', 'down'), 'a2');
	assert.equal(navigate(p, 'a3', 'up'), 'a1');
	assert.equal(navigate(p, 'a1', 'up'), undefined);
	assert.equal(navigate(p, 'a4', 'down'), 'a4');
	assert.equal(navigate(p, 'a4', 'right'), 'a4');
});

test('the box verb is varied, but stable for a box and its history length', () => {
	const row = (id: string): string => all(layoutPanel(run([spawn(id, {subagent_type: 'W'})]), {columns: 81, rows: 40, scrub, corner: '◳'}).rows);
	assert.equal(row('a'), row('a'));
	assert.match(row('a'), /◳ [A-Z][a-z]+…/);
	const verbs = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => row(id).match(/◳ ([A-Z][a-z]+)…/)?.[1]));
	assert.ok(verbs.size > 1);
});
