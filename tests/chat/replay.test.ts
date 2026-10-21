import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {ChatQueryFn} from '../../src/types.js';
import {ChatSession} from '../../src/chat/chat-session.js';
import type {ChatEvent, UiEvent} from '../../src/chat/events.js';
import {normalize} from '../../src/chat/normalize.js';

const messages = JSON.parse(
	readFileSync(new URL('../fixtures/real-two-turns.json', import.meta.url), 'utf8'),
) as Array<Record<string, unknown>>;

const turns: SDKMessage[][] = [];
for (const m of messages) {
	if (m['type'] === 'system' && m['subtype'] === 'init') turns.push([]);
	turns.at(-1)?.push(m as unknown as SDKMessage);
}

const collapse = (events: UiEvent[]): string[] => {
	const out: string[] = [];
	for (const e of events) {
		if (e.kind === 'text-delta' && out.at(-1) === 'text-delta') continue;
		out.push(e.kind);
	}
	return out;
};

test('the fixture holds two turns recorded from the real SDK', () => {
	assert.equal(turns.length, 2);
	assert.equal(JSON.stringify(messages).includes('sk-ant'), false);
});

test('normalize turns the real first turn into session, tool and text events', () => {
	const events = turns[0]!.flatMap(m => normalize(m));
	assert.deepEqual(collapse(events), [
		'session',
		'status',
		'tool-use',
		'tool-result',
		'status',
		'text-delta',
		'text',
		'result',
	]);
	const tool = events.find(e => e.kind === 'tool-use');
	assert.equal(tool?.kind === 'tool-use' && tool.name, 'Read');
});

test('streamed deltas add up to the complete text block', () => {
	for (const turn of turns) {
		const events = turn.flatMap(m => normalize(m));
		const deltas = events.flatMap(e => (e.kind === 'text-delta' ? [e.text] : [])).join('');
		const block = events.find(e => e.kind === 'text');
		assert.equal(block?.kind === 'text' && block.text, deltas);
	}
});

test('a chat session replays the recording turn by turn', async () => {
	let next = 0;
	const query: ChatQueryFn = p => {
		const gen = (async function* () {
			for await (const _ of p.prompt as AsyncIterable<SDKUserMessage>) {
				for (const m of turns[next++] ?? []) yield m;
			}
		})();
		return Object.assign(gen, {interrupt: async () => undefined, close: () => undefined});
	};
	const session = new ChatSession({
		query,
		buildOptions: () => ({}) as Options,
		redact: s => s,
	});
	const events: ChatEvent[] = [];
	session.subscribe(e => events.push(e));
	const ended = (): Promise<void> =>
		new Promise(resolve => {
			const off = session.subscribe(e => {
				if (e.type === 'turn-end') {
					off();
					resolve();
				}
			});
		});

	const first = ended();
	session.send('read package.json');
	await first;
	const second = ended();
	session.send('say OK');
	await second;

	const outcomes = events.flatMap(e => (e.type === 'turn-end' ? [e.outcome] : []));
	assert.deepEqual(outcomes, ['ok', 'ok']);
	assert.equal(session.model, 'claude-haiku-5-5');
	assert.equal(session.sessionId, (turns[0]![0] as unknown as {session_id: string}).session_id);
	assert.equal(session.state, 'idle');
	session.close();
});
