import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import type {ChatEvent, UiEvent} from '../../src/chat/events.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {createShellWatch, MAX_CALLS, MAX_DIR_ENTRIES, MAX_LINES} from '../../src/chat/shell-watch.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SID = '11111111-aaaa-4bbb-8ccc-222222222222';
const SID2 = '33333333-aaaa-4bbb-8ccc-444444444444';
const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const scrub = makeScrub(s => s.split(SECRET).join('[redacted]'));
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const uid = process.getuid?.() ?? 0;

const ui = (event: UiEvent): ChatEvent => ({type: 'ui', event});
const use = (id: string, input: unknown = {command: 'echo hi'}) => ui({kind: 'tool-use', toolUseId: id, name: 'Bash', input});
const result = (id: string) => ui({kind: 'tool-result', toolUseId: id, isError: false, text: ''});

const setup = (over: Record<string, unknown> = {}, makeTasks = true) => {
	const root = mkdtempSync(join(tmpdir(), 'shell-watch-'));
	const slugDir = join(root, `claude-${uid}`, '-app');
	const tasks = join(slugDir, SID, 'tasks');
	if (makeTasks) mkdirSync(tasks, {recursive: true});
	else mkdirSync(slugDir, {recursive: true});
	const log = makeFakeLog();
	const watch = createShellWatch({root, sessionId: () => SID, scrub, pollMs: 10, log, ...over});
	return {root, tasks, slugDir, watch, log};
};
type Ctx = ReturnType<typeof setup>;

// The baseline listing runs asynchronously right after the tool-use.
const begin = async (watch: Ctx['watch'], id: string, input?: unknown) => {
	watch.feed(use(id, input));
	await wait(40);
};

test('a call stays hidden until its file appears, then tails and closes on tool-result', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	await wait(150);
	assert.equal(watch.get().calls.length, 0);
	const file = join(tasks, 'bq1.output');
	writeFileSync(file, 'one\ntw');
	await wait(100);
	let call = watch.get().calls[0]!;
	assert.equal(call.bound, 'file');
	assert.deepEqual(call.lines, ['one']);
	const euro = Buffer.from('€\n');
	appendFileSync(file, Buffer.concat([Buffer.from('o '), euro.subarray(0, 1)]));
	await wait(60);
	appendFileSync(file, Buffer.concat([euro.subarray(1), Buffer.from('three\n')]));
	await wait(80);
	call = watch.get().calls[0]!;
	assert.deepEqual(call.lines, ['one', 'two €', 'three']);
	assert.ok(watch.totalBytes > 0);
	watch.feed(result('t1'));
	assert.equal(watch.get().calls.length, 0);
	watch.close();
});

test('files that existed before the call are ignored', async () => {
	const {tasks, watch} = setup();
	writeFileSync(join(tasks, 'old.output'), 'old\n');
	await begin(watch, 't1');
	writeFileSync(join(tasks, 'new.output'), 'new\n');
	await wait(100);
	assert.deepEqual(watch.get().calls[0]!.lines, ['new']);
	watch.close();
});

test('a background call file is known once its result arrived', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 'bg', {command: 'sleep 9', run_in_background: true});
	writeFileSync(join(tasks, 'bg1.output'), 'bg\n');
	watch.feed(result('bg'));
	await wait(60);
	await begin(watch, 't1');
	writeFileSync(join(tasks, 'fg1.output'), 'fg\n');
	await wait(100);
	assert.deepEqual(watch.get().calls[0]!.lines, ['fg']);
	watch.close();
});

test('a background call outstanding next to a pending call is ambiguous', async () => {
	const {tasks, watch, log} = setup();
	await begin(watch, 'bg', {command: 'sleep 9', run_in_background: true});
	await begin(watch, 't1');
	writeFileSync(join(tasks, 'a1.output'), 'x\n');
	await wait(100);
	assert.equal(watch.get().calls.length, 0);
	assert.ok(log.records.some(r => r.msg === 'shell view' && r.fields['fallback'] === 'ambiguous'));
	assert.ok(!JSON.stringify(log.records).includes('a1'));
	watch.close();
});

