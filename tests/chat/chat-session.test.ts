import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {AUTH_MESSAGE, RESUME_MESSAGE} from '../../src/session.js';
import type {ChatQueryFn} from '../../src/types.js';
import {ChatSession} from '../../src/chat/chat-session.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {MAX_QUEUE, PERMISSION_IDLE_MS, type PermissionDecision, type PermissionPrompter, type PermissionRequest} from '../../src/chat/permission.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const redact = (s: string) => s.split(SECRET).join('[redacted]');

class FakeQuery {
	closed = 0;
	interrupts = 0;
	interruptImpl: () => Promise<void> = () => Promise.resolve();
	readonly sent: SDKUserMessage[] = [];
	private buf: Array<{msg?: SDKMessage; err?: Error; end?: boolean}> = [];
	private wake: (() => void) | undefined;

	constructor(
		readonly prompt: AsyncIterable<SDKUserMessage>,
		readonly options: Options | undefined,
	) {
		void (async () => {
			for await (const m of prompt) this.sent.push(m);
		})();
	}
	emit(msg: unknown): void {
		this.buf.push({msg: msg as SDKMessage});
		this.wake?.();
	}
	fail(err: Error): void {
		this.buf.push({err});
		this.wake?.();
	}
	end(): void {
		this.buf.push({end: true});
		this.wake?.();
	}
	interrupt(): Promise<void> {
		this.interrupts++;
		return this.interruptImpl();
	}
	close(): void {
		this.closed++;
		this.end();
	}
	async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
		for (;;) {
			const item = this.buf.shift();
			if (!item) {
				await new Promise<void>(r => {
					this.wake = r;
				});
				continue;
			}
			if (item.err) throw item.err;
			if (item.end) return;
			if (item.msg) yield item.msg;
		}
	}
}

const setup = (o: {timeoutMs?: number; graceMs?: number; initialResume?: string} = {}) => {
	const log = makeFakeLog();
	const queries: FakeQuery[] = [];
	const resumes: Array<string | undefined> = [];
	const prompters: PermissionPrompter[] = [];
	const query: ChatQueryFn = p => {
		const q = new FakeQuery(p.prompt, p.options);
		queries.push(q);
		return q as never;
	};
	const session = new ChatSession({
		query,
		buildOptions: (_ac, resume, prompter) => {
			resumes.push(resume);
			prompters.push(prompter);
			return {} as Options;
		},
		redact,
		log,
		...o,
	});
	const events: ChatEvent[] = [];
	session.subscribe(e => events.push(e));
	const ends = () => events.filter(e => e.type === 'turn-end');
	return {session, queries, resumes, events, ends, log, prompters};
};

const tick = () => new Promise<void>(r => setImmediate(r));
const init = (id = 'sess-1') => ({type: 'system', subtype: 'init', session_id: id, model: 'm', apiKeySource: 'env'});
const ok = (cost = 0.1, id = 'sess-1') => ({type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: id, total_cost_usd: cost});

test('query is created lazily on first send and reused across turns', async () => {
	const {session, queries, resumes, ends} = setup();
	assert.equal(queries.length, 0);
	session.send('one');
	assert.equal(queries.length, 1);
	assert.equal(session.state, 'running');
	queries[0]?.emit(init());
	queries[0]?.emit(ok(0.1));
	await tick();
	assert.equal(session.state, 'idle');
	session.send('two');
	assert.equal(queries.length, 1);
	queries[0]?.emit(ok(0.3));
	await tick();
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['ok', 'ok']);
	assert.equal(session.costUsd, 0.3);
	assert.equal(session.sessionId, 'sess-1');
	assert.equal(session.model, 'm');
	assert.deepEqual(resumes, [undefined]);
});

test('sent message carries uuid, session_id and human origin', async () => {
	const {session, queries} = setup();
	session.send('hello');
	await tick();
	queries[0]?.emit(init('abc'));
	queries[0]?.emit(ok(0.1, 'abc'));
	await tick();
	session.send('again');
	await tick();
	const [a, b] = queries[0]?.sent ?? [];
	assert.equal(a?.type, 'user');
	assert.deepEqual(a?.message, {role: 'user', content: 'hello'});
	assert.equal(a?.session_id, '');
	assert.deepEqual(a?.origin, {kind: 'human'});
	assert.equal(a?.parent_tool_use_id, null);
	assert.match(a?.uuid ?? '', /^[0-9a-f-]{36}$/);
	assert.equal(b?.session_id, 'abc');
	assert.notEqual(a?.uuid, b?.uuid);
});

