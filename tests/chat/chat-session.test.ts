import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import {AUTH_MESSAGE, RESUME_MESSAGE} from '../../src/session.js';
import type {ChatQueryFn} from '../../src/types.js';
import {CONTINUE_TEXT, ChatSession} from '../../src/chat/chat-session.js';
import type {ChatEvent} from '../../src/chat/events.js';
import {MAX_QUEUE, PERMISSION_IDLE_MS, type PermissionDecision, type PermissionPrompter, type PermissionRequest} from '../../src/chat/permission.js';
import type {Clock} from '../../src/chat/limits.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const redact = (s: string) => s.split(SECRET).join('[redacted]');

class FakeQuery {
	closed = 0;
	interrupts = 0;
	interruptImpl: () => Promise<void> = () => Promise.resolve();
	readonly permissionModes: string[] = [];
	setPermissionModeImpl: () => Promise<void> = () => Promise.resolve();
	setPermissionMode(mode: string): Promise<void> {
		this.permissionModes.push(mode);
		return this.setPermissionModeImpl();
	}
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

const setup = (
	o: {timeoutMs?: number; graceMs?: number; initialResume?: string; clock?: Clock; onUsageLimit?: ConstructorParameters<typeof ChatSession>[0]['onUsageLimit']} = {},
) => {
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
	assert.equal(end?.type === 'turn-end' && end.error, 'Request timed out: no activity for 0 seconds');
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

const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

test('holds nest: the turn timer stays paused until the last release, which is idempotent', async () => {
	const {session, ends} = setup({timeoutMs: 80, graceMs: 10});
	session.send('x');
	const a = session.holdTurnTimer();
	const b = session.holdTurnTimer();
	await wait(200);
	assert.equal(ends().length, 0);
	a();
	a();
	await wait(200);
	assert.equal(ends().length, 0);
	b();
	await wait(200);
	const e = ends()[0];
	assert.equal(e?.type === 'turn-end' && e.outcome, 'timeout');
});

test('a permission prompt answered inside a hold does not restart the timer', async () => {
	const {session, ends} = setup({timeoutMs: 80, graceMs: 10});
	session.send('x');
	const release = session.holdTurnTimer();
	const r = (session as unknown as PermissionPrompter).request(toolReq('a'), never());
	session.answerPermission('a', {kind: 'allow'});
	await r;
	await wait(200);
	assert.equal(ends().length, 0);
	release();
	await wait(200);
	assert.equal(ends().length, 1);
});

test('a hold released while a prompt is pending keeps the timer paused', async () => {
	const {session, ends} = setup({timeoutMs: 80, graceMs: 10});
	session.send('x');
	const release = session.holdTurnTimer();
	const r = (session as unknown as PermissionPrompter).request(toolReq('a'), never());
	release();
	await wait(200);
	assert.equal(ends().length, 0);
	session.answerPermission('a', {kind: 'allow'});
	await r;
	await wait(200);
	assert.equal(ends().length, 1);
});

test('a stale release after the turn ended does not affect the next turn', async () => {
	const {session, queries, ends} = setup({timeoutMs: 80, graceMs: 10});
	session.send('x');
	const stale = session.holdTurnTimer();
	queries[0]!.emit(ok());
	await tick();
	assert.equal(session.state, 'idle');
	session.send('y');
	stale();
	const live = session.holdTurnTimer();
	stale();
	await wait(200);
	assert.equal(ends().length, 1);
	live();
	await wait(200);
	assert.equal(ends().length, 2);
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

test('"always" approvals are saved: they survive a respawn and a reset, and forget drops them', async () => {
	const saved: string[] = [];
	const log = makeFakeLog();
	const session = new ChatSession({
		query: (p => new FakeQuery(p.prompt, p.options) as never) as ChatQueryFn,
		buildOptions: () => ({}) as Options,
		redact,
		log,
		savedApprovals: ['npm test'],
		onRemember: key => void saved.push(key),
	});
	const p = session as unknown as PermissionPrompter;
	assert.equal(p.hasApproved('npm test'), true);
	p.remember('ls');
	p.remember('ls');
	p.remember('npm test');
	assert.deepEqual(saved, ['ls']);
	session.reset();
	assert.equal(p.hasApproved('ls'), true);
	session.forget('ls');
	assert.equal(p.hasApproved('ls'), false);
	session.close();
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
	session.setMode('plan');
	assert.equal(session.mode, 'plan');
	session.setMode('acceptEdits');
	assert.throws(() => session.setMode('dontAsk' as never), /Unknown permission mode/);
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

test('auto mode is passed to a running query and switching away restores default', async () => {
	const {session, queries} = setup();
	session.send('x');
	await tick();
	const q = queries[0]!;
	session.setMode('acceptEdits');
	assert.deepEqual(q.permissionModes, []);
	session.setMode('auto');
	session.setMode('acceptEdits');
	session.setMode('default');
	await tick();
	assert.deepEqual(q.permissionModes, ['auto', 'default']);
	session.close();
});

test('a rejected auto mode falls back to default with a redacted reason', async () => {
	const {session, queries, events} = setup();
	session.send('x');
	await tick();
	queries[0]!.setPermissionModeImpl = () => Promise.reject(new Error(`not available for ${SECRET}`));
	session.setMode('auto');
	await tick();
	await tick();
	assert.equal(session.mode, 'default');
	const last = events.filter(e => e.type === 'mode').at(-1) as {mode: string; error?: string};
	assert.equal(last.mode, 'default');
	assert.match(last.error ?? '', /not available for \[redacted\]/);
	session.close();
});

test('a prompter in auto mode reports it to buildOptions on the next spawn', () => {
	const {session, prompters} = setup();
	session.setMode('auto');
	session.send('x');
	assert.equal(prompters[0]?.mode, 'auto');
	session.close();
});

test('typed text starting with / is delivered as written; console commands are dispatched', async () => {
	const {session, queries} = setup();
	session.send('/etc/hosts looks odd');
	await tick();
	const q = queries[0]!;
	assert.equal((q.sent[0] as {client_composed?: boolean}).client_composed, true);
	q.emit(init());
	q.emit(ok());
	await tick();
	session.send('/compact', {command: true});
	await tick();
	assert.equal('client_composed' in q.sent[1]!, false);
	session.close();
});

test('the session learns its Claude Code commands from init and supportedCommands', async () => {
	const {session, queries} = setup();
	session.send('hi');
	await tick();
	const q = queries[0]!;
	q.emit({...init(), slash_commands: ['compact', 'pipeline', 'bad name']});
	await tick();
	assert.deepEqual(session.commands.map(c => c.name), ['compact', 'pipeline']);
	session.close();
});

test('supportedCommands adds descriptions and argument hints', async () => {
	const {session} = setup();
	const list = [{name: 'pipeline', description: 'Run it', argumentHint: '<request>'}, {name: 7}];
	const orig = FakeQuery.prototype as unknown as {supportedCommands?: () => Promise<unknown>};
	orig.supportedCommands = () => Promise.resolve(list);
	try {
		session.send('hi');
		await tick();
		await tick();
		assert.deepEqual(session.commands, [{name: 'pipeline', description: 'Run it', argumentHint: '<request>'}]);
	} finally {
		delete orig.supportedCommands;
		session.close();
	}
});

test('the turn timeout counts silence: any SDK message, subagents included, restarts it', async () => {
	const {session, queries, ends} = setup({timeoutMs: 60, graceMs: 10});
	session.send('x');
	await tick();
	const q = queries[0]!;
	for (let i = 0; i < 4; i++) {
		await new Promise(r => setTimeout(r, 40));
		q.emit({type: 'assistant', parent_tool_use_id: 'agent-1', message: {content: []}});
		await tick();
	}
	assert.equal(ends().length, 0, 'still running after 160 ms of steady activity');
	await new Promise(r => setTimeout(r, 120));
	assert.equal(ends().at(-1)?.type === 'turn-end' && ends().at(-1)!.outcome, 'timeout');
	session.close();
});

test('tasks are tracked from task messages; a settled background task keeps its flag and can be stopped', async () => {
	const {session, queries, events} = setup();
	session.send('x');
	await tick();
	const q = queries[0]! as FakeQuery & {stopTask?: (id: string) => Promise<void>; stopped?: string[]};
	q.stopped = [];
	q.stopTask = async id => void q.stopped!.push(id);
	q.emit({type: 'system', subtype: 'task_started', task_id: 't1', description: 'npm run watch', is_backgrounded: true});
	q.emit({type: 'system', subtype: 'task_started', task_id: 't2', description: 'coder agent'});
	q.emit({type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed', summary: 'done', output_file: 'x'});
	await tick();
	assert.deepEqual(
		session.tasks.map(t => [t.id, t.status, t.background]),
		[
			['t2', 'running', false],
			['t1', 'completed', true],
		],
	);
	const settled = events.find(e => e.type === 'ui' && e.event.kind === 'task' && e.event.status === 'completed') as {event: {background?: boolean}} | undefined;
	assert.equal(settled?.event.background, true);
	await session.stopTask('t2');
	assert.deepEqual(q.stopped, ['t2']);
	session.close();
});

const NOW_S = Math.floor(Date.now() / 1000);
const clock: Clock = {now: () => NOW_S * 1000, timeZone: 'UTC'};
const CLI_TEXT = "You've hit your limit · resets 3pm";
const limitError = () => ({type: 'assistant', error: 'rate_limit', message: {id: 'm', content: [{type: 'text', text: CLI_TEXT}]}, parent_tool_use_id: null});
const rejected = () => ({
	type: 'rate_limit_event',
	rate_limit_info: {status: 'rejected', resetsAt: NOW_S + 3600, rateLimitType: 'five_hour', utilization: 1},
});
const errResult = (extra: Record<string, unknown> = {}) => ({
	type: 'result',
	subtype: 'success',
	is_error: true,
	result: 'Prompt is too long',
	session_id: 'sess-1',
	...extra,
});

test('a usage limit ends the turn as limit, keeps the session and the query', async () => {
	const {session, queries, ends, log} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(rejected());
	queries[0]?.emit(limitError());
	queries[0]?.emit(errResult({result: CLI_TEXT}));
	await tick();
	const end = ends()[0] as {outcome: string; error?: string};
	assert.equal(end.outcome, 'limit');
	assert.match(end.error ?? '', /Usage limit reached/);
	assert.match(end.error ?? '', /resets at /);
	assert.equal(session.sessionId, 'sess-1');
	assert.equal(session.rateLimit?.status, 'rejected');
	assert.equal(queries[0]?.closed, 0);
	session.send('two');
	assert.equal(queries.length, 1);
	await tick();
	assert.equal(queries[0]?.sent.length, 2);
	const record = log.records.find(r => r.msg === 'turn ended');
	assert.equal(record?.fields['failure'], 'usage-limit');
	assert.ok(log.records.some(r => r.msg === 'rate limit' && r.fields['status'] === 'rejected' && r.fields['pct'] === 100));
	assert.ok(!JSON.stringify(log.records).includes('hit your limit'));
	session.close();
});

test('a usage limit with another account restarts Claude Code in the same session and continues the turn', async () => {
	const asked: unknown[] = [];
	let left = 1;
	const {session, queries, resumes, ends, events} = setup({
		clock,
		onUsageLimit: p => {
			asked.push(p);
			return left-- > 0 ? {from: 'work', to: 'spare'} : undefined;
		},
	});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(rejected());
	queries[0]?.emit(limitError());
	queries[0]?.emit(errResult({result: CLI_TEXT}));
	await tick();
	assert.deepEqual(ends(), [], 'the turn goes on');
	assert.equal(session.state, 'running');
	assert.deepEqual(asked, [{reason: 'usage-limit', rateLimit: {status: 'rejected', resetsAt: NOW_S + 3600, type: 'five_hour', utilization: 1}}]);
	assert.deepEqual(events.find(e => e.type === 'account'), {type: 'account', account: 'spare', previous: 'work', reason: 'usage-limit'});
	assert.equal(queries.length, 2);
	assert.equal(queries[0]?.closed, 1, 'the limited process is closed');
	assert.deepEqual(resumes, [undefined, 'sess-1'], 'the new process resumes the session');
	await tick();
	const pushed = queries[1]?.sent[0] as {message: {content: string}};
	assert.equal(pushed.message.content, CONTINUE_TEXT);
	assert.equal(events.filter(e => e.type === 'sent').length, 1, 'the continue message is not shown as typed');
	queries[1]?.emit(init());
	queries[1]?.emit(ok());
	await tick();
	assert.deepEqual(ends().map(e => (e as {outcome: string}).outcome), ['ok']);
	// The next limit has no account left: the turn ends as before.
	session.send('two');
	queries[1]?.emit(limitError());
	queries[1]?.emit(errResult({result: CLI_TEXT}));
	await tick();
	assert.equal((ends()[1] as {outcome: string}).outcome, 'limit');
	session.close();
});

test('a temporary rate limit without a rejected report is rate-limit', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: 'API Error: 429 Too many requests'}]}});
	queries[0]?.emit(errResult({result: 'API Error: 429'}));
	await tick();
	const end = ends()[0] as {outcome: string; error?: string};
	assert.equal(end.outcome, 'limit');
	assert.match(end.error ?? '', /Rate limited/);
	session.close();
});

test('blocking_limit ends as context and the next send reaches the same query', async () => {
	const {session, queries, ends, log} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'assistant', error: 'invalid_request', message: {content: [{type: 'text', text: 'Prompt is too long'}]}});
	queries[0]?.emit(errResult({terminal_reason: 'blocking_limit'}));
	await tick();
	const end = ends()[0] as {outcome: string; error?: string};
	assert.equal(end.outcome, 'context');
	assert.match(end.error ?? '', /context/);
	assert.equal(session.needsNewSession, false);
	assert.equal(queries[0]?.closed, 0);
	session.send('/compact', {command: true});
	await tick();
	assert.equal(queries.length, 1);
	const sent = queries[0]?.sent.at(-1);
	assert.equal(sent?.message.content, '/compact');
	assert.equal('client_composed' in (sent ?? {}), false);
	assert.equal(log.records.find(r => r.msg === 'turn ended')?.fields['failure'], 'context');
	session.close();
});