test('two pending calls, or two candidate files, are ambiguous', async () => {
	const a = setup();
	await begin(a.watch, 't1');
	await begin(a.watch, 't2');
	writeFileSync(join(a.tasks, 'a1.output'), 'x\n');
	await wait(100);
	assert.equal(a.watch.get().calls.length, 0);
	a.watch.close();

	const b = setup();
	await begin(b.watch, 't1');
	writeFileSync(join(b.tasks, 'a1.output'), 'x\n');
	writeFileSync(join(b.tasks, 'a2.output'), 'y\n');
	await wait(100);
	assert.equal(b.watch.get().calls.length, 0);
	b.watch.feed(result('t1'));
	// a later call starts clean
	await begin(b.watch, 't3');
	writeFileSync(join(b.tasks, 'a3.output'), 'z\n');
	await wait(100);
	assert.deepEqual(b.watch.get().calls[0]!.lines, ['z']);
	b.watch.close();
});

test('symlinks (agent output) are ignored', async () => {
	const {root, tasks, watch} = setup();
	const target = join(root, 'agent.jsonl');
	writeFileSync(target, 'agent\n');
	await begin(watch, 't1');
	symlinkSync(target, join(tasks, 'ag1.output'));
	writeFileSync(join(tasks, 'real.output'), 'real\n');
	await wait(100);
	assert.deepEqual(watch.get().calls[0]!.lines, ['real']);
	watch.close();
});

test('tops that are not claude-* are ignored', async () => {
	const {root, watch} = setup();
	for (const top of ['fswatch-probe-1', 'cc-socks']) {
		const dir = join(root, top, '-app', SID, 'tasks');
		mkdirSync(dir, {recursive: true});
	}
	await begin(watch, 't1');
	writeFileSync(join(root, 'fswatch-probe-1', '-app', SID, 'tasks', 'x.output'), 'no\n');
	writeFileSync(join(root, 'cc-socks', '-app', SID, 'tasks', 'y.output'), 'no\n');
	await wait(100);
	assert.equal(watch.get().calls.length, 0);
	watch.close();
});

test('a missing tasks directory counts as empty until the first file', async () => {
	const {slugDir, watch} = setup({}, false);
	await begin(watch, 't1');
	await wait(60);
	assert.equal(watch.get().calls.length, 0);
	mkdirSync(join(slugDir, SID, 'tasks'), {recursive: true});
	writeFileSync(join(slugDir, SID, 'tasks', 'f1.output'), 'late\n');
	await wait(120);
	assert.deepEqual(watch.get().calls[0]!.lines, ['late']);
	watch.close();
});

test('a missing slug directory is found once it appears', async () => {
	const root = mkdtempSync(join(tmpdir(), 'shell-watch-'));
	mkdirSync(join(root, `claude-${uid}`));
	const watch = createShellWatch({root, sessionId: () => SID, scrub, pollMs: 10});
	await begin(watch, 't1');
	await wait(60);
	const tasks = join(root, `claude-${uid}`, '-app', SID, 'tasks');
	mkdirSync(tasks, {recursive: true});
	writeFileSync(join(tasks, 'f1.output'), 'hi\n');
	await wait(120);
	assert.deepEqual(watch.get().calls[0]!.lines, ['hi']);
	watch.close();
});

test('the file disappearing after binding keeps the lines until the tool-result', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	const file = join(tasks, 'f1.output');
	writeFileSync(file, 'kept\n');
	await wait(80);
	rmSync(file);
	await wait(80);
	assert.deepEqual(watch.get().calls[0]!.lines, ['kept']);
	watch.feed(result('t1'));
	assert.equal(watch.get().calls.length, 0);
	watch.close();
});

test('a session id change resets the directory cache', async () => {
	let sid = SID;
	const {slugDir, watch} = setup({sessionId: () => sid});
	await begin(watch, 't1');
	watch.feed(result('t1'));
	sid = SID2;
	const tasks2 = join(slugDir, SID2, 'tasks');
	mkdirSync(tasks2, {recursive: true});
	await begin(watch, 't2');
	writeFileSync(join(tasks2, 'g1.output'), 'second\n');
	await wait(100);
	assert.deepEqual(watch.get().calls[0]!.lines, ['second']);
	watch.close();
});

test('a directory with too many entries disables the call', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	for (let i = 0; i <= MAX_DIR_ENTRIES; i++) writeFileSync(join(tasks, `f${i}.output`), '');
	await wait(120);
	assert.equal(watch.get().calls.length, 0);
	watch.close();
});

