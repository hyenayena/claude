import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {SDKMessage} from '@anthropic-ai/claude-agent-sdk';
import {normalize} from '../../src/chat/normalize.js';
import {createShellWatch} from '../../src/chat/shell-watch.js';

const messages = JSON.parse(
	readFileSync(new URL('../fixtures/real-foreground-bash.json', import.meta.url), 'utf8'),
) as SDKMessage[];

test('a recorded foreground Bash call yields tool events but no task or progress events', () => {
	assert.equal(JSON.stringify(messages).includes('sk-ant'), false);
	const kinds = messages.flatMap(m => normalize(m)).map(e => e.kind);
	assert.ok(kinds.includes('tool-use'));
	assert.ok(kinds.includes('tool-result'));
	assert.equal(kinds.includes('task'), false);
	assert.equal(kinds.includes('tool-progress'), false);
	assert.equal(messages.some(m => m.type === 'system' && (m as {subtype?: string}).subtype === 'task_started'), false);
});

test('the recorded stream without task events still yields a running call bound from the file', async () => {
	const root = mkdtempSync(join(tmpdir(), 'shell-stream-'));
	const uid = process.getuid?.() ?? 0;
	let sessionId: string | undefined;
	const tasks = () => join(root, `claude-${uid}`, '-app', sessionId!, 'tasks');
	const watch = createShellWatch({root, sessionId: () => sessionId, scrub: s => s, pollMs: 10});
	const states: number[] = [];
	for (const m of messages) {
		for (const kind of normalize(m)) {
			if (kind.kind === 'session') sessionId = kind.sessionId;
			watch.feed({type: 'ui', event: kind});
			if (kind.kind === 'tool-use') {
				await new Promise(r => setTimeout(r, 40));
				mkdirSync(tasks(), {recursive: true});
				writeFileSync(join(tasks(), 'bfixture1.output'), 'line1\nline2\n');
				await new Promise(r => setTimeout(r, 100));
				states.push(watch.get().calls.length);
				assert.deepEqual(watch.get().calls[0]?.lines, ['line1', 'line2']);
				assert.equal(watch.get().calls[0]?.bound, 'file');
			}
		}
	}
	assert.deepEqual(states, [1]);
	assert.equal(watch.get().calls.length, 0);
	watch.close();
});