test('send while running and after close throws', async () => {
	const {session} = setup();
	session.send('x');
	assert.throws(() => session.send('y'), /already running/);
	session.close();
	assert.throws(() => session.send('z'), /closed/);
});

test('close is idempotent, ends the input queue and the query', async () => {
	const {session, queries} = setup();
	session.send('x');
	await tick();
	session.close();
	session.close();
	await tick();
	assert.equal(session.state, 'closed');
	assert.equal(queries[0]?.closed, 1);
	assert.equal((queries[0]?.options as Options | undefined) !== undefined, true);
});

test('close without any query does not throw', () => {
	const {session} = setup();
	session.close();
	assert.equal(session.state, 'closed');
});

test('interrupt followed by result ends as interrupted without recycle', async () => {
	const {session, queries, ends} = setup();
	session.send('x');
	await session.interrupt();
	assert.equal(queries[0]?.interrupts, 1);
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['aborted'], session_id: 's'});
	await tick();
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['interrupted']);
	assert.equal(queries[0]?.closed, 0);
	session.send('next');
	assert.equal(queries.length, 1);
});

test('interrupt without result recycles after grace and respawns with resume', async () => {
	const {session, queries, resumes, ends} = setup({graceMs: 10});
	session.send('x');
	queries[0]?.emit(init('sess-9'));
	await tick();
	await session.interrupt();
	await new Promise(r => setTimeout(r, 40));
	assert.equal(session.state, 'idle');
	assert.equal(queries[0]?.closed, 1);
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['interrupted']);
	session.send('again');
	assert.equal(queries.length, 2);
	assert.deepEqual(resumes, [undefined, 'sess-9']);
});

test('interrupt that rejects still recycles after grace', async () => {
	const {session, queries} = setup({graceMs: 10});
	session.send('x');
	queries[0]!.interruptImpl = () => Promise.reject(new Error('nope'));
	await session.interrupt();
	await new Promise(r => setTimeout(r, 40));
	assert.equal(session.state, 'idle');
	assert.equal(queries[0]?.closed, 1);
});

test('timeout ends the turn with a message and recycles', async () => {
	const {session, queries, ends} = setup({timeoutMs: 10, graceMs: 10});
	session.send('x');
	await new Promise(r => setTimeout(r, 60));
	const end = ends()[0];
	assert.equal(end?.type === 'turn-end' && end.outcome, 'timeout');
	assert.equal(end?.type === 'turn-end' && end.error, 'Request timed out after 0 seconds');
	assert.equal(session.state, 'idle');
	assert.equal(queries[0]?.closed, 1);
});

test('error_max_turns recycles the query', async () => {
	const {session, queries, ends} = setup();
	session.send('x');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], session_id: 'sess-1'});
	await tick();
	assert.equal(ends()[0]?.type === 'turn-end' && ends()[0] && (ends()[0] as {outcome: string}).outcome, 'max-turns');
	assert.equal(queries[0]?.closed, 1);
	session.send('y');
	assert.equal(queries.length, 2);
});

test('generator throw maps to an error, redacts secrets, next send respawns', async () => {
	const {session, queries, ends, resumes} = setup();
	session.send('x');
	queries[0]?.emit(init('s7'));
	queries[0]?.fail(new Error(`boom ${SECRET}`));
	await tick();
	await tick();
	const end = ends()[0];
	assert.equal(end?.type === 'turn-end' && end.outcome, 'error');
	assert.ok(end?.type === 'turn-end' && end.error?.includes('boom') && !end.error.includes('TESTVALUE'));
	assert.equal(session.state, 'idle');
	session.send('y');
	assert.equal(queries.length, 2);
	assert.deepEqual(resumes, [undefined, 's7']);
});