test('an exact task_started id binds with priority', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	await begin(watch, 't2');
	watch.feed(ui({kind: 'task', id: 'a1', status: 'running', toolUseId: 't1', taskType: 'local_bash'}));
	writeFileSync(join(tasks, 'a1.output'), 'mine\n');
	writeFileSync(join(tasks, 'a2.output'), 'other\n');
	await wait(100);
	const calls = watch.get().calls;
	assert.equal(calls.length, 1);
	assert.equal(calls[0]!.bound, 'task');
	assert.deepEqual(calls[0]!.lines, ['mine']);
	watch.close();
});

test('scrubs escapes and secrets and caps long lines', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	writeFileSync(join(tasks, 'f1.output'), `\u001b]52;c;AAAA\u0007red \u001b[31mtext\u001b[0m ${SECRET}\n${'x'.repeat(5000)}\n`);
	await wait(100);
	const lines = watch.get().calls[0]!.lines;
	assert.equal(lines[0], 'red text [redacted]');
	assert.ok(lines[1]!.length <= 1024);
	assert.ok(!lines.join('').includes('\u001b'));
	watch.close();
});

test('keeps at most 200 lines and 32 KiB', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	const file = join(tasks, 'f1.output');
	writeFileSync(file, Array.from({length: 500}, (_, i) => `n${i}`).join('\n') + '\n');
	await wait(100);
	assert.equal(watch.get().calls[0]!.lines.length, MAX_LINES);
	assert.equal(watch.get().calls[0]!.lines.at(-1), 'n499');
	appendFileSync(file, Array.from({length: 100}, () => 'y'.repeat(1000)).join('\n') + '\n');
	await wait(100);
	assert.ok(watch.get().calls[0]!.bytes <= 32 * 1024);
	watch.close();
});

test('turn end and close end calls; calls past the limit are decoys', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't0');
	writeFileSync(join(tasks, 'f0.output'), 'a\n');
	await wait(100);
	assert.equal(watch.get().calls.length, 1);
	watch.feed({type: 'turn-end', outcome: 'interrupted'});
	assert.equal(watch.get().calls.length, 0);
	for (let i = 0; i < MAX_CALLS + 1; i++) watch.feed(use(`x${i}`));
	writeFileSync(join(tasks, 'f9.output'), 'b\n');
	await wait(100);
	assert.equal(watch.get().calls.length, 0);
	watch.close();
	assert.equal(watch.get().calls.length, 0);
});

test('without a root nothing is tracked, and the command is scrubbed and clamped', async () => {
	const none = setup({root: undefined});
	await begin(none.watch, 't1');
	assert.equal(none.watch.get().calls.length, 0);
	none.watch.close();
	const {tasks, watch} = setup();
	await begin(watch, 't1', {command: `echo ${SECRET}\n${'a'.repeat(500)}`});
	writeFileSync(join(tasks, 'f1.output'), 'x\n');
	await wait(100);
	const c = watch.get().calls[0]!.command;
	assert.ok(!c.includes(SECRET));
	assert.ok(!c.includes('\n'));
	assert.equal(c.length, 200);
	watch.close();
});

test('a file that appears long after the tool-use (permission prompt delay) still binds', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	await wait(700);
	assert.equal(watch.get().calls.length, 0);
	writeFileSync(join(tasks, 'late.output'), 'late\n');
	await wait(100);
	assert.deepEqual(watch.get().calls[0]!.lines, ['late']);
	assert.equal(watch.get().calls[0]!.bound, 'file');
	watch.close();
});

test('foreign names and stale files are not candidates, the real output still binds', async () => {
	const {tasks, watch} = setup();
	await begin(watch, 't1');
	const old = new Date(Date.now() - 60_000);
	writeFileSync(join(tasks, 'stale.output'), 'stale\n');
	utimesSync(join(tasks, 'stale.output'), old, old);
	writeFileSync(join(tasks, 'notes.txt'), 'txt\n');
	writeFileSync(join(tasks, 'bad name.output'), 'space\n');
	mkdirSync(join(tasks, 'dir.output'));
	writeFileSync(join(tasks, 'real.output'), 'real\n');
	await wait(120);
	assert.deepEqual(watch.get().calls.map(c => c.lines), [['real']]);
	watch.close();
});
