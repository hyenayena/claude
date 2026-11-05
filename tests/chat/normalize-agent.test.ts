import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {AGENT_ITEMS_CAP, AGENT_TOTAL_CAP, normalize} from '../../src/chat/normalize.js';
import {MAX_FRAME_BYTES, createDecoder, encodeFrame} from '../../src/runner/protocol.js';

const sdk = (m: Record<string, unknown>): SDKMessage => m as unknown as SDKMessage;
const assistant = (parent: unknown, content: unknown[], extra: Record<string, unknown> = {}) =>
	sdk({type: 'assistant', parent_tool_use_id: parent, message: {model: 'claude-sonnet-4-6', content}, ...extra});

test('subagent messages with a malformed parent id or content produce nothing', () => {
	assert.deepEqual(normalize(assistant(42, [{type: 'text', text: 'x'}])), []);
	assert.deepEqual(normalize(assistant('p'.repeat(300), [{type: 'text', text: 'x'}])), []);
	assert.deepEqual(normalize(sdk({type: 'assistant', parent_tool_use_id: 'p', message: 'nope'})), []);
	assert.deepEqual(normalize(sdk({type: 'assistant', parent_tool_use_id: 'p', message: {content: [null, 5, {type: 'tool_use'}, {type: 'text', text: ''}]}})), []);
	assert.deepEqual(normalize(sdk({type: 'result', parent_tool_use_id: 'p'})), []);
});

test('agent_id becomes taskId; an over-long or empty one is omitted', () => {
	const first = (extra: Record<string, unknown>) => {
		const [e] = normalize(assistant('p', [{type: 'text', text: 'x'}], extra));
		assert.equal(e?.kind, 'agent-message');
		return e as Extract<NonNullable<typeof e>, {kind: 'agent-message'}>;
	};
	assert.equal(first({agent_id: 'task-1'}).taskId, 'task-1');
	assert.equal('taskId' in first({agent_id: 't'.repeat(257)}), false);
	assert.equal('taskId' in first({agent_id: ''}), false);
	assert.equal('taskId' in first({agent_id: 5}), false);
	assert.equal('taskId' in first({}), false);
});

test('an oversized subagent message is capped by items and bytes and still fits a runner frame', () => {
	const many = Array.from({length: 500}, (_, i) => ({type: 'tool_use', id: `t${i}`, name: 'Read', input: {file_path: `f${i}`}}));
	const [a] = normalize(assistant('p', many));
	assert.equal(a?.kind, 'agent-message');
	if (a?.kind !== 'agent-message') return;
	assert.ok(a.items.length <= AGENT_ITEMS_CAP);

	const huge = Array.from({length: 40}, () => ({type: 'text', text: 'é'.repeat(60 * 1024)}));
	const [b] = normalize(assistant('p', huge));
	assert.ok(b?.kind === 'agent-message' && Buffer.byteLength(JSON.stringify(b)) <= AGENT_TOTAL_CAP + 4096);

	const big = {content: 'x'.repeat(5_000_000), nested: {a: 1}, path: 'p'.repeat(5000)};
	const [c] = normalize(assistant('p', [{type: 'tool_use', id: 't', name: 'Write', input: big}]));
	const line = encodeFrame({v: 1, type: 'event', event: {type: 'ui', event: c!}});
	assert.ok(Buffer.byteLength(line) < MAX_FRAME_BYTES);
	assert.equal(createDecoder('toClient').push(line)[0]?.type, 'event');
});

test('a result of a subagent keeps its patch only when it answers a single call', () => {
	const result = (ids: string[]) =>
		normalize(
			sdk({
				type: 'user',
				parent_tool_use_id: 'p',
				message: {content: ids.map(id => ({type: 'tool_result', tool_use_id: id, content: 'ok'}))},
				tool_use_result: {structuredPatch: [{oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, lines: ['-a', '+b']}], filePath: '/f'},
			}),
		);
	const [one] = result(['t1']);
	const [two] = result(['t1', 't2']);
	assert.ok(one?.kind === 'agent-message' && one.items.every(i => i.type === 'tool-result' && i.patch !== undefined));
	assert.ok(two?.kind === 'agent-message' && two.items.every(i => i.type === 'tool-result' && i.patch === undefined));
});