test('stream ending without a result is an error', async () => {
	const {session, queries, ends} = setup();
	session.send('x');
	queries[0]?.end();
	await tick();
	await tick();
	assert.equal(ends()[0]?.type === 'turn-end' && (ends()[0] as {outcome: string}).outcome, 'error');
	assert.equal(session.state, 'idle');
});

test('authentication failure maps to AUTH_MESSAGE', async () => {
	const {session, queries, ends} = setup();
	session.send('x');
	queries[0]?.emit({type: 'assistant', error: 'authentication_failed', message: {id: 'm', content: [{type: 'text', text: 'Please run /login'}]}, parent_tool_use_id: null});
	queries[0]?.emit({type: 'result', subtype: 'success', is_error: true, result: `Invalid ${SECRET}`, session_id: 's'});
	await tick();
	const end = ends()[0] as {outcome: string; error?: string};
	assert.equal(end.outcome, 'error');
	assert.equal(end.error, AUTH_MESSAGE);
	assert.equal(session.state, 'idle');
});

test('bogus resume sets needsNewSession and refuses sends until reset', async () => {
	const {session, queries, ends, resumes} = setup({initialResume: 'gone'});
	session.send('x');
	assert.deepEqual(resumes, ['gone']);
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: gone'], session_id: ''});
	await tick();
	const end = ends()[0] as {outcome: string; error?: string};
	assert.equal(end.error, RESUME_MESSAGE);
	assert.equal(session.needsNewSession, true);
	assert.throws(() => session.send('y'), new RegExp('no longer exists'));
	session.reset();
	assert.equal(session.needsNewSession, false);
	session.send('z');
	assert.deepEqual(resumes, ['gone', undefined]);
});

test('generic error result is redacted and the chat stays usable', async () => {
	const {session, queries, ends} = setup();
	session.send('x');
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`failed ${SECRET}`], session_id: 's'});
	await tick();
	const end = ends()[0] as {error?: string};
	assert.ok(end.error?.startsWith('Claude request failed: failed '));
	assert.ok(!end.error?.includes('TESTVALUE'));
	assert.equal(session.state, 'idle');
});

test('ui events are forwarded and unsubscribe works', async () => {
	const {session, queries, events} = setup();
	const extra: ChatEvent[] = [];
	const off = session.subscribe(e => extra.push(e));
	off();
	session.send('x');
	queries[0]?.emit({type: 'stream_event', parent_tool_use_id: null, event: {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'hi'}}});
	await tick();
	assert.ok(events.some(e => e.type === 'ui' && e.event.kind === 'text-delta'));
	assert.equal(extra.length, 0);
});

test('turn lifecycle is logged without prompt or response text', async () => {
	const {session, queries, log} = setup();
	session.send('PROMPT-SENTINEL-1');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'assistant', message: {content: [{type: 'tool_use', id: 't', name: 'Read', input: {p: 'TOOLIN-SENTINEL-3'}}]}});
	queries[0]?.emit({type: 'result', subtype: 'success', is_error: false, result: 'ASSISTANT-SENTINEL-2', session_id: 'sess-1'});
	await tick();
	const msgs = log.records.map(r => r.msg);
	assert.deepEqual(msgs, ['sdk session spawned', 'turn started', 'turn ended']);
	assert.deepEqual(log.records[1]!.fields, {chars: 'PROMPT-SENTINEL-1'.length});
	assert.equal(log.records[2]!.fields.outcome, 'ok');
	assert.equal(typeof log.records[2]!.fields.ms, 'number');
	assert.ok(!JSON.stringify(log.records).includes('SENTINEL'));
});

test('error turn logs a redacted reason; auth failure and recycle are warnings', async () => {
	const {session, queries, log} = setup({graceMs: 10});
	session.send('x');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'assistant', error: 'authentication_failed', message: {content: []}});
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: [`boom ${SECRET}`], session_id: 'sess-1'});
	await tick();
	assert.ok(log.records.some(r => r.level === 'warn' && r.msg === 'authentication failed'));
	const ended = log.records.find(r => r.msg === 'turn ended')!;
	assert.equal(ended.fields.outcome, 'error');
	assert.equal(ended.fields.reason, AUTH_MESSAGE);
	assert.ok(!JSON.stringify(log.records).includes(SECRET));
});

