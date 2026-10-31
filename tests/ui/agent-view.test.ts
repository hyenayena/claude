import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ChatEvent} from '../../src/chat/events.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {stringCells} from '../../src/kit.js';
import {agentViewLines} from '../../src/ui/agent-view.js';
import {AGENTS_CAPS, initialAgents, reduceAgents, type AgentBox} from '../../src/ui/agents.js';

const SECRET = 'sk-ant-oat-VIEWSECRET0123456789abcdef';
const scrub = makeScrub(s => s.split(SECRET).join('[redacted]'));
const ESC = '\u001b';
const plain = (s: string): string => s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');

const boxOf = (events: ChatEvent[]): AgentBox => events.reduce(reduceAgents, initialAgents()).boxes.get('a')!;
const spawn: ChatEvent = {type: 'ui', event: {kind: 'tool-use', toolUseId: 'a', name: 'Agent', input: {prompt: `Check ${SECRET}`, subagent_type: 'Explore'}}};

test('the subagent view shows the prompt, every entry and the final report', () => {
	const patch = {hunks: [{oldStart: 1, newStart: 1, lines: ['-old', '+new']}]};
	const box = boxOf([
		spawn,
		{
			type: 'ui',
			event: {
				kind: 'agent-message',
				agentId: 'a',
				items: [
					{type: 'thinking', text: 'pondering'},
					{type: 'text', text: 'I will edit'},
					{type: 'tool-use', toolUseId: 'e', name: 'Edit', input: {file_path: '/x.ts', old_string: 'old', new_string: 'new'}},
					{type: 'tool-use', toolUseId: 'r', name: 'Read', input: {file_path: '/y.ts'}},
				],
			},
		},
		{type: 'ui', event: {kind: 'agent-message', agentId: 'a', items: [{type: 'tool-result', toolUseId: 'e', isError: false, text: 'ok', patch}]}},
		{type: 'ui', event: {kind: 'tool-result', toolUseId: 'a', isError: false, text: `Final report ${SECRET}`}},
	]);
	const lines = agentViewLines(box, scrub, scrub, 80).map(plain);
	const out = lines.join('\n');
	assert.match(lines[0]!, /^ > Check \[redacted\]/);
	assert.match(out, /Thinking/);
	assert.match(out, /pondering/);
	assert.match(out, /I will edit/);
	assert.match(out, /Edit\(\/x\.ts\)/);
	assert.match(out, /old/);
	assert.match(out, /\bnew\b/);
	assert.match(out, /Read\(\/y\.ts\)/);
	assert.match(out, /Final report \[redacted\]/);
	assert.ok(!out.includes(SECRET));
	for (const l of lines) assert.ok(stringCells(l) <= 80, l);
});

test('the report is not repeated when it equals the last message', () => {
	const box = boxOf([
		spawn,
		{type: 'ui', event: {kind: 'agent-message', agentId: 'a', items: [{type: 'text', text: 'Done here'}]}},
		{type: 'ui', event: {kind: 'tool-result', toolUseId: 'a', isError: false, text: 'Done here'}},
	]);
	const out = agentViewLines(box, scrub, scrub, 60).map(plain).join('\n');
	assert.equal(out.split('Done here').length, 2);
});

test('dropped entries are counted and control characters never reach the view', () => {
	let s = [spawn].reduce(reduceAgents, initialAgents());
	for (let i = 0; i < AGENTS_CAPS.entries + 3; i++) {
		s = reduceAgents(s, {type: 'ui', event: {kind: 'agent-message', agentId: 'a', items: [{type: 'text', text: `m${i} ${ESC}]52;c;ZXZpbA==\u0007`}]}});
	}
	const lines = agentViewLines(s.boxes.get('a')!, scrub, scrub, 40);
	const out = lines.map(plain).join('\n');
	assert.match(out, /… 3 earlier messages/);
	assert.ok(!out.includes('\u0007'));
	assert.ok(!out.includes(`${ESC}]`));
	assert.equal(agentViewLines(s.boxes.get('a')!, scrub, scrub, 40), lines, 'cached per width and history length');
});
