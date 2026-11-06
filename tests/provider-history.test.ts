import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {createClaude} from '../src/commands.js';
import {resolvePaths} from '../src/config.js';
import {transcriptFile} from '../src/chat/title.js';
import type {QueryFn} from '../src/types.js';

const A = '11111111-aaaa-4bbb-8ccc-222222222222';
const B = '33333333-aaaa-4bbb-8ccc-444444444444';

const jsonl = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const user = (uuid: string, parentUuid: string | null, content: unknown) => ({type: 'user', uuid, parentUuid, message: {role: 'user', content}});
const assistant = (id: string, text: string) => ({type: 'assistant', message: {id, content: [{type: 'text', text}]}});

const setup = async () => {
	const root = await mkdtemp(join(tmpdir(), 'claude-prov-hist-'));
	const dataDir = join(root, 'data');
	const moduleDir = join(root, 'modules', 'claude');
	const paths = resolvePaths(dataDir, moduleDir);
	const fileOf = (id: string) => transcriptFile(paths.configDir, paths.projectDir, id);
	await mkdir(dirname(fileOf(A)), {recursive: true});
	await writeFile(fileOf(A), jsonl([user('u1', null, 'fix the build'), assistant('m1', 'Looking'), user('u2', 'm1', 'thanks'), assistant('m2', 'Done'), {type: 'ai-title', aiTitle: 'Generated'}]));
	await writeFile(fileOf(B), jsonl([user('u3', null, 'hello there\nsecond line'), assistant('m3', 'Hi!')]));
	const {provider} = createClaude({
		dataDir,
		moduleDir,
		env: {},
		loadQuery: async () => (() => (async function* () {})()) as unknown as QueryFn,
		login: {probe: async () => undefined},
	});
	return {provider, dataDir, fileOf, paths};
};

test('sessions lists the project sessions and honours the limit', async () => {
	const {provider} = await setup();
	const all = await provider.sessions();
	assert.deepEqual(all.map(s => s.sessionId).sort(), [A, B]);
	assert.equal((await provider.sessions(1)).length, 1);
	assert.equal(all.find(s => s.sessionId === B)!.title, 'hello there');
});

test('history reads the messages, with a limit and an upper bound', async () => {
	const {provider} = await setup();
	assert.deepEqual(await provider.history(A), [
		{role: 'user', text: 'fix the build'},
		{role: 'assistant', text: 'Looking'},
		{role: 'user', text: 'thanks'},
		{role: 'assistant', text: 'Done'},
	]);
	assert.deepEqual((await provider.history(A, {limit: 1})).map(m => m.text), ['Done']);
	assert.deepEqual((await provider.history(A, {until: 'u2'})).map(m => m.text), ['fix the build', 'Looking']);
});

test('prompts and detail come from the transcript', async () => {
	const {provider} = await setup();
	assert.deepEqual(await provider.prompts(A), [
		{uuid: 'u1', parentUuid: null, text: 'fix the build'},
		{uuid: 'u2', parentUuid: 'm1', text: 'thanks'},
	]);
	const detail = await provider.detail(A);
	assert.ok(detail.length > 0);
	assert.equal(detail.some(d => typeof d === 'string' && d.includes('fix the build')), true);
});

test('title and rename: a custom title appended to the transcript wins', async () => {
	const {provider, fileOf} = await setup();
	assert.equal(await provider.title(B), undefined);
	assert.equal(await provider.title(A), 'Generated');
	await provider.rename(A, 'Build fix');
	assert.equal(await provider.title(A), 'Build fix');
	const last = (await readFile(fileOf(A), 'utf8')).trimEnd().split('\n').at(-1)!;
	assert.deepEqual(JSON.parse(last), {type: 'custom-title', customTitle: 'Build fix', sessionId: A});
	assert.equal((await provider.sessions()).find(s => s.sessionId === A)!.title, 'Build fix');
});

test('lastSession, projectDir and commandHints', async () => {
	const {provider, dataDir, paths} = await setup();
	assert.equal(await provider.lastSession(), undefined);
	await writeFile(join(dataDir, 'state.json'), JSON.stringify({lastSessionId: B}));
	assert.equal(await provider.lastSession(), B);
	assert.equal(provider.projectDir(), paths.projectDir);
	assert.deepEqual(provider.commandHints(), []);
});
