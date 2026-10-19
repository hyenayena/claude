import assert from 'node:assert/strict';
import {mkdirSync, symlinkSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';
import {createChatCanUseTool} from '../../src/chat/permission-bridge.js';
import {
	CANCEL_MESSAGE,
	DENY_MESSAGE,
	DISMISS_MESSAGE,
	type AuditEntry,
	type ChatMode,
	type PermissionDecision,
	type PermissionPrompter,
	type PermissionRequest,
	POLICY_DENY,
	QUESTION_LIMITS,
	toolUnavailableMessage,
} from '../../src/chat/permission.js';
import {buildScope} from '../../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-bridge-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const projectDir = path.join(tmp, 'project');
const mdDir = path.join(projectDir, '.yena', 'claude', 'md');
mkdirSync(mdDir, {recursive: true});
mkdirSync(path.join(projectDir, 'src'), {recursive: true});
mkdirSync(path.join(tmp, 'outside'));
writeFileSync(path.join(projectDir, 'src', 'a.ts'), 'x\n');
const scope = buildScope({
	projectDir,
	mdDir,
	configDir: path.join(tmp, 'config'),
	tokenFile: path.join(tmp, 'config', '.token'),
	stateFile: path.join(projectDir, '.yena', 'claude', 'state.json'),
	credentialsFile: path.join(tmp, 'creds'),
}, path.join(tmp, 'home'));

class FakePrompter implements PermissionPrompter {
	mode: ChatMode = 'default';
	requests: PermissionRequest[] = [];
	audits: AuditEntry[] = [];
	approved = new Set<string>();
	next: PermissionDecision | ((r: PermissionRequest) => PermissionDecision) = {kind: 'allow'};
	throws = false;
	request(req: PermissionRequest): Promise<PermissionDecision> {
		this.requests.push(req);
		if (this.throws) return Promise.reject(new Error('boom'));
		return Promise.resolve(typeof this.next === 'function' ? this.next(req) : this.next);
	}
	hasApproved(k: string) {
		return this.approved.has(k);
	}
	remember(k: string) {
		this.approved.add(k);
	}
	audit(e: AuditEntry) {
		this.audits.push(e);
	}
	modes: ChatMode[] = [];
	setMode(m: ChatMode) {
		this.modes.push(m);
		this.mode = m;
	}
}

const setup = (extra: Partial<Parameters<typeof createChatCanUseTool>[0]> = {}) => {
	const prompter = new FakePrompter();
	const tool: CanUseTool = createChatCanUseTool({scope, projectDir, mdDir, prompter, ...extra});
	const call = (name: string, input: Record<string, unknown>, o: Record<string, unknown> = {}) =>
		tool(name, input, {signal: new AbortController().signal, toolUseID: 'tu1', suggestions: undefined, ...o} as never);
	return {prompter, call, tool};
};
const bashSuggest = [{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'ls:*'}], behavior: 'allow', destination: 'session'}];
const noExtras = (r: unknown) => {
	assert.ok(r !== null);
	assert.equal('updatedPermissions' in (r as object), false);
	assert.equal('interrupt' in (r as object), false);
};
const f = (name: string) => path.join(projectDir, name);

test('Bash allow returns the identical input object without updatedPermissions', async () => {
	const {call, prompter} = setup();
	const input = {command: 'ls -la'};
	const r = await call('Bash', input, {suggestions: bashSuggest});
	assert.equal(r?.behavior, 'allow');
	assert.equal(r?.behavior === 'allow' && r.updatedInput, input);
	assert.equal(r?.behavior === 'allow' && r.toolUseID, 'tu1');
	noExtras(r);
	assert.equal(prompter.requests.length, 1);
});

