import assert from 'node:assert/strict';
import {mkdir, mkdtemp, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {listSessions, readHistory} from '../../src/chat/history.js';

const A = '11111111-aaaa-4bbb-8ccc-222222222222';
const B = '33333333-aaaa-4bbb-8ccc-444444444444';
const C = '55555555-aaaa-4bbb-8ccc-666666666666';

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const user = (content: unknown, extra = {}) => ({type: 'user', message: {role: 'user', content}, ...extra});
const assistant = (id: string, text: string, extra = {}) => ({type: 'assistant', message: {id, content: [{type: 'text', text}]}, ...extra});

const setup = async () => {
	const configDir = await mkdtemp(join(tmpdir(), 'claude-history-'));
	const dir = join(configDir, 'projects', '-app');
	await mkdir(dir, {recursive: true});
	await writeFile(
		join(dir, `${A}.jsonl`),
		jsonl([
			user('fix the build'),
			assistant('m1', 'Looking'),
			{type: 'assistant', message: {id: 'm1', content: [{type: 'tool_use', name: 'Read'}]}},
			user([{type: 'tool_result', content: 'x'}]),
			assistant('m2', 'Fixed.'),
			user('injected', {isMeta: true}),
			user('side', {isSidechain: true}),
			{type: 'ai-title', aiTitle: 'Build fix'},
			user('thanks'),
		]),
	);
	await writeFile(join(dir, `${B}.jsonl`), jsonl([user('hello there\nsecond line'), assistant('m3', 'Hi!')]));
	await writeFile(join(dir, `${C}.jsonl`), jsonl([{type: 'ai-title', aiTitle: 'Empty'}]));
	await writeFile(join(dir, 'notes.jsonl'), 'x');
	await utimes(join(dir, `${A}.jsonl`), 1000, 1000);
	await utimes(join(dir, `${B}.jsonl`), 2000, 2000);
	return {configDir, dir};
};

test('listSessions lists sessions with prompts, newest first, titled by Claude Code or the first prompt', async () => {
	const {configDir} = await setup();
	const list = await listSessions(configDir, '/app');
	assert.deepEqual(
		list.map(s => [s.sessionId, s.title, s.prompts]),
		[
			[B, 'hello there', 1],
			[A, 'Build fix', 2],
		],
	);
	assert.deepEqual(await listSessions(configDir, '/elsewhere'), []);
	assert.equal((await listSessions(configDir, '/app', 1)).length, 1);
});

test('readHistory keeps prompts and answer text, joining blocks and skipping tools, meta and sidechains', async () => {
	const {dir} = await setup();
	assert.deepEqual(await readHistory(join(dir, `${A}.jsonl`)), [
		{role: 'user', text: 'fix the build'},
		{role: 'assistant', text: 'Looking\n\nFixed.'},
		{role: 'user', text: 'thanks'},
	]);
	assert.deepEqual(await readHistory(join(dir, `${A}.jsonl`), 1), [{role: 'user', text: 'thanks'}]);
	assert.deepEqual(await readHistory(join(dir, 'missing.jsonl')), []);
});

test('readTranscriptDetail shows prompts, answers, tool calls with input and their results', async () => {
	const {readTranscriptDetail} = await import('../../src/chat/history.js');
	const {dir} = await setup();
	const file = join(dir, `${A}.jsonl`);
	await writeFile(
		file,
		jsonl([
			user('read it'),
			{type: 'assistant', message: {id: 'm1', content: [{type: 'tool_use', name: 'Read', input: {file_path: '/app/x.ts'}}]}},
			user([{type: 'tool_result', content: 'line 1\nline 2'}]),
			assistant('m2', 'Done.'),
		]),
	);
	const lines = await readTranscriptDetail(file);
	assert.deepEqual(lines.filter(l => l !== ''), ['> read it', '● Read', '  {', '    "file_path": "/app/x.ts"', '  }', '  ⎿ line 1', '    line 2', 'Done.']);
});
