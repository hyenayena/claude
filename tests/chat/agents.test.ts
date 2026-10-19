import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentDenial} from '../../src/chat/agent-policy.js';
import {normalize} from '../../src/chat/normalize.js';
import {POLICY_DENY} from '../../src/chat/permission.js';
import {DISALLOWED_TOOLS} from '../../src/policy.js';
import {toolHeader, toolRunningText} from '../../src/ui/present.js';
import {initialTranscript, reduceTranscript} from '../../src/ui/transcript.js';

const id = (s: string) => s;

test('agents run in the foreground and in place; other tools are not judged here', () => {
	assert.equal(agentDenial('Agent', {subagent_type: 'coder', prompt: 'x'}), undefined);
	assert.equal(agentDenial('SendMessage', {to: 'a1', message: 'go on'}), undefined);
	assert.equal(agentDenial('Agent', {prompt: 'x', run_in_background: true}), POLICY_DENY.background);
	assert.equal(agentDenial('Task', {prompt: 'x', isolation: 'worktree'}), POLICY_DENY.isolation);
	assert.equal(agentDenial('Agent', {prompt: 'x', isolation: 'remote'}), POLICY_DENY.isolation);
	assert.equal(agentDenial('Bash', {run_in_background: true}), undefined);
});

test('claude ask stays read-only: agents remain disallowed there', () => {
	for (const t of ['Agent', 'Task']) assert.ok(DISALLOWED_TOOLS.includes(t), t);
});

test('a subagent tool call becomes activity on its Agent call; other subagent messages are dropped', () => {
	const evs = normalize({
		type: 'assistant',
		parent_tool_use_id: 'agent-1',
		message: {content: [{type: 'text', text: 'hidden'}, {type: 'tool_use', id: 't9', name: 'Read', input: {file_path: '/app/x.ts'}}]},
	} as never);
	assert.deepEqual(evs, [{kind: 'agent-activity', toolUseId: 'agent-1', name: 'Read', input: {file_path: '/app/x.ts'}}]);
	assert.deepEqual(normalize({type: 'assistant', parent_tool_use_id: 'agent-1', message: {content: [{type: 'text', text: 'x'}]}} as never), []);
	assert.deepEqual(normalize({type: 'user', parent_tool_use_id: 'agent-1', message: {content: []}} as never), []);
});

test('the running Agent line names the subagent and shows what it is doing', () => {
	let s = initialTranscript({model: undefined, sessionId: undefined, mode: 'default', pending: 0});
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'tool-use', toolUseId: 'a1', name: 'Agent', input: {subagent_type: 'coder', description: 'Fix build'}}}).state;
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'agent-activity', toolUseId: 'a1', name: 'Edit', input: {file_path: '/app/src/x.ts'}}}).state;
	s = reduceTranscript(s, {type: 'ui', event: {kind: 'agent-activity', toolUseId: 'nope', name: 'Read', input: {}}}).state;
	const tool = s.tools.get('a1')!;
	assert.equal(toolRunningText(tool, id), 'Agent(coder: Fix build) → Edit(/app/src/x.ts)');
	assert.equal(toolHeader('SendMessage', {to: 'a1', message: 'continue'}, id), 'SendMessage(a1)');
});