test('deny gives the fixed text and a sanitized, capped reason', async () => {
	const {call, prompter} = setup();
	prompter.next = {kind: 'deny'};
	let r = await call('Bash', {command: 'ls'});
	assert.deepEqual(r, {behavior: 'deny', message: DENY_MESSAGE, toolUseID: 'tu1'});
	prompter.next = {kind: 'deny', reason: `use\u001b[31m git\n${'x'.repeat(900)}`};
	r = await call('Bash', {command: 'ls'});
	assert.equal(r?.behavior, 'deny');
	const msg = r?.behavior === 'deny' ? r.message : '';
	assert.ok(msg.startsWith(`${DENY_MESSAGE} User's reason: use git xxx`));
	assert.doesNotMatch(msg, /[\u0000-\u001f]/);
	assert.ok(msg.length <= DENY_MESSAGE.length + 20 + 500);
	noExtras(r);
});

test('every cancel cause gives the cancel message', async () => {
	const {call, prompter} = setup();
	for (const cause of ['aborted', 'interrupted', 'closed', 'timeout', 'replaced'] as const) {
		prompter.next = {kind: 'cancel', cause};
		const r = await call('Bash', {command: 'ls'});
		assert.deepEqual(r, {behavior: 'deny', message: CANCEL_MESSAGE, toolUseID: 'tu1'});
	}
});

test('a stop decision never sets interrupt', async () => {
	const {call, prompter} = setup();
	prompter.next = {kind: 'deny', stop: true};
	noExtras(await call('Bash', {command: 'ls'}));
});

test('abort resolves a pending request as a deny', async () => {
	const {tool, prompter} = setup();
	prompter.request = () => new Promise(() => {});
	const ac = new AbortController();
	const p = tool('Bash', {command: 'ls'}, {signal: ac.signal, toolUseID: 't'} as never);
	ac.abort();
	assert.deepEqual(await p, {behavior: 'deny', message: CANCEL_MESSAGE, toolUseID: 't'});
	assert.deepEqual(await tool('Bash', {command: 'ls'}, {signal: AbortSignal.abort(), toolUseID: 't'} as never), {
		behavior: 'deny',
		message: CANCEL_MESSAGE,
		toolUseID: 't',
	});
});

test('a throwing prompter gives a deny, never null', async () => {
	const {call, prompter} = setup();
	prompter.throws = true;
	const r = await call('Bash', {command: 'ls'});
	assert.equal(r?.behavior, 'deny');
	const bad = await call('Bash', null as never);
	assert.equal(bad?.behavior, 'deny');
	const h = setup({highlights: () => {
		throw new Error('x');
	}});
	assert.deepEqual(await h.call('Bash', {command: 'ls'}), {
		behavior: 'deny',
		message: 'Permission handling failed',
		toolUseID: 'tu1',
	});
});

test('a sandbox override is denied before prompting; background commands are asked like any other', async () => {
	const {call, prompter} = setup();
	const r = await call('Bash', {command: 'ls', dangerouslyDisableSandbox: true});
	assert.equal(r?.behavior === 'deny' && r.message, POLICY_DENY.background);
	assert.equal(prompter.requests.length, 0);
	assert.equal(prompter.audits.at(-1)?.outcome, 'denied-by-policy');
	prompter.next = {kind: 'allow'};
	assert.equal((await call('Bash', {command: 'npm run watch', run_in_background: true}))?.behavior, 'allow');
	assert.equal(prompter.requests.length, 1);
});

test('invalid inputs are denied without prompting', async () => {
	const {call, prompter} = setup();
	const cases: Array<[string, Record<string, unknown>]> = [
		['Bash', {}],
		['Bash', {command: 5}],
		['Bash', {command: '  '}],
		['Bash', {command: 'ls', description: 3}],
		['Edit', {file_path: f('src/a.ts'), old_string: 'a'}],
		['Edit', {file_path: 3, old_string: 'a', new_string: 'b'}],
		['Edit', {file_path: f('src/a.ts'), old_string: 'a', new_string: 'b', replace_all: 'y'}],
		['Write', {file_path: f('src/a.ts')}],
		['AskUserQuestion', {}],
		['AskUserQuestion', {questions: []}],
	];
	for (const [name, input] of cases) {
		const r = await call(name, input);
		assert.equal(r?.behavior === 'deny' && r.message, POLICY_DENY.invalidInput, `${name} ${JSON.stringify(input)}`);
	}
	assert.equal(prompter.requests.length, 0);
});

