import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, stat, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createStore} from '../src/store.js';
import {makeFakeLog} from './helpers/fake-log.js';

const tmp = () => mkdtemp(join(tmpdir(), 'claude-store-'));
const ID = '123e4567-e89b-12d3-a456-426614174000';

test('round trip', async () => {
	const dir = await tmp();
	const store = createStore(dir);
	assert.deepEqual(await store.read(), {});
	await store.update({lastSessionId: ID, lastModel: 'm1'});
	await store.update({subscriptionNoticeShown: true});
	assert.deepEqual(await store.read(), {lastSessionId: ID, lastModel: 'm1', subscriptionNoticeShown: true});
});

test('corrupt, wrong-shape and wrong-typed files give defaults', async () => {
	const dir = await tmp();
	const store = createStore(dir);
	for (const body of ['{nope', '[]', 'null', '{"lastSessionId":5,"lastModel":{},"subscriptionNoticeShown":"x"}']) {
		await writeFile(join(dir, 'state.json'), body);
		assert.deepEqual(await store.read(), {});
	}
});

test('bad session id and unknown keys are dropped', async () => {
	const dir = await tmp();
	await writeFile(join(dir, 'state.json'), JSON.stringify({lastSessionId: '../x', lastModel: 'ok', extra: 1}));
	const store = createStore(dir);
	assert.deepEqual(await store.read(), {lastModel: 'ok'});
	await store.update({});
	assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), {lastModel: 'ok'});
});

test('missing dir is created, mode 0600, no tmp left', async () => {
	const dir = join(await tmp(), 'a', 'b');
	await createStore(dir).update({lastModel: 'm'});
	assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
	assert.deepEqual(await readdir(dir), ['state.json']);
});

test('failed write leaves the old file intact and no tmp', async () => {
	const dir = await tmp();
	const store = createStore(dir);
	await store.update({lastModel: 'old'});
	const bad = await tmp();
	await mkdir(join(bad, 'state.json'));
	await assert.rejects(createStore(bad).update({lastModel: 'x'}));
	assert.deepEqual(await readdir(bad), ['state.json']);
	assert.deepEqual(await store.read(), {lastModel: 'old'});
});

test('concurrent updates are serialised', async () => {
	const dir = await tmp();
	const store = createStore(dir);
	await Promise.all([
		store.update({lastModel: 'a'}),
		store.update({subscriptionNoticeShown: true}),
		store.update({lastSessionId: ID}),
	]);
	assert.deepEqual(await store.read(), {lastModel: 'a', subscriptionNoticeShown: true, lastSessionId: ID});
});

test('a failed state write logs the error code at warn and rethrows', async () => {
	const dir = await tmp();
	const log = makeFakeLog();
	const store = createStore(join(dir, 'missing', 'deeper'), log);
	await mkdir(join(dir, 'missing'));
	await writeFile(join(dir, 'missing', 'deeper'), 'a file where a directory is expected');
	await assert.rejects(store.update({lastModel: 'm'}));
	assert.equal(log.records.length, 1);
	assert.equal(log.records[0]!.level, 'warn');
	assert.equal(log.records[0]!.msg, 'state write failed');
	assert.equal(typeof log.records[0]!.fields.code, 'string');
});

test('chatModel keeps model ids and drops anything else', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-store-model-'));
	const store = createStore(dir);
	await store.update({chatModel: 'claude-fable-5-1'});
	assert.equal((await store.read()).chatModel, 'claude-fable-5-1');
	await store.update({chatModel: 'sonnet[1m]'});
	assert.equal((await store.read()).chatModel, 'sonnet[1m]');
	await store.update({chatModel: 'bad id\u001b'});
	assert.equal((await store.read()).chatModel, undefined);
});

test('chat tuning fields keep only known values', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-store-tuning-'));
	await writeFile(
		join(dir, 'state.json'),
		JSON.stringify({chatEffort: 'max', chatThinking: 'disabled', chatFastMode: true, chatOutputStyle: 'Explanatory'}),
	);
	assert.deepEqual(await createStore(dir).read(), {
		chatEffort: 'max',
		chatThinking: 'disabled',
		chatFastMode: true,
		chatOutputStyle: 'Explanatory',
	});
	await writeFile(
		join(dir, 'state.json'),
		JSON.stringify({chatEffort: 'turbo', chatThinking: 'on', chatFastMode: 'yes', chatOutputStyle: '../x'}),
	);
	assert.deepEqual(await createStore(dir).read(), {});
});

test('chatKeepRunning keeps only "on" and survives a round trip', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-store-keep-'));
	for (const bad of ['off', true, 1, 'ON', ' on', null, {}, ['on']]) {
		await writeFile(join(dir, 'state.json'), JSON.stringify({chatKeepRunning: bad}));
		assert.deepEqual(await createStore(dir).read(), {}, JSON.stringify(bad));
	}
	const store = createStore(dir);
	await store.update({chatKeepRunning: 'on'});
	assert.deepEqual(await createStore(dir).read(), {chatKeepRunning: 'on'});
});