test('prompt_too_long result without an assistant error is context', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(errResult({terminal_reason: 'prompt_too_long', result: ''}));
	await tick();
	assert.equal((ends()[0] as {outcome: string}).outcome, 'context');
	session.close();
});

test('api_retry for a rate limit does not end the turn', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5, retry_delay_ms: 1000, error: 'rate_limit'});
	await tick();
	assert.equal(ends().length, 0);
	assert.equal(session.state, 'running');
	queries[0]?.emit(ok());
	await tick();
	assert.equal((ends()[0] as {outcome: string}).outcome, 'ok');
	session.close();
});

test('a rejected report during a turn that succeeds still ends ok', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(rejected());
	queries[0]?.emit(ok());
	await tick();
	assert.equal((ends()[0] as {outcome: string}).outcome, 'ok');
	assert.equal(session.rateLimit?.status, 'rejected');
	session.close();
});

test('the limit state of an earlier turn does not leak into a later generic error', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(limitError());
	queries[0]?.emit(errResult({result: CLI_TEXT}));
	await tick();
	session.send('two');
	queries[0]?.emit({type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], session_id: 'sess-1'});
	await tick();
	assert.equal((ends()[1] as {outcome: string}).outcome, 'error');
	session.close();
});

test('rate limit logging fires on status or type change; pct-only changes are debug', async () => {
	const {session, queries, log} = setup({clock});
	session.send('one');
	const ev = (status: string, utilization: number) => ({
		type: 'rate_limit_event',
		rate_limit_info: {status, rateLimitType: 'five_hour', utilization, resetsAt: NOW_S + 600},
	});
	queries[0]?.emit(ev('allowed', 0.5));
	queries[0]?.emit(ev('allowed', 0.6));
	queries[0]?.emit(ev('allowed_warning', 0.9));
	await tick();
	const rl = log.records.filter(r => r.msg === 'rate limit');
	assert.deepEqual(rl.map(r => r.level), ['info', 'debug', 'info']);
	assert.equal(rl[2]?.fields['resetsInMin'], 10);
	session.close();
});