test('interrupt without result logs aborting, grace expiry and recycle', async () => {
	const {session, queries, log} = setup({graceMs: 10});
	session.send('x');
	queries[0]?.emit(init('sess-9'));
	await tick();
	await session.interrupt();
	await new Promise(r => setTimeout(r, 40));
	const byMsg = (m: string) => log.records.find(r => r.msg === m);
	assert.deepEqual(byMsg('turn aborting')?.fields, {outcome: 'interrupted'});
	assert.equal(byMsg('interrupt grace expired; recycling')?.level, 'warn');
	assert.equal(byMsg('session recycled')?.level, 'warn');
	assert.equal(log.records.find(r => r.msg === 'turn ended')?.fields.outcome, 'interrupted');
});

test('a throwing stream logs the error class only', async () => {
	const {session, queries, log} = setup();
	session.send('x');
	queries[0]?.fail(new TypeError(`bad ${SECRET}`));
	await tick();
	const rec = log.records.find(r => r.msg === 'sdk stream threw')!;
	assert.deepEqual([rec.level, rec.fields], ['warn', {errClass: 'TypeError'}]);
	assert.ok(!JSON.stringify(log.records).includes(SECRET));
});

test('an unexpectedly ended stream logs a warning', async () => {
	const {session, queries, log} = setup();
	session.send('x');
	queries[0]?.end();
	await tick();
	assert.equal(log.records.find(r => r.msg === 'sdk stream ended unexpectedly')?.level, 'warn');
});

const toolReq = (id: string, command = 'ls'): PermissionRequest => ({
	kind: 'tool',
	id,
	seq: 1,
	toolName: 'Bash',
	input: {command},
	cwd: '/p',
	highlights: [],
	defaultToNo: false,
	always: false,
	oversize: false,
});
const never = () => new AbortController().signal;
const decisions = (ps: Array<Promise<PermissionDecision>>) => Promise.all(ps);

test('permission requests are queued FIFO and exposed as pending', async () => {
	const {session, events} = setup();
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = ['a', 'b', 'c'].map(id => p.request(toolReq(id), never()));
	assert.deepEqual(session.pendingPermissions.map(q => q.id), ['a', 'b', 'c']);
	assert.equal(session.answerPermission('zzz', {kind: 'allow'}), false);
	assert.equal(session.answerPermission('a', {kind: 'allow'}), true);
	assert.equal(session.answerPermission('a', {kind: 'allow'}), false);
	assert.deepEqual(await r[0], {kind: 'allow'});
	session.answerPermission('b', {kind: 'deny', reason: 'no'});
	assert.deepEqual(await r[1], {kind: 'deny', reason: 'no'});
	assert.deepEqual(session.pendingPermissions.map(q => q.id), ['c']);
	const kinds = events.map(e => e.type).filter(t => t.startsWith('permission') || t === 'audit');
	assert.deepEqual(kinds, [
		'permission-requested',
		'permission-requested',
		'permission-requested',
		'permission-resolved',
		'audit',
		'permission-resolved',
		'audit',
	]);
	const last = events.filter(e => e.type === 'permission-resolved').at(-1);
	assert.equal(last?.type === 'permission-resolved' && last.pending, 1);
	const audits = events.flatMap(e => (e.type === 'audit' ? [e.entry.outcome] : []));
	assert.deepEqual(audits, ['allowed', 'denied']);
	session.close();
	assert.deepEqual(await r[2], {kind: 'cancel', cause: 'closed'});
});

test('a decision of the wrong kind for the request is rejected', async () => {
	const {session} = setup();
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	assert.equal(session.answerPermission('a', {kind: 'answers', answers: {}}), false);
	session.answerPermission('a', {kind: 'deny'});
	await r;
});

test('the turn timer does not count time spent waiting for a decision', async () => {
	const {session, ends} = setup({timeoutMs: 80, graceMs: 10});
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	await new Promise(res => setTimeout(res, 200));
	assert.equal(session.state, 'running');
	assert.equal(ends().length, 0);
	session.answerPermission('a', {kind: 'allow'});
	await r;
	await new Promise(res => setTimeout(res, 200));
	assert.equal(ends().length, 1);
	const e = ends()[0];
	assert.equal(e?.type === 'turn-end' && e.outcome, 'timeout');
});