test('unknown tools are denied', async () => {
	const {call, prompter} = setup();
	const r = await call('NotebookEdit', {notebook_path: 'x'});
	assert.deepEqual(r, {behavior: 'deny', message: toolUnavailableMessage('NotebookEdit'), toolUseID: 'tu1'});
	assert.equal(prompter.requests.length, 0);
});

test('Read inside scope is allowed, outside is denied without a prompt', async () => {
	const {call, prompter} = setup();
	const inside = await call('Read', {file_path: f('src/a.ts')});
	assert.equal(inside?.behavior, 'allow');
	const out = await call('Read', {file_path: path.join(tmp, 'outside', 'x')});
	assert.equal(out?.behavior, 'deny');
	assert.equal(prompter.requests.length, 0);
	assert.deepEqual(prompter.audits.map(a => a.outcome), ['denied-by-policy']);
});

test('Edit and Write outside, guard and secret paths are denied even if the prompter would allow', async () => {
	for (const mode of ['default', 'acceptEdits'] as const) {
		const {call, prompter} = setup();
		prompter.mode = mode;
		const targets: Array<[string, string]> = [
			[path.join(tmp, 'outside', 'x.txt'), POLICY_DENY.outside],
			['../escape.txt', POLICY_DENY.outside],
			[f('CLAUDE.md'), POLICY_DENY.guard],
			[f('.claude/settings.json'), POLICY_DENY.guard],
			[f('.env'), POLICY_DENY.secret],
			[f('src/key.pem'), POLICY_DENY.secret],
		];
		for (const [file, msg] of targets) {
			const e = await call('Edit', {file_path: file, old_string: 'a', new_string: 'b'});
			assert.equal(e?.behavior === 'deny' && e.message, msg, file);
			const w = await call('Write', {file_path: file, content: 'x'});
			assert.equal(w?.behavior === 'deny' && w.message, msg, file);
		}
		assert.equal(prompter.requests.length, 0);
	}
});

test('default mode prompts for eligible edits and passes the preview and CLI note', async () => {
	const preview = {rows: [], added: 1, removed: 0, truncated: false, approximate: false};
	const {call, prompter} = setup({preview: async () => preview});
	const input = {file_path: f('src/a.ts'), old_string: 'a', new_string: 'b'};
	const r = await call('Edit', input, {decisionReason: 'because', description: 'edit it'});
	assert.equal(r?.behavior, 'allow');
	assert.equal(r?.behavior === 'allow' && r.updatedInput, input);
	const req = prompter.requests[0];
	assert.equal(req?.kind === 'tool' && req.preview, preview);
	assert.equal(req?.kind === 'tool' && req.always, false);
	assert.equal(req?.kind === 'tool' && req.path, input.file_path);
	assert.deepEqual(req?.kind === 'tool' && req.cliNote, {text: 'because'});
	assert.equal(req?.kind === 'tool' && req.description, 'edit it');
	noExtras(r);
});

test('a slow or failing preview yields no preview', async () => {
	const slow = setup({preview: () => new Promise(() => {}), previewTimeoutMs: 20});
	await slow.call('Write', {file_path: f('src/n.ts'), content: 'x'});
	assert.equal((slow.prompter.requests[0] as {preview?: unknown}).preview, undefined);
	const bad = setup({preview: () => Promise.reject(new Error('x'))});
	await bad.call('Write', {file_path: f('src/n.ts'), content: 'x'});
	assert.equal((bad.prompter.requests[0] as {preview?: unknown}).preview, undefined);
});

