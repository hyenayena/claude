import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, test} from 'node:test';
import React from 'react';
import type {CanUseTool, Options} from '@anthropic-ai/claude-agent-sdk';
import {ChatSession} from '../../src/chat/chat-session.js';
import {createChatCanUseTool} from '../../src/chat/permission-bridge.js';
import {makeReveal} from '../../src/chat/reveal.js';
import {makeScrub} from '../../src/chat/scrub.js';
import {buildScope} from '../../src/policy.js';
import {ChatView} from '../../src/ui/ChatView.js';
import {mountHarness} from './testkit.js';

const reveal = makeReveal(s => s);
const scrub = makeScrub(s => s);
const ARM = 40;
const ESC = '\u001b';
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Script = (can: CanUseTool, signal: AbortSignal) => Promise<unknown>;

const dirs: string[] = [];
let cleanup: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
	for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

function build(script: Script) {
	const root = mkdtempSync(join(tmpdir(), 'chat-int-'));
	dirs.push(root);
	const proj = join(root, 'proj');
	const data = join(root, 'data');
	const md = join(proj, '.yena', 'md');
	mkdirSync(md, {recursive: true});
	mkdirSync(data);
	writeFileSync(join(proj, 'package.json'), '{}\n');
	writeFileSync(join(proj, 'CLAUDE.md'), 'x\n');
	symlinkSync(join(proj, 'package.json'), join(proj, 'link-pkg'));
	symlinkSync(join(proj, 'CLAUDE.md'), join(proj, 'link-claude'));
	mkdirSync(join(proj, 'realdir'));
	symlinkSync(join(proj, 'realdir'), join(proj, 'dirlink'));
	const scope = buildScope({
		projectDir: proj,
		mdDir: md,
		configDir: join(data, 'config'),
		stateFile: join(data, 'state.json'),
		credentialsFile: join(data, 'credentials.json'),
	});
	const results: unknown[] = [];
	const state = {closed: 0};
	const session = new ChatSession({
		redact: s => s,
		query: ((p: {prompt: AsyncIterable<unknown>; options: Options}) => {
			const q = {
				close() {
					state.closed++;
				},
				async interrupt() {},
				async *[Symbol.asyncIterator]() {
					yield {type: 'system', subtype: 'init', session_id: 's1', model: 'm', apiKeySource: 'env'};
					for await (const _ of p.prompt) {
						const ac = new AbortController();
						results.push(await script(p.options.canUseTool as CanUseTool, ac.signal));
						yield {type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's1', total_cost_usd: 0};
					}
				},
			};
			return q;
		}) as never,
		buildOptions: (_ac, _resume, prompter) =>
			({canUseTool: createChatCanUseTool({scope, projectDir: proj, mdDir: md, prompter})}) as Options,
	});
	const printed: string[] = [];
	const h = mountHarness(
		<ChatView
			controller={session}
			print={s => printed.push(s.replace(SGR, '').trim())}
			close={() => {}}
			scrub={scrub}
			reveal={reveal}
			credentialLabel="API key"
			armMs={ARM}
			projectDir={proj}
		/>,
	);
	cleanup.push(() => {
		h.unmount();
		session.close();
	});
	return {session, h, printed, results, proj, state};
}

const toolCall = (can: CanUseTool, signal: AbortSignal, name: string, input: Record<string, unknown>, id: string) =>
	can(name, input, {signal, toolUseID: id} as never);

test('y at the prompt resolves the bridge call as allow and prints one audit line', async () => {
	const t = build((can, signal) => toolCall(can, signal, 'Bash', {command: 'echo hi'}, 'u1'));
	await wait(50);
	t.h.press('draft text');
	await wait(30);
	t.session.send('go');
	await wait(ARM + 150);
	assert.equal(t.session.pendingPermissions.length, 1);
	assert.doesNotMatch(t.h.lastFrame(), /draft text/);
	t.h.press('y');
	await wait(120);
	assert.equal((t.results[0] as {behavior: string}).behavior, 'allow');
	assert.deepEqual(t.printed.filter(p => /^Allowed Bash/.test(p)), ['Allowed Bash: echo hi']);
	assert.match(t.h.lastFrame(), /draft text/);
});

