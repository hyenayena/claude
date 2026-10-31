import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEvent, UiEvent} from '../../src/chat/events.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {stringCells, type SpanRow} from '../../src/kit.js';
import {layoutPanel, PANEL} from '../../src/ui/agent-panel.js';
import {AGENTS_CAPS, initialAgents, reduceAgents, type AgentsState} from '../../src/ui/agents.js';

const scrub = makeScrub(s => s);
const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});
const spawn = (id: string, input: Record<string, unknown> = {}): ChatEvent => ui({kind: 'tool-use', toolUseId: id, name: 'Agent', input});
const run = (events: ChatEvent[], from: AgentsState = initialAgents()): AgentsState => events.reduce(reduceAgents, from);
const text = (row: SpanRow): string => row.map(s => s.text).join('');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]');

test('hostile names, models and one-liners never leak control characters or overflow at any width', () => {
	const evil = `\u001b[31mred\u001b]0;title\u0007 日本語😀‮\r\n\t${'W'.repeat(300)}`;
	let s = run([
		spawn('p', {name: evil, subagent_type: evil, model: evil, description: evil, prompt: evil}),
		ui({kind: 'agent-message', agentId: 'p', model: evil, items: [{type: 'text', text: evil}, {type: 'tool-use', toolUseId: 'c', name: evil, input: {file_path: evil, command: evil}}]}),
		ui({kind: 'agent-message', agentId: 'p', items: [{type: 'tool-use', toolUseId: 'n', name: 'Agent', input: {name: evil, prompt: 'x'}}]}),
		spawn('q', {name: '😀'.repeat(40)}),
	]);
	s = reduceAgents(s, ui({kind: 'tool-result', toolUseId: 'q', isError: true, text: evil}));
	for (let columns = 2; columns <= 140; columns++) {
		for (const rows of [0, 1, 11, 12, 13, 24, 50]) {
			const p = layoutPanel(s, {columns, rows, scrub});
			assert.ok(p.height <= Math.floor(rows * PANEL.share));
			for (const row of p.rows) {
				const t = text(row);
				assert.ok(!CONTROL.test(t), `${columns}/${rows}: ${JSON.stringify(t)}`);
				assert.ok(!t.includes('‮'));
				assert.ok(stringCells(t) <= columns - 1, `${columns}/${rows}: ${stringCells(t)}`);
			}
		}
	}
});

test('a tool call result that never matches a call is dropped without growing the pending map', () => {
	let s = run([spawn('a')]);
	for (let i = 0; i < 500; i++) {
		s = reduceAgents(s, ui({kind: 'agent-message', agentId: 'a', items: [{type: 'tool-result', toolUseId: `x${i}`, isError: false, text: 'r'}]}));
	}
	assert.equal(s.boxes.get('a')!.history.length, 0);
	assert.equal(s.boxes.get('a')!.pending.size, 0);
});

test('pending tool calls are capped', () => {
	let s = run([spawn('a')]);
	for (let i = 0; i < 200; i++) {
		s = reduceAgents(s, ui({kind: 'agent-message', agentId: 'a', items: [{type: 'tool-use', toolUseId: `t${i}`, name: 'Read', input: {file_path: 'f'}}]}));
	}
	assert.ok(s.boxes.get('a')!.pending.size <= AGENTS_CAPS.pending);
	assert.ok(s.boxes.get('a')!.history.length <= AGENTS_CAPS.entries);
});

test('a mid-turn interrupt stops foreground boxes but leaves finished ones alone', () => {
	let s = run([{type: 'state', state: 'running'}, spawn('a'), spawn('b'), ui({kind: 'tool-result', toolUseId: 'a', isError: false, text: 'ok'})]);
	s = reduceAgents(s, {type: 'turn-end', outcome: 'interrupted'} as ChatEvent);
	assert.equal(s.boxes.get('a')!.status, 'completed');
	assert.equal(s.boxes.get('b')!.status, 'stopped');
});
