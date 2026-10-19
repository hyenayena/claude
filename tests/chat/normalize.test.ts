import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {normalize} from '../../src/chat/normalize.js';

const n = (m: unknown) => normalize(m as SDKMessage);

test('system init becomes session', () => {
	assert.deepEqual(n({type: 'system', subtype: 'init', session_id: 's1', model: 'm', apiKeySource: 'env'}), [
		{kind: 'session', sessionId: 's1', model: 'm', apiKeySource: 'env'},
	]);
	assert.deepEqual(n({type: 'system', subtype: 'init'}), []);
});

test('system status and api_retry', () => {
	assert.deepEqual(n({type: 'system', subtype: 'status', status: 'requesting'}), [{kind: 'status', status: 'requesting'}]);
	assert.deepEqual(n({type: 'system', subtype: 'status', status: null}), [{kind: 'status', status: null}]);
	assert.deepEqual(
		n({type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 500, error_status: 529, error: 'overloaded'}),
		[{kind: 'retry', attempt: 1, maxRetries: 5, delayMs: 500, errorCode: 'overloaded'}],
	);
});

test('stream events: only text_delta and thinking start map', () => {
	const ev = (event: unknown) => n({type: 'stream_event', event, parent_tool_use_id: null});
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'hi'}}), [{kind: 'text-delta', text: 'hi'}]);
	assert.deepEqual(ev({type: 'content_block_start', index: 0, content_block: {type: 'thinking'}}), [{kind: 'thinking'}]);
	assert.deepEqual(ev({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}), []);
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'x'}}), []);
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{'}}), []);
	for (const type of ['content_block_stop', 'message_start', 'message_delta', 'message_stop']) assert.deepEqual(ev({type}), []);
});

test('assistant text, tool_use, thinking and aborted', () => {
	const msg = (content: unknown[], extra: object = {}) => ({
		type: 'assistant',
		parent_tool_use_id: null,
		uuid: 'u',
		message: {id: 'msg_1', content},
		...extra,
	});
	assert.deepEqual(n(msg([{type: 'text', text: 'hello'}])), [{kind: 'text', messageId: 'msg_1', text: 'hello'}]);
	assert.deepEqual(n(msg([{type: 'text', text: 'hel'}], {aborted: true})), [{kind: 'text', messageId: 'msg_1', text: 'hel', aborted: true}]);
	assert.deepEqual(n(msg([{type: 'tool_use', id: 't1', name: 'Read', input: {file_path: '/a'}}])), [
		{kind: 'tool-use', toolUseId: 't1', name: 'Read', input: {file_path: '/a'}},
	]);
	assert.deepEqual(n(msg([{type: 'thinking', thinking: 'a thought'}])), [{kind: 'thinking-text', text: 'a thought'}]);
	assert.deepEqual(n(msg([{type: 'thinking', thinking: '  '}])), []);
});

test('assistant error emits api-error and drops the text', () => {
	assert.deepEqual(
		n({
			type: 'assistant',
			error: 'authentication_failed',
			message: {id: 'm', content: [{type: 'text', text: 'Please run /login'}]},
			parent_tool_use_id: null,
		}),
		[{kind: 'api-error', code: 'authentication_failed'}],
	);
});

test('user tool_result: string, text array, image, is_error, cap', () => {
	const res = (content: unknown, extra: object = {}) =>
		n({type: 'user', parent_tool_use_id: null, message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content, ...extra}]}, tool_use_result: {raw: 'ignored'}});
	assert.deepEqual(res('out'), [{kind: 'tool-result', toolUseId: 't1', isError: false, text: 'out'}]);
	assert.deepEqual(res([{type: 'text', text: 'a'}, {type: 'text', text: 'b'}]), [{kind: 'tool-result', toolUseId: 't1', isError: false, text: 'a\nb'}]);
	assert.deepEqual(res([{type: 'image', source: {}}]), [{kind: 'tool-result', toolUseId: 't1', isError: false, text: '[image]'}]);
	assert.deepEqual(res('bad', {is_error: true}), [{kind: 'tool-result', toolUseId: 't1', isError: true, text: 'bad'}]);
	const big = res('x'.repeat(200_000))[0];
	assert.equal(big?.kind === 'tool-result' && big.text.length, 65536);
});

test('user message with plain text content yields nothing', () => {
	assert.deepEqual(n({type: 'user', parent_tool_use_id: null, message: {role: 'user', content: 'hi'}}), []);
});

test('tool_progress', () => {
	assert.deepEqual(n({type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', elapsed_time_seconds: 3, parent_tool_use_id: null}), [
		{kind: 'tool-progress', toolUseId: 't1', name: 'Bash', elapsedSeconds: 3},
	]);
});

test('result variants', () => {
	assert.deepEqual(
		n({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', total_cost_usd: 0.5, num_turns: 2, terminal_reason: 'completed'}),
		[{kind: 'result', ok: true, subtype: 'success', text: 'done', sessionId: 's', costUsd: 0.5, numTurns: 2, terminalReason: 'completed'}],
	);
	const authFail = n({type: 'result', subtype: 'success', is_error: true, result: 'Not logged in', session_id: 's'})[0];
	assert.equal(authFail?.kind === 'result' && authFail.ok, false);
	assert.deepEqual(n({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: x'], session_id: 's'}), [
		{kind: 'result', ok: false, subtype: 'error_during_execution', errors: ['No conversation found with session ID: x'], sessionId: 's'},
	]);
	const max = n({type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 's'})[0];
	assert.equal(max?.kind === 'result' && max.subtype, 'error_max_turns');
});

test('unknown types, subtypes and sub-agent messages are ignored', () => {
	assert.deepEqual(n({type: 'rate_limit_event'}), []);
	assert.deepEqual(n({type: 'permission_denied'}), []);
	assert.deepEqual(n({type: 'system', subtype: 'hook_started'}), []);
	assert.deepEqual(n({type: 'brand_new'}), []);
	assert.deepEqual(n(null), []);
	assert.deepEqual(n({type: 'assistant', parent_tool_use_id: 'tool1', message: {id: 'm', content: [{type: 'text', text: 'sub'}]}}), []);
	assert.deepEqual(n({type: 'stream_event', parent_tool_use_id: 'tool1', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'x'}}}), []);
});
