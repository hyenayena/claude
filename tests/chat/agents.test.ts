import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentDenial} from '../../src/chat/agent-policy.js';
import type {AgentItem, UiEvent} from '../../src/chat/events.js';
import {AGENT_ITEMS_CAP, AGENT_RESULT_CAP, AGENT_TEXT_CAP, AGENT_TOTAL_CAP, normalize} from '../../src/chat/normalize.js';
import {POLICY_DENY} from '../../src/chat/permission.js';
import {DISALLOWED_TOOLS} from '../../src/policy.js';
import {toolHeader, toolRunningText} from '../../src/ui/present.js';
import {initialTranscript, reduceTranscript} from '../../src/ui/transcript.js';

const id = (s: string) => s;

test('agents run in place (foreground or background); other tools are not judged here', () => {
	assert.equal(agentDenial('Agent', {subagent_type: 'coder', prompt: 'x'}), undefined);
	assert.equal(agentDenial('SendMessage', {to: 'a1', message: 'go on'}), undefined);
	assert.equal(agentDenial('Agent', {prompt: 'x', run_in_background: true}), undefined, 'background agents are allowed');
	assert.equal(agentDenial('Task', {prompt: 'x', isolation: 'worktree'}), POLICY_DENY.isolation);
	assert.equal(agentDenial('Agent', {prompt: 'x', isolation: 'remote'}), POLICY_DENY.isolation);
	assert.equal(agentDenial('Bash', {run_in_background: true}), undefined);
});

test('claude ask stays read-only: agents remain disallowed there', () => {
	for (const t of ['Agent', 'Task']) assert.ok(DISALLOWED_TOOLS.includes(t), t);
});

test('subagent assistant messages become agent-message events with text, thinking, tool calls and the model', () => {
	const evs = normalize({
		type: 'assistant',
		parent_tool_use_id: 'agent-1',
		message: {
			model: 'claude-haiku-4-5-20251001',
			content: [
				{type: 'thinking', thinking: 'hmm'},
				{type: 'thinking', thinking: '   '},
				{type: 'text', text: 'Looking'},
				{type: 'tool_use', id: 't9', name: 'Read', input: {file_path: '/app/x.ts'}},
				{type: 'tool_use', name: 'NoId', input: {}},
			],
		},
	} as never);
	assert.deepEqual(evs, [
		{
			kind: 'agent-message',
			agentId: 'agent-1',
			model: 'claude-haiku-4-5-20251001',
			items: [
				{type: 'thinking', text: 'hmm'},
				{type: 'text', text: 'Looking'},
				{type: 'tool-use', toolUseId: 't9', name: 'Read', input: {file_path: '/app/x.ts'}},
			],
		},
	]);
	assert.deepEqual(normalize({type: 'assistant', parent_tool_use_id: 'agent-1', message: {content: []}} as never), [], 'no items, no event');
});

test('a subagent API error becomes a text item', () => {
	const evs = normalize({type: 'assistant', parent_tool_use_id: 'a', error: 'rate_limit', message: {content: [{type: 'text', text: 'slow down'}]}} as never);
	assert.deepEqual(evs, [{kind: 'agent-message', agentId: 'a', items: [{type: 'text', text: 'API error (rate_limit): slow down'}]}]);
});

test('subagent tool results carry a capped text and the patch of a single result', () => {
	const patch = {structuredPatch: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]};
	const one = normalize({
		type: 'user',
		parent_tool_use_id: 'agent-1',
		tool_use_result: patch,
		message: {content: [{type: 'tool_result', tool_use_id: 't9', content: 'x'.repeat(20_000), is_error: true}]},
	} as never);
	assert.equal(one.length, 1);
	const msg = one[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	assert.equal(msg.kind, 'agent-message');
	assert.equal(msg.model, undefined);
	const item = msg.items[0] as Extract<AgentItem, {type: 'tool-result'}>;
	assert.equal(item.text.length, AGENT_RESULT_CAP);
	assert.equal(item.isError, true);
	assert.deepEqual(item.patch, {hunks: [{oldStart: 1, newStart: 1, lines: ['-a', '+b']}]});
	const two = normalize({
		type: 'user',
		parent_tool_use_id: 'agent-1',
		tool_use_result: patch,
		message: {content: [{type: 'tool_result', tool_use_id: 'a', content: 'x'}, {type: 'tool_result', tool_use_id: 'b', content: [{type: 'text', text: 'y'}]}]},
	} as never)[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	assert.deepEqual(two.items, [
		{type: 'tool-result', toolUseId: 'a', isError: false, text: 'x'},
		{type: 'tool-result', toolUseId: 'b', isError: false, text: 'y'},
	]);
});

test('the subagent prompt echo and non-message subagent output are skipped', () => {
	assert.deepEqual(normalize({type: 'user', parent_tool_use_id: 'agent-1', message: {content: [{type: 'text', text: 'the prompt'}]}} as never), []);
	assert.deepEqual(normalize({type: 'user', parent_tool_use_id: 'agent-1', message: {content: 'the prompt'}} as never), []);
	assert.deepEqual(normalize({type: 'stream_event', parent_tool_use_id: 'agent-1', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'x'}}} as never), []);
	assert.deepEqual(normalize({type: 'system', subtype: 'status', status: null, parent_tool_use_id: 'agent-1'} as never), []);
	assert.deepEqual(normalize({type: 'result', subtype: 'success', parent_tool_use_id: 'agent-1'} as never), []);
});