test('the remaining turn time is preserved across a pause', async () => {
	const {session, ends} = setup({timeoutMs: 150, graceMs: 10});
	session.send('x');
	await new Promise(res => setTimeout(res, 100));
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	await new Promise(res => setTimeout(res, 200));
	session.answerPermission('a', {kind: 'allow'});
	await r;
	await new Promise(res => setTimeout(res, 20));
	assert.equal(ends().length, 0);
	await new Promise(res => setTimeout(res, 120));
	assert.equal(ends().length, 1);
});

test('interrupt resolves every pending prompt as cancelled and the query stays reusable', async () => {
	const {session, queries, ends, events} = setup();
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = [p.request(toolReq('a'), never()), p.request(toolReq('b'), never())];
	await session.interrupt();
	assert.deepEqual(await decisions(r), [
		{kind: 'cancel', cause: 'interrupted'},
		{kind: 'cancel', cause: 'interrupted'},
	]);
	assert.equal(session.pendingPermissions.length, 0);
	assert.equal(queries[0]?.interrupts, 1);
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['aborted'], session_id: 's'});
	await tick();
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['interrupted']);
	assert.equal(queries[0]?.closed, 0);
	assert.ok(events.some(e => e.type === 'audit' && e.entry.outcome === 'cancelled'));
	session.send('next');
	assert.equal(queries.length, 1);
});

test('requests arriving while the turn is being interrupted are denied at once', async () => {
	const {session} = setup({graceMs: 1000});
	session.send('x');
	await session.interrupt();
	const p = session as unknown as PermissionPrompter;
	assert.deepEqual(await p.request(toolReq('late'), never()), {kind: 'cancel', cause: 'interrupted'});
	assert.equal(session.pendingPermissions.length, 0);
	session.close();
});

test('the interrupt grace timer is unaffected by pending prompts', async () => {
	const {session, queries, ends} = setup({graceMs: 20});
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	await session.interrupt();
	await r;
	await new Promise(res => setTimeout(res, 60));
	assert.equal(queries[0]?.closed, 1);
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['interrupted']);
});

test('close resolves all pending prompts', async () => {
	const {session} = setup();
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = [p.request(toolReq('a'), never()), p.request(toolReq('b'), never())];
	session.close();
	assert.deepEqual(await decisions(r), [
		{kind: 'cancel', cause: 'closed'},
		{kind: 'cancel', cause: 'closed'},
	]);
	assert.deepEqual(await p.request(toolReq('c'), never()), {kind: 'cancel', cause: 'closed'});
});

test('a respawn cancels the dropped handle prompts and keeps those of the new handle', async () => {
	const {session, queries, prompters} = setup();
	session.send('x');
	const old = prompters[0]!.request(toolReq('old'), never());
	queries[0]?.fail(new Error('boom'));
	assert.deepEqual(await old, {kind: 'cancel', cause: 'replaced'});
	await tick();
	session.send('again');
	assert.equal(queries.length, 2);
	const fresh = prompters[1]!.request(toolReq('fresh'), never());
	assert.deepEqual(session.pendingPermissions.map(q => q.id), ['fresh']);
	session.answerPermission('fresh', {kind: 'allow'});
	assert.deepEqual(await fresh, {kind: 'allow'});
});

test('recycle cancels the dropped handle prompts with cause replaced', async () => {
	const {session, queries} = setup();
	session.send('x');
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	queries[0]?.fail(new Error('boom'));
	assert.deepEqual(await r, {kind: 'cancel', cause: 'replaced'});
	await tick();
	assert.equal(session.state, 'idle');
});

test('the always memory survives a respawn and is cleared by reset and close', async () => {
	const {session, queries} = setup();
	const p = session as unknown as PermissionPrompter;
	p.remember('ls');
	assert.equal(p.hasApproved('ls'), true);
	session.send('x');
	queries[0]?.fail(new Error('boom'));
	await tick();
	assert.equal(p.hasApproved('ls'), true);
	session.reset();
	assert.equal(p.hasApproved('ls'), false);
	p.remember('ls');
	session.close();
	assert.equal(p.hasApproved('ls'), false);
});