test('acceptEdits auto-accepts only eligible paths and audits with line counts', async () => {
	const {call, prompter} = setup();
	prompter.mode = 'acceptEdits';
	const r = await call('Edit', {file_path: f('src/a.ts'), old_string: 'a\nb', new_string: 'x\ny\nz'});
	assert.equal(r?.behavior, 'allow');
	noExtras(r);
	assert.equal(prompter.requests.length, 0);
	assert.equal(prompter.audits[0]?.outcome, 'auto-accepted');
	assert.match(prompter.audits[0]?.summary ?? '', /src\/a\.ts \(\+3 -2\)$/);
	const w = await call('Write', {file_path: f('src/new.ts'), content: 'l1\nl2'});
	assert.equal(w?.behavior, 'allow');
	assert.match(prompter.audits[1]?.summary ?? '', /\(\+2 -0\)$/);
	assert.equal(prompter.requests.length, 0);
});

test('acceptEdits still prompts for markdown-adjacent, dotfile, build and decision-reason cases', async () => {
	const {call, prompter} = setup();
	prompter.mode = 'acceptEdits';
	const base = {old_string: 'a', new_string: 'b'};
	await call('Edit', {file_path: path.join(mdDir, 'notes.md'), ...base});
	await call('Edit', {file_path: f('.git/config'), ...base});
	await call('Edit', {file_path: f('package.json'), ...base});
	await call('Edit', {file_path: f('src/a.ts'), ...base}, {decisionReasonType: 'workingDir'} as never);
	await call('Edit', {file_path: f('src/a.ts'), ...base}, {defaultToNo: true});
	assert.equal(prompter.requests.length, 5);
	assert.equal(prompter.audits.filter(a => a.outcome === 'auto-accepted').length, 0);
});

test('always: eligible command is remembered and the second identical one is auto-allowed', async () => {
	const {call, prompter} = setup();
	prompter.next = {kind: 'allow', always: true};
	const o = {suggestions: bashSuggest};
	await call('Bash', {command: 'npm test'}, o);
	const req = prompter.requests[0];
	assert.ok(req?.kind === 'tool' && req.always !== false);
	assert.deepEqual([...prompter.approved], ['npm test']);
	const again = await call('Bash', {command: 'npm test'}, o);
	assert.equal(again?.behavior, 'allow');
	noExtras(again);
	assert.equal(prompter.requests.length, 1);
	assert.equal(prompter.audits.at(-1)?.outcome, 'always-allowed');
	await call('Bash', {command: 'npm test2'}, o);
	assert.equal(prompter.requests.length, 2);
});

test('always is not offered or remembered for ineligible commands', async () => {
	const long = `echo ${'a'.repeat(2100)}`;
	const cases: Array<[string, Record<string, unknown>]> = [
		['rm *', {suggestions: bashSuggest}],
		['echo a\necho b', {suggestions: bashSuggest}],
		[long, {suggestions: bashSuggest}],
		['ls', {suggestions: bashSuggest, suppressAlwaysAllowRule: true}],
		['ls', {suggestions: bashSuggest, defaultToNo: true}],
		['ls', {suggestions: bashSuggest, decisionReasonType: 'safetyCheck'}],
		['ls', {}],
		['ls', {suggestions: [{type: 'addDirectories', directories: ['/x'], destination: 'session'}]}],
	];
	for (const [command, o] of cases) {
		const {call, prompter} = setup();
		prompter.next = {kind: 'allow', always: true};
		await call('Bash', {command}, o);
		const req = prompter.requests[0];
		assert.equal(req?.kind === 'tool' && req.always, false, command.slice(0, 20) + JSON.stringify(o));
		assert.equal(prompter.approved.size, 0);
	}
	const w = setup({highlights: () => [{level: 'warn', text: 'danger'}]});
	w.prompter.next = {kind: 'allow', always: true};
	await w.call('Bash', {command: 'ls'}, {suggestions: bashSuggest});
	assert.equal(w.prompter.approved.size, 0);
});