test('subagent items are capped in count, per item and in total', () => {
	const many = normalize({
		type: 'assistant',
		parent_tool_use_id: 'a',
		message: {content: Array.from({length: 100}, (_, i) => ({type: 'text', text: `t${i}`}))},
	} as never)[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	assert.equal(many.items.length, AGENT_ITEMS_CAP);
	assert.deepEqual(many.items.at(-1), {type: 'text', text: '… 37 more items'});
	const exact = normalize({
		type: 'assistant',
		parent_tool_use_id: 'a',
		message: {content: Array.from({length: AGENT_ITEMS_CAP}, (_, i) => ({type: 'text', text: `t${i}`}))},
	} as never)[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	assert.deepEqual(exact.items.at(-1), {type: 'text', text: `t${AGENT_ITEMS_CAP - 1}`}, 'exactly the cap is kept whole');
	const big = normalize({
		type: 'assistant',
		parent_tool_use_id: 'a',
		message: {content: Array.from({length: 12}, () => ({type: 'text', text: 'x'.repeat(100_000)}))},
	} as never)[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	for (const it of big.items.slice(0, -1)) assert.equal((it as {text: string}).text.length, AGENT_TEXT_CAP);
	assert.match((big.items.at(-1) as {text: string}).text, /^… \d+ more items$/);
	assert.ok(Buffer.byteLength(JSON.stringify(big)) < AGENT_TOTAL_CAP + 1024);
	const write = normalize({
		type: 'assistant',
		parent_tool_use_id: 'a',
		message: {content: [{type: 'tool_use', id: 'w', name: 'Write', input: {file_path: '/f', content: 'y'.repeat(200_000), nested: {a: 1}}}]},
	} as never)[0] as Extract<UiEvent, {kind: 'agent-message'}>;
	assert.deepEqual(write.items[0], {type: 'tool-use', toolUseId: 'w', name: 'Write', input: {file_path: '/f', content: 'y'.repeat(1024)}});
});

test('the running Agent line names the subagent and shows what it is doing', () => {
	let s = initialTranscript({model: undefined, sessionId: undefined, mode: 'default', pending: 0});
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'tool-use', toolUseId: 'a1', name: 'Agent', input: {subagent_type: 'coder', description: 'Fix build'}}}).state;
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'agent-activity', toolUseId: 'a1', name: 'Edit', input: {file_path: '/app/src/x.ts'}}}).state;
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'agent-activity', toolUseId: 'nope', name: 'Read', input: {}}}).state;
	const tool = s.tools.get('a1')!;
	assert.equal(toolRunningText(tool, id), 'Agent(coder: Fix build) → Edit(/app/src/x.ts)');
	s = reduceTranscript(s, {
		type: 'ui',
		event: {kind: 'agent-message', agentId: 'a1', items: [{type: 'tool-use', toolUseId: 'r', name: 'Read', input: {file_path: '/app/y.ts'}}, {type: 'text', text: 'x'}]},
	}).state;
	assert.equal(toolRunningText(s.tools.get('a1')!, id), 'Agent(coder: Fix build) → Read(/app/y.ts)', 'agent-message moves the activity too');
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'agent-message', agentId: 'a1', items: [{type: 'text', text: 'only text'}]}}).state;
	assert.equal(toolRunningText(s.tools.get('a1')!, id), 'Agent(coder: Fix build) → Read(/app/y.ts)', 'text keeps the last tool');
	assert.equal(toolHeader('SendMessage', {to: 'a1', message: 'continue'}, id), 'SendMessage(a1)');
});