test('a stream that ends after a limit result resumes with the saved session id', async () => {
	const {session, queries, resumes, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(limitError());
	queries[0]?.emit(errResult({result: CLI_TEXT}));
	queries[0]?.end();
	await tick();
	assert.equal(ends().length, 1);
	assert.equal((ends()[0] as {outcome: string}).outcome, 'limit');
	session.send('two');
	assert.equal(queries.length, 2);
	assert.deepEqual(resumes, [undefined, 'sess-1']);
	session.close();
});

test('a stream that ends after a limit error without a result is a limit', async () => {
	const {session, queries, ends} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(rejected());
	queries[0]?.emit(limitError());
	queries[0]?.end();
	await tick();
	assert.equal((ends()[0] as {outcome: string}).outcome, 'limit');
	session.close();
});

test('limit and context turns log the failure kind and no reason or CLI text', async () => {
	const {session, queries, log} = setup({clock});
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit({type: 'assistant', error: 'rate_limit', message: {content: [{type: 'text', text: `You've hit your limit ${SECRET}`}]}});
	queries[0]?.emit(errResult({result: 'x'}));
	await tick();
	const ended = log.records.find(r => r.msg === 'turn ended')!;
	assert.equal(ended.fields['failure'], 'usage-limit');
	assert.equal('reason' in ended.fields, false);
	assert.ok(!JSON.stringify(log.records).includes('hit your limit'));
	session.close();
});

test('the injected clock validates resetsAt of rate limit events', async () => {
	const FAR = 4_000_000_000;
	const {session, queries} = setup({clock: {now: () => FAR * 1000, timeZone: 'UTC'}});
	session.send('one');
	queries[0]?.emit({type: 'rate_limit_event', rate_limit_info: {status: 'rejected', resetsAt: FAR + 600}});
	await tick();
	assert.equal(session.rateLimit?.resetsAt, FAR + 600);
	session.close();
});

const fakeTurnLock = (busy = false) => {
	const calls: string[] = [];
	let refuse = busy;
	return {
		calls,
		refuse: (on: boolean) => void (refuse = on),
		lock: {
			acquire: () => {
				if (refuse) throw new Error('Another session is working right now');
				calls.push('acquire');
			},
			release: () => void calls.push('release'),
		},
	};
};
const task = (id: string, subtype: 'task_started' | 'task_notification', status?: string) => ({
	type: 'system',
	subtype,
	task_id: id,
	description: 'bg',
	is_backgrounded: true,
	...(status && {status}),
});

test('the turn lock is held only while the chat works', async () => {
	const t = fakeTurnLock();
	const {session, queries} = setup({turnLock: t.lock} as never);
	assert.deepEqual(t.calls, [], 'opening takes nothing');
	session.send('one');
	assert.deepEqual(t.calls, ['acquire']);
	queries[0]?.emit(init());
	queries[0]?.emit(ok());
	await tick();
	assert.deepEqual(t.calls, ['acquire', 'release'], 'released when the turn ends');
	session.send('two');
	assert.deepEqual(t.calls, ['acquire', 'release', 'acquire']);
	session.close();
	assert.deepEqual(t.calls, ['acquire', 'release', 'acquire', 'release'], 'released on close');
});

test('a background task keeps the lock until it ends', async () => {
	const t = fakeTurnLock();
	const {session, queries} = setup({turnLock: t.lock} as never);
	session.send('start a server');
	queries[0]?.emit(init());
	queries[0]?.emit(task('b1', 'task_started'));
	queries[0]?.emit(ok());
	await tick();
	assert.deepEqual(t.calls, ['acquire'], 'still working in the background');
	queries[0]?.emit(task('b1', 'task_notification', 'completed'));
	await tick();
	await tick();
	assert.deepEqual(t.calls, ['acquire', 'release']);
});

test('a refused send sends nothing and leaves the chat idle', async () => {
	const t = fakeTurnLock(true);
	const {session, queries, events} = setup({turnLock: t.lock} as never);
	assert.throws(() => session.send('hi'), /Another session is working/);
	assert.equal(session.state, 'idle');
	assert.equal(queries.length, 0, 'no Claude Code process was started');
	assert.ok(!events.some(e => e.type === 'sent'));
	t.refuse(false);
	session.send('hi');
	assert.equal(session.state, 'running');
});

test('an idle chat ends its Claude Code process and resumes the session on the next message', async () => {
	const {session, queries, resumes} = setup({idleCloseMs: 20} as never);
	session.send('one');
	queries[0]?.emit(init('sess-9'));
	queries[0]?.emit(ok(0.1, 'sess-9'));
	await tick();
	assert.equal(queries[0]?.closed, 0, 'not at once: Claude Code may still write the title');
	await new Promise(r => setTimeout(r, 40));
	assert.equal(queries[0]?.closed, 1);
	session.send('two');
	assert.equal(queries.length, 2);
	assert.deepEqual(resumes, [undefined, 'sess-9']);
});

test('a message before the idle close keeps the same process', async () => {
	const {session, queries} = setup({idleCloseMs: 30} as never);
	session.send('one');
	queries[0]?.emit(init());
	queries[0]?.emit(ok());
	await tick();
	session.send('two');
	await new Promise(r => setTimeout(r, 50));
	assert.equal(queries.length, 1);
	assert.equal(queries[0]?.closed, 0, 'a running turn is never closed');
});

const cliState = (state: 'running' | 'idle') => ({type: 'system', subtype: 'session_state_changed', state, session_id: 'sess-1'});

test('a turn Claude Code starts itself (a background task finished) runs like a sent one', async () => {
	const t = fakeTurnLock();
	const {session, queries, events, ends} = setup({turnLock: t.lock, idleCloseMs: 20} as never);
	session.send('start a server');
	const q = queries[0]!;
	q.emit(cliState('running'));
	q.emit(init());
	q.emit(task('b1', 'task_started'));
	q.emit(ok());
	q.emit(cliState('idle'));
	await tick();
	assert.equal(session.state, 'idle');
	q.emit(task('b1', 'task_notification', 'completed'));
	await tick();
	await tick();
	assert.deepEqual(t.calls, ['acquire', 'release']);
	q.emit(cliState('running'));
	await tick();
	assert.equal(session.state, 'running', 'the notification turn shows as work');
	assert.deepEqual(t.calls, ['acquire', 'release', 'acquire']);
	await new Promise(r => setTimeout(r, 40));
	assert.equal(q.closed, 0, 'the idle close never ends a running turn');
	q.emit(ok());
	q.emit(cliState('idle'));
	await tick();
	assert.equal(session.state, 'idle');
	assert.deepEqual(ends().map(e => e.type === 'turn-end' && e.outcome), ['ok', 'ok']);
	assert.ok(!events.some(e => e.type === 'sent' && e.text !== 'start a server'), 'nothing was sent for it');
	assert.deepEqual(t.calls, ['acquire', 'release', 'acquire', 'release']);
	await new Promise(r => setTimeout(r, 40));
	assert.equal(q.closed, 1, 'closed once idle again');
});

test('a running state report during a sent turn changes nothing', async () => {
	const {session, queries, ends} = setup();
	session.send('one');
	queries[0]?.emit(cliState('running'));
	queries[0]?.emit(ok());
	await tick();
	assert.equal(session.state, 'idle');
	assert.equal(ends().length, 1);
});

test('a message sent while Claude Code runs its own turn is refused, so the view queues it', async () => {
	const {session, queries} = setup();
	session.send('one');
	queries[0]?.emit(ok());
	await tick();
	queries[0]?.emit(cliState('running'));
	await tick();
	assert.throws(() => session.send('two'), /already running/);
});

test('a turn logs its token counts, subagents apart', async () => {
	const {session, queries, log} = setup();
	session.send('x');
	const usage = {input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5};
	queries[0]?.emit({type: 'assistant', parent_tool_use_id: null, message: {id: 'm1', usage, content: []}});
	queries[0]?.emit({type: 'assistant', parent_tool_use_id: 'toolu_1', message: {id: 'm2', usage, content: []}});
	queries[0]?.emit({type: 'assistant', parent_tool_use_id: 'toolu_1', message: {id: 'm3', usage, content: []}});
	queries[0]?.emit(ok());
	await tick();
	const ended = log.records.find(r => r.msg === 'turn ended')!;
	assert.equal(ended.fields.calls, 1);
	assert.equal(ended.fields.cacheWrite, 10);
	assert.equal(ended.fields.agentCalls, 2);
	assert.equal(ended.fields.agentCacheRead, 200);
	assert.equal(session.usage.agents.output, 10);
});