test('the always memory is bypassed by defaultToNo, safetyCheck, rule and warn highlights', async () => {
	for (const o of [{defaultToNo: true}, {decisionReasonType: 'safetyCheck'}, {decisionReasonType: 'rule'}]) {
		const {call, prompter} = setup();
		prompter.approved.add('ls');
		await call('Bash', {command: 'ls'}, o);
		assert.equal(prompter.requests.length, 1, JSON.stringify(o));
	}
	const w = setup({highlights: () => [{level: 'warn', text: 'danger'}]});
	w.prompter.approved.add('ls');
	await w.call('Bash', {command: 'ls'});
	assert.equal(w.prompter.requests.length, 1);
});

test('a Bash request carries highlights, cwd and the oversize flag', async () => {
	const hl = [{level: 'info' as const, text: 'sudo'}];
	const {call, prompter} = setup({highlights: () => hl});
	await call('Bash', {command: 'x'.repeat(25_000)});
	const req = prompter.requests[0];
	assert.ok(req?.kind === 'tool');
	assert.equal(req.highlights, hl);
	assert.equal(req.cwd, projectDir);
	assert.equal(req.oversize, true);
});

const Q = (over: Record<string, unknown> = {}) => ({
	question: 'Color?',
	header: 'Color',
	multiSelect: false,
	options: [
		{label: 'Red', description: 'r', preview: 'SECRET-PREVIEW'},
		{label: 'Blue', description: 'b'},
	],
	...over,
});

test('AskUserQuestion: single answer is returned keyed by question text', async () => {
	const { call, prompter} = setup();
	prompter.next = {kind: 'answers', answers: {'Color?': 'Red'}};
	const input = {questions: [Q()]};
	const r = await call('AskUserQuestion', input);
	assert.equal(r?.behavior, 'allow');
	assert.deepEqual(r?.behavior === 'allow' && r.updatedInput, {...input, answers: {'Color?': 'Red'}});
	noExtras(r);
	const req = prompter.requests[0];
	assert.ok(req?.kind === 'question');
	assert.doesNotMatch(JSON.stringify(req), /SECRET-PREVIEW/);
});

test('AskUserQuestion: multi-select, free text and four questions', async () => {
	const { call, prompter} = setup();
	const qs = [1, 2, 3, 4].map(i => Q({question: `Q${i}?`, multiSelect: i === 1}));
	prompter.next = {
		kind: 'answers',
		answers: {'Q1?': 'Red, Blue', 'Q2?': 'Huge (my own text)', 'Q3?': `a\u001b[31m\nb${'z'.repeat(800)}`, 'Q4?': 'Blue', 'Extra?': 'ignored'},
	};
	const r = await call('AskUserQuestion', {questions: qs});
	const answers = (r?.behavior === 'allow' ? r.updatedInput?.answers : undefined) as Record<string, string>;
	assert.deepEqual(Object.keys(answers), ['Q1?', 'Q2?', 'Q3?', 'Q4?']);
	assert.equal(answers['Q1?'], 'Red, Blue');
	assert.equal(answers['Q2?'], 'Huge (my own text)');
	assert.equal(answers['Q3?']?.length, QUESTION_LIMITS.freeText);
	assert.doesNotMatch(answers['Q3?'] ?? '', /\u001b/);
});

test('AskUserQuestion: duplicate texts and exceeded caps are denied', async () => {
	const { call, prompter} = setup();
	const L = QUESTION_LIMITS;
	const opt = (label: string, description = 'd') => ({label, description});
	const bad: Array<Record<string, unknown>[]> = [
		[Q(), Q()],
		[1, 2, 3, 4, 5].map(i => Q({question: `q${i}`})),
		[Q({question: 'x'.repeat(L.question + 1)})],
		[Q({header: 'h'.repeat(L.header + 1)})],
		[Q({options: [opt('a'), opt('b'), opt('c'), opt('d'), opt('e')]})],
		[Q({options: [opt('a')]})],
		[Q({options: [opt('l'.repeat(L.label + 1)), opt('b')]})],
		[Q({options: [opt('a', 'd'.repeat(L.description + 1)), opt('b')]})],
		[Q({multiSelect: 'yes'})],
	];
	for (const questions of bad) {
		const r = await call('AskUserQuestion', {questions});
		assert.equal(r?.behavior === 'deny' && r.message, POLICY_DENY.invalidInput);
	}
	assert.equal(prompter.requests.length, 0);
});

