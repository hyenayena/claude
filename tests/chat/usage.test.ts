import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UsageMeter, usageLines} from '../../src/chat/usage.js';

const msg = (id: string, usage: object, parent: string | null = null) => ({type: 'assistant', parent_tool_use_id: parent, message: {id, usage, content: []}});

test('usage adds each API call once, the main chat and subagents apart', () => {
	const m = new UsageMeter();
	const u = {input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50};
	m.add(msg('a', u));
	m.add(msg('a', u));
	m.add(msg('b', {...u, output_tokens: -3, cache_read_input_tokens: 'x'}));
	m.add(msg('c', u, 'toolu_1'));
	m.add({type: 'user', message: {usage: u}});
	m.add({type: 'assistant', message: {id: 'd'}});
	assert.deepEqual(m.total.main, {calls: 2, input: 4, cacheWrite: 200, cacheRead: 1000, output: 50});
	assert.deepEqual(m.total.agents, {calls: 1, input: 2, cacheWrite: 100, cacheRead: 1000, output: 50});
	assert.deepEqual(usageLines(m.total), [
		'main: 2 calls, context 1.2k (cache write 200), output 50',
		'agents: 1 calls, context 1.1k (cache write 100), output 50',
	]);
});
