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

test('stream events: text, thinking start and tool input map', () => {
	const ev = (event: unknown) => n({type: 'stream_event', event, parent_tool_use_id: null});
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'hi'}}), [{kind: 'text-delta', text: 'hi'}]);
	assert.deepEqual(ev({type: 'content_block_start', index: 0, content_block: {type: 'thinking'}}), [{kind: 'thinking'}]);
	assert.deepEqual(ev({type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}), []);
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'x'}}), []);
	assert.deepEqual(ev({type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{'}}), [{kind: 'tool-input-delta', chars: 1}]);
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

test('assistant error emits api-error with the CLI text as detail only', () => {
	assert.deepEqual(
		n({
			type: 'assistant',
			error: 'authentication_failed',
			message: {id: 'm', content: [{type: 'text', text: 'Please run /login'}]},
			parent_tool_use_id: null,
		}),
		[{kind: 'api-error', code: 'authentication_failed', detail: 'Please run /login'}],
	);
	assert.deepEqual(n({type: 'assistant', error: 'rate_limit', message: {content: []}}), [{kind: 'api-error', code: 'rate_limit'}]);
	const long = n({type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: 'x'.repeat(500)}]}})[0];
	assert.equal(long?.kind === 'api-error' && long.detail?.length, 300);
});

test('rate_limit_event becomes rate-limit when the info parses', () => {
	const resetsAt = Math.floor(Date.now() / 1000) + 3600;
	assert.deepEqual(
		n({type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt, rateLimitType: 'five_hour', utilization: 1}}),
		[{kind: 'rate-limit', info: {status: 'rejected', resetsAt, type: 'five_hour', utilization: 1}}],
	);
	assert.deepEqual(n({type: 'rate_limit_event', rate_limit_info: {status: 'bogus'}}), []);
	assert.deepEqual(n({type: 'rate_limit_event', rate_limit_info: 5}), []);
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
	assert.deepEqual(n({type: 'result', subtype: 'success', is_error: false, session_id: 's', queued_turn_count: 2}), [
		{kind: 'result', ok: true, subtype: 'success', sessionId: 's', queuedTurns: 2},
	]);
	assert.deepEqual(n({type: 'result', subtype: 'success', is_error: false, session_id: 's', queued_turn_count: 0}), [{kind: 'result', ok: true, subtype: 'success', sessionId: 's'}]);
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

test('rate_limit_event validates resetsAt against the injected clock', () => {
	const FAR = 4_000_000_000;
	const clock = {now: () => FAR * 1000};
	const raw = {type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: FAR + 600}};
	assert.deepEqual(normalize(raw as SDKMessage, clock), [{kind: 'rate-limit', info: {status: 'rejected', resetsAt: FAR + 600}}]);
	assert.deepEqual(n(raw), [{kind: 'rate-limit', info: {status: 'rejected'}}]);
});

test('task_started carries tool_use_id and task_type', () => {
	assert.deepEqual(
		n({type: 'system', subtype: 'task_started', task_id: 'bx1', tool_use_id: 'tu1', task_type: 'local_bash', is_backgrounded: false, description: 'sleep'}),
		[{kind: 'task', id: 'bx1', status: 'running', description: 'sleep', toolUseId: 'tu1', taskType: 'local_bash'}],
	);
});

test('session state and thinking token reports', () => {
	assert.deepEqual(normalize({type: 'system', subtype: 'session_state_changed', state: 'running'} as never), [{kind: 'cli-state', state: 'running'}]);
	assert.deepEqual(normalize({type: 'system', subtype: 'session_state_changed', state: 'weird'} as never), []);
	assert.deepEqual(normalize({type: 'system', subtype: 'thinking_tokens', estimated_tokens: 227, estimated_tokens_delta: 177} as never), [
		{kind: 'thinking-tokens', tokens: 227},
	]);
});

test('tool input streaming', () => {
	const ev = (event: unknown) => normalize({type: 'stream_event', event, parent_tool_use_id: null} as never);
	assert.deepEqual(ev({type: 'content_block_start', content_block: {type: 'tool_use', name: 'Edit', id: 't'}}), [{kind: 'tool-input', name: 'Edit'}]);
	assert.deepEqual(ev({type: 'content_block_delta', delta: {type: 'input_json_delta', partial_json: '{"a":'}}), [{kind: 'tool-input-delta', chars: 5}]);
	assert.deepEqual(ev({type: 'content_block_delta', delta: {type: 'input_json_delta', partial_json: ''}}), []);
});

test('user tool_result carries a checked copy of the structured patch', () => {
	const user = (tool_use_result: unknown, count = 1) =>
		n({
			type: 'user',
			parent_tool_use_id: null,
			message: {role: 'user', content: Array.from({length: count}, (_, i) => ({type: 'tool_result', tool_use_id: `t${i}`, content: 'ok'}))},
			tool_use_result,
		});
	const hunk = {oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: [' a', '-b', '+c', '+d']};
	const [ev] = user({filePath: '/a', originalFile: 'SECRET', oldString: 'b', newString: 'c\nd', structuredPatch: [hunk], gitDiff: 'x'});
	assert.deepEqual(ev, {
		kind: 'tool-result',
		toolUseId: 't0',
		isError: false,
		text: 'ok',
		patch: {hunks: [{oldStart: 3, newStart: 3, lines: [' a', '-b', '+c', '+d']}]},
	});
	assert.ok(!JSON.stringify(ev).includes('SECRET'));

	const [created] = user({type: 'create', filePath: '/n', content: 'SECRET', structuredPatch: []});
	assert.deepEqual(created && created.kind === 'tool-result' && created.patch, {hunks: [], created: true});
	assert.ok(!JSON.stringify(created).includes('SECRET'));

	const none = (v: unknown, count = 1) => user(v, count).every(e => e.kind === 'tool-result' && e.patch === undefined);
	assert.ok(none({structuredPatch: [hunk]}, 2));
	assert.ok(none({structuredPatch: [hunk], staged: true}));
	assert.ok(none({structuredPatch: 'x'}));
	assert.ok(none('x'));
	assert.ok(none({structuredPatch: [{...hunk, oldStart: -1}]}));
	assert.ok(none({structuredPatch: [{...hunk, newStart: 1.5}]}));
	assert.ok(none({structuredPatch: [{...hunk, lines: [' a', 3]}]}));
	assert.ok(none({structuredPatch: Array.from({length: 201}, () => ({oldStart: 1, newStart: 1, lines: []}))}));
	assert.ok(none({structuredPatch: [{oldStart: 1, newStart: 1, lines: Array.from({length: 2001}, () => '+x')}]}));
	assert.ok(none({structuredPatch: [{oldStart: 1, newStart: 1, lines: ['+' + 'x'.repeat(20_000)]}]}));
	assert.ok(none({structuredPatch: [{oldStart: 1, newStart: 1, lines: Array.from({length: 20}, () => '+' + 'x'.repeat(15_000))}]}));
});

test('a patch at the engine caps with escape-heavy text still fits in a runner frame', async () => {
	const {encodeFrame, createDecoder, MAX_FRAME_BYTES} = await import('../../src/runner/protocol.js');
	// About 120 encoded bytes per line: 2000 lines stay just under the engine's 256 KiB, so every body is accepted.
	for (const body of ['\u0001'.repeat(20), '界'.repeat(40), '"\\'.repeat(30), 'x'.repeat(120)]) {
		const lines = Array.from({length: 2000}, () => `+${body}`);
		const events = n({
			type: 'user',
			message: {content: [{type: 'tool_result', tool_use_id: 't', content: 'ok'}]},
			tool_use_result: {structuredPatch: [{oldStart: 1, newStart: 1, lines}]},
		});
		const ev = events[0] as {patch?: unknown};
		assert.notEqual(ev?.patch, undefined, 'the engine accepts a patch at its caps');
		const frame = {v: 1, type: 'event', event: {type: 'ui', event: ev}} as never;
		const encoded = encodeFrame(frame);
		assert.ok(Buffer.byteLength(encoded) <= MAX_FRAME_BYTES);
		assert.equal((createDecoder('toClient').push(encoded)).length, 1);
	}
});

test('an Edit result without a patch field yields no patch', () => {
	const events = n({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: 't', content: 'ok'}]}});
	assert.ok(events.every(e => !('patch' in e)));
});