test('AskUserQuestion: dismiss, cancel, missing answers and __proto__ keys', async () => {
	const { call, prompter} = setup();
	const input = {questions: [Q()]};
	prompter.next = {kind: 'deny'};
	assert.deepEqual(await call('AskUserQuestion', input), {behavior: 'deny', message: DISMISS_MESSAGE, toolUseID: 'tu1'});
	prompter.next = {kind: 'cancel', cause: 'closed'};
	assert.deepEqual(await call('AskUserQuestion', input), {behavior: 'deny', message: CANCEL_MESSAGE, toolUseID: 'tu1'});
	prompter.next = {kind: 'answers', answers: {}};
	const r = await call('AskUserQuestion', input);
	assert.equal(r?.behavior === 'deny' && r.message, DISMISS_MESSAGE);
	prompter.next = {kind: 'answers', answers: {'__proto__': 'x', 'Color?': 'Red'}};
	const p = await call('AskUserQuestion', {questions: [Q({question: '__proto__'})]});
	assert.equal(p?.behavior, 'deny');
});

test('prompter audits only; nothing from the model input leaks into deny messages', async () => {
	const { call, prompter} = setup();
	const r = await call('Bash', {command: 'ls', run_in_background: true});
	const msg = r?.behavior === 'deny' ? r.message : '';
	assert.doesNotMatch(msg, /ls/);
	prompter.next = {kind: 'deny', reason: 'r'};
	assert.ok(!(await call('Bash', {command: 'SENTINEL'}).then(x => (x?.behavior === 'deny' ? x.message : ''))).includes('SENTINEL'));
});

test('a symlinked target is shown resolved in the request and the audit', async () => {
	writeFileSync(f('real.txt'), 'x');
	symlinkSync(f('real.txt'), f('link.txt'));
	const {call, prompter} = setup();
	await call('Write', {file_path: f('link.txt'), content: 'y'});
	const req = prompter.requests[0];
	assert.ok(req?.kind === 'tool');
	assert.equal(req.path, f('link.txt'));
	assert.equal(req.resolvedPath, f('real.txt'));
	const plain = setup();
	await plain.call('Write', {file_path: f('src/new.ts'), content: 'y'});
	assert.equal((plain.prompter.requests[0] as {resolvedPath?: string}).resolvedPath, undefined);
	const acc = setup();
	acc.prompter.mode = 'acceptEdits';
	await acc.call('Write', {file_path: f('link.txt'), content: 'y'});
	assert.match(acc.prompter.audits[0]?.summary ?? '', /link\.txt -> .*real\.txt \(\+1 -0\)$/);
});

test('a trailing newline is not counted as an extra line', async () => {
	const {call, prompter} = setup();
	prompter.mode = 'acceptEdits';
	await call('Write', {file_path: f('src/n1.ts'), content: 'hello\n'});
	await call('Edit', {file_path: f('src/a.ts'), old_string: 'a\nb\n', new_string: 'x\n'});
	assert.match(prompter.audits[0]?.summary ?? '', /\(\+1 -0\)$/);
	assert.match(prompter.audits[1]?.summary ?? '', /\(\+1 -2\)$/);
});

test('revealed delimiters in prompts do not reach the highlight input', async () => {
	const seen: string[] = [];
	const {call} = setup({highlights: c => (seen.push(c), [])});
	await call('Bash', {command: 'echo \u001b'});
	assert.deepEqual(seen, ['echo \u001b']);
});