test('the always memory is capped', () => {
	const {session} = setup();
	for (let i = 0; i < 150; i++) session.remember(`cmd ${i}`);
	assert.equal(session.hasApproved('cmd 0'), false);
	assert.equal(session.hasApproved('cmd 149'), true);
	assert.equal(session.hasApproved('cmd 50'), true);
});

test('queue overflow is cancelled immediately', async () => {
	const {session} = setup();
	const p = session as unknown as PermissionPrompter;
	const held = Array.from({length: MAX_QUEUE}, (_, i) => p.request(toolReq(`r${i}`), never()));
	assert.deepEqual(await p.request(toolReq('over'), never()), {kind: 'cancel', cause: 'replaced'});
	assert.equal(session.pendingPermissions.length, MAX_QUEUE);
	session.close();
	await decisions(held);
});

test('an abort signal cancels only its own prompt', async () => {
	const {session} = setup();
	const p = session as unknown as PermissionPrompter;
	const ac = new AbortController();
	const a = p.request(toolReq('a'), ac.signal);
	const b = p.request(toolReq('b'), never());
	ac.abort();
	assert.deepEqual(await a, {kind: 'cancel', cause: 'aborted'});
	assert.deepEqual(session.pendingPermissions.map(q => q.id), ['b']);
	assert.deepEqual(await p.request(toolReq('c'), AbortSignal.abort()), {kind: 'cancel', cause: 'aborted'});
	session.close();
	await b;
});

test('the idle cap cancels a prompt with cause timeout', async t => {
	t.mock.timers.enable({apis: ['setTimeout']});
	const {session, events} = setup();
	const p = session as unknown as PermissionPrompter;
	const r = p.request(toolReq('a'), never());
	t.mock.timers.tick(PERMISSION_IDLE_MS - 1);
	assert.equal(session.pendingPermissions.length, 1);
	t.mock.timers.tick(1);
	assert.deepEqual(await r, {kind: 'cancel', cause: 'timeout'});
	assert.ok(events.some(e => e.type === 'audit' && e.entry.outcome === 'cancelled'));
});

test('setMode emits an event, rejects unknown modes and reset restores default', () => {
	const {session, events} = setup();
	assert.equal(session.mode, 'default');
	session.setMode('acceptEdits');
	assert.equal(session.mode, 'acceptEdits');
	assert.deepEqual(events.filter(e => e.type === 'mode'), [{type: 'mode', mode: 'acceptEdits'}]);
	assert.throws(() => session.setMode('plan' as never), /Unknown permission mode/);
	assert.throws(() => session.setMode('bypassPermissions' as never), /Unknown permission mode/);
	assert.equal(session.mode, 'acceptEdits');
	session.reset();
	assert.equal(session.mode, 'default');
});

test('a prompter passed to buildOptions is the session itself', () => {
	const {session, prompters} = setup();
	session.send('x');
	assert.equal(prompters[0], session);
	assert.equal(prompters[0]?.mode, 'default');
});

test('permission logging is metadata only', async () => {
	const {session, log} = setup();
	const SENT = 'SENTINEL-cmd-/secret/path-answer';
	const p = session as unknown as PermissionPrompter;
	const r = p.request({...(toolReq('a', SENT) as Extract<PermissionRequest, {kind: 'tool'}>), path: `/x/${SENT}`}, never());
	const q = p.request(
		{kind: 'question', id: 'q', seq: 2, questions: [{question: SENT, header: 'h', multiSelect: false, options: []}]},
		never(),
	);
	session.answerPermission('a', {kind: 'allow', always: true});
	session.answerPermission('q', {kind: 'answers', answers: {[SENT]: SENT}});
	await decisions([r, q]);
	const r2 = p.request(toolReq('c', SENT), never());
	session.close();
	await r2;
	const out = JSON.stringify(log.records);
	assert.ok(log.records.some(x => x.msg.startsWith('permission')));
	assert.doesNotMatch(out, /SENTINEL/);
});