test('a double-tapped Enter before arming approves neither of two queued prompts', async () => {
	const t = build(async (can, signal) =>
		Promise.all([
			toolCall(can, signal, 'Bash', {command: 'echo one'}, 'a'),
			toolCall(can, signal, 'Bash', {command: 'echo two'}, 'b'),
		]),
	);
	t.session.send('go');
	await wait(30);
	t.h.press('\r');
	t.h.press('\r');
	await wait(10);
	assert.equal(t.session.pendingPermissions.length, 2);
});

test('unmounting with a prompt pending resolves the bridge call as a cancel and closes the query', async () => {
	let pending: Promise<unknown> | undefined;
	const t = build((can, signal) => (pending = toolCall(can, signal, 'Bash', {command: 'echo pend'}, 'p')));
	t.session.send('go');
	await wait(ARM + 150);
	assert.equal(t.session.pendingPermissions.length, 1);
	t.h.unmount();
	await wait(50);
	const settled = await Promise.race([pending, wait(500).then(() => 'still pending')]);
	assert.equal((settled as {behavior: string}).behavior, 'deny');
	assert.match((settled as {message: string}).message, /cancelled/);
	assert.equal(t.session.pendingPermissions.length, 0);
	assert.equal(t.state.closed, 1);
});

test('accept-edits mode auto-accepts eligible writes only; guarded and linked targets never auto-accept', async () => {
	const t = build(async (can, signal) => {
		const out: string[] = [];
		const inputs: Array<[string, string]> = [
			['new.txt', 'a\nb'],
			['CLAUDE.md', 'x'],
			['link-claude', 'x'],
			['link-pkg', 'x'],
		];
		for (const [i, [file, content]] of inputs.entries()) {
			const r = (await toolCall(can, signal, 'Write', {file_path: join(t.proj, file), content}, `w${i}`)) as {behavior: string};
			out.push(`${file}:${r.behavior}`);
		}
		return out;
	});
	await wait(100);
	t.h.press(`${ESC}[Z`);
	await wait(ARM + 60);
	t.h.press('\r');
	await wait(60);
	assert.equal(t.session.mode, 'acceptEdits');
	t.session.send('go');
	await wait(ARM + 250);
	const pendingPaths = t.session.pendingPermissions.map(r => (r.kind === 'tool' ? r.path : undefined));
	assert.deepEqual(pendingPaths, [join(t.proj, 'link-pkg')]);
	t.h.press('n');
	await wait(150);
	assert.deepEqual(t.results[0], ['new.txt:allow', 'CLAUDE.md:deny', 'link-claude:deny', 'link-pkg:deny']);
	assert.ok(!existsSync(join(t.proj, 'new.txt')));
	assert.ok(t.printed.some(p => /^Auto-accepted Write: .*new\.txt/.test(p)));
	assert.ok(t.printed.some(p => /^Blocked Write: .*CLAUDE\.md/.test(p)));
});

test('a write through a directory symlink shows where it resolves and audits both paths', async () => {
	const t = build((can, signal) =>
		toolCall(can, signal, 'Write', {file_path: join(t.proj, 'dirlink', 'n.txt'), content: 'a\n'}, 'w'),
	);
	t.session.send('go');
	await wait(ARM + 250);
	assert.match(t.h.lastFrame(), /resolves to: .*realdir\/n\.txt/);
	t.h.press('y');
	await wait(150);
	assert.equal((t.results[0] as {behavior: string}).behavior, 'allow');
	assert.ok(t.printed.some(p => /^Allowed Write: .*dirlink\/n\.txt -> .*realdir\/n\.txt/.test(p)), t.printed.join('|'));
});