test('Agent and SendMessage are allowed without a prompt; isolated agents are denied', async () => {
	const {call, prompter} = setup();
	const input = {subagent_type: 'coder', description: 'x', prompt: 'do it'};
	const r = await call('Agent', input);
	assert.deepEqual(r, {behavior: 'allow', updatedInput: input, toolUseID: 'tu1'});
	assert.equal((await call('SendMessage', {to: 'a1', message: 'go'}))?.behavior, 'allow');
	assert.equal((await call('Agent', {...input, run_in_background: true}))?.behavior, 'allow');
	const iso = await call('Agent', {...input, isolation: 'worktree'});
	assert.equal(iso?.behavior === 'deny' && iso.message, POLICY_DENY.isolation);
	assert.equal(prompter.requests.length, 0);
});

test('Skill, TodoWrite and WebSearch run without asking', async () => {
	const {call, prompter} = setup();
	for (const [name, input] of [
		['Skill', {skill: 'pipeline'}],
		['TodoWrite', {todos: []}],
		['WebSearch', {query: 'ink 8 release'}],
	] as const) {
		assert.equal((await call(name, input))?.behavior, 'allow', name);
	}
	assert.equal(prompter.requests.length, 0);
});

test('WebFetch always asks, showing the URL; bad URLs are denied without asking', async () => {
	const {call, prompter} = setup();
	prompter.next = {kind: 'allow'};
	const input = {url: 'https://example.com/docs', prompt: 'find the version'};
	const r = await call('WebFetch', input);
	assert.equal(r?.behavior, 'allow');
	const req = prompter.requests[0] as unknown as {toolName: string; input: {url: string}};
	assert.equal(req.toolName, 'WebFetch');
	assert.equal(req.input.url, 'https://example.com/docs');
	for (const url of ['file:///etc/passwd', 'ftp://x', 7, 'https://a\0b']) {
		const bad = await call('WebFetch', {url});
		assert.equal(bad?.behavior === 'deny' && bad.message, POLICY_DENY.invalidInput);
	}
	assert.equal(prompter.requests.length, 1);
});

test('ExitPlanMode asks to start; yes leaves plan mode, "always" goes to accept-edits, no keeps planning', async () => {
	const {call, prompter} = setup();
	prompter.mode = 'plan';
	const input = {plan: '1. Read\n2. Fix'};
	prompter.next = {kind: 'allow'};
	assert.equal((await call('ExitPlanMode', input))?.behavior, 'allow');
	const req = prompter.requests[0] as unknown as {toolName: string; always: {label: string}};
	assert.equal(req.toolName, 'ExitPlanMode');
	assert.equal(req.always.label, 'Yes, and accept edits');
	prompter.next = {kind: 'allow', always: true};
	await call('ExitPlanMode', input);
	prompter.next = {kind: 'deny', reason: 'add tests'};
	const no = await call('ExitPlanMode', input);
	assert.equal(no?.behavior, 'deny');
	assert.deepEqual(prompter.modes, ['default', 'acceptEdits']);
});

test('MCP tools ask, show the tool and its arguments, and "always" covers that tool', async () => {
	const {call, prompter} = setup();
	prompter.next = {kind: 'allow', always: true};
	const r = await call('mcp__github__create_issue', {title: 'Bug'});
	assert.deepEqual(r, {behavior: 'allow', updatedInput: {title: 'Bug'}, toolUseID: 'tu1'});
	const req = prompter.requests[0] as unknown as {toolName: string; input: Record<string, unknown>; always: {label: string}};
	assert.equal(req.toolName, 'Mcp');
	assert.equal(req.input['__mcpTool'], 'mcp__github__create_issue');
	assert.equal(req.always.label, 'Yes, always for this tool');
	assert.ok(prompter.approved.has('mcp:mcp__github__create_issue'));
	assert.equal((await call('mcp__github__create_issue', {title: 'Again'}))?.behavior, 'allow');
	assert.equal(prompter.requests.length, 1);
});

test('reading and stopping own background tasks runs without asking', async () => {
	const {call, prompter} = setup();
	for (const name of ['TaskStop', 'TaskGet', 'TaskList', 'TaskOutput', 'BashOutput', 'KillShell']) {
		assert.equal((await call(name, {task_id: 't1'}))?.behavior, 'allow', name);
	}
	assert.equal(prompter.requests.length, 0);
});
