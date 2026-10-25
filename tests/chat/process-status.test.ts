import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createProcessStatus, statusLine} from '../../src/chat/process-status.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SID = '9cc5de25-aaaa-4bbb-8ccc-222222222222';
const agent = (status: string) => ({status, taskType: 'local_agent'});

test('statusLine: idle, working, and the subagents of a working chat', () => {
	assert.equal(statusLine({state: 'idle', sessionId: undefined, tasks: []}), 'chat new: idle');
	assert.equal(statusLine({state: 'idle', sessionId: SID, tasks: [agent('running')]}), 'chat 9cc5de25: idle');
	assert.equal(statusLine({state: 'running', sessionId: SID, tasks: []}), 'chat 9cc5de25: working');
	assert.equal(statusLine({state: 'running', sessionId: SID, tasks: [agent('running')]}), 'chat 9cc5de25: working, 1 subagent');
	assert.equal(
		statusLine({state: 'running', sessionId: SID, tasks: [agent('running'), agent('running'), agent('completed'), {status: 'running', taskType: 'local_bash'}]}),
		'chat 9cc5de25: working, 2 subagents',
	);
	assert.equal(statusLine({state: 'idle', sessionId: '\u001b[31mzz', tasks: []}), 'chat 31: idle', 'only hex reaches the line');
});

test('createProcessStatus writes <dir>/<pid> privately, skips repeats and clears', () => {
	const dir = join(mkdtempSync(join(tmpdir(), 'yena-status-')), 'status');
	const log = makeFakeLog();
	const status = createProcessStatus(dir, log, 4242);
	const file = join(dir, '4242');
	status.set('chat new: idle');
	assert.equal(readFileSync(file, 'utf8'), 'chat new: idle\n');
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
	writeFileSync(file, 'changed by hand\n');
	status.set('chat new: idle');
	assert.equal(readFileSync(file, 'utf8'), 'changed by hand\n', 'the same line is not written again');
	status.set('chat new: working');
	assert.equal(readFileSync(file, 'utf8'), 'chat new: working\n');
	status.clear();
	assert.equal(existsSync(file), false);
	status.clear();
	assert.equal(log.records.length, 0);
});

test('createProcessStatus without a directory does nothing; a failed write is logged once', () => {
	const none = createProcessStatus(undefined, makeFakeLog(), 1);
	none.set('x');
	none.clear();
	const base = mkdtempSync(join(tmpdir(), 'yena-status-'));
	const blocker = join(base, 'file');
	writeFileSync(blocker, '');
	const log = makeFakeLog();
	const status = createProcessStatus(join(blocker, 'status'), log, 7);
	status.set('a');
	status.set('b');
	assert.deepEqual(
		log.records.map(r => r.msg),
		['process status write failed'],
	);
});
