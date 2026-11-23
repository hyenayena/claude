import assert from 'node:assert/strict';
import path from 'node:path';
import {after, beforeEach, describe, it} from 'node:test';
import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';
import {createChatCanUseTool} from '../../src/chat/permission-bridge.js';
import {type PermissionPrompter, POLICY_ASK, POLICY_DENY} from '../../src/chat/permission.js';
import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from '../../src/deps/chat.js';
import {resetRulesCaches} from '../../src/deps/rules.js';
import {rulesFixture} from './rules-fixture.js';

const fx = rulesFixture();
after(fx.cleanup);
beforeEach(() => resetRulesCaches());
const w = (rel: string) => path.join(fx.web, rel);

class Prompter implements PermissionPrompter {
	mode: ChatMode = 'default';
	requests: PermissionRequest[] = [];
	audits: AuditEntry[] = [];
	approved = new Set<string>();
	next: PermissionDecision = {kind: 'allow'};
	request(req: PermissionRequest): Promise<PermissionDecision> {
		this.requests.push(req);
		return Promise.resolve(this.next);
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
}

const setup = (mode: ChatMode = 'default') => {
	const prompter = new Prompter();
	prompter.mode = mode;
	const tool: CanUseTool = createChatCanUseTool({scope: fx.scope, projectDir: fx.web, mdDir: fx.paths.mdDir, prompter});
	const call = (name: string, input: Record<string, unknown>, o: Record<string, unknown> = {}) =>
		tool(name, input, {signal: new AbortController().signal, toolUseID: 'tu', suggestions: undefined, ...o} as never);
	return {prompter, call};
};
const bashSuggest = [{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'ls:*'}], behavior: 'allow', destination: 'session'}];
const edit = (rel: string) => ({file_path: w(rel), old_string: 'a', new_string: 'b'});

describe('Edit and Write', () => {
	it('ask write prompts in every mode, acceptEdits and auto included, and offers no "always"', async () => {
		for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
			const {call, prompter} = setup(mode);
			const r = await call('Edit', edit('package.json'));
			assert.equal(r?.behavior, 'allow', mode);
			assert.equal(prompter.requests.length, 1, mode);
			const req = prompter.requests[0];
			assert.ok(req?.kind === 'tool' && req.always === false, mode);
			assert.equal(prompter.audits.filter(a => a.outcome === 'auto-accepted').length, 0, mode);
		}
	});

	it('a denied ask write is refused', async () => {
		const {call, prompter} = setup('acceptEdits');
		prompter.next = {kind: 'deny'};
		assert.equal((await call('Write', {file_path: w('.git/config'), content: 'x'}))?.behavior, 'deny');
	});

	it('deny write is refused in every mode without a prompt, and a .yenarules is the user\'s alone', async () => {
		for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
			const {call, prompter} = setup(mode);
			const scripts = await call('Edit', edit('scripts/x.sh'));
			assert.equal(scripts?.behavior, 'deny', mode);
			assert.match(scripts?.behavior === 'deny' ? scripts.message : '', /\[deny write\]/);
			const rules = await call('Write', {file_path: w('sub/.yenarules'), content: 'x'});
			assert.equal(rules?.behavior === 'deny' && rules.message, POLICY_DENY.rulesFile);
			assert.equal((await call('Edit', edit('.env')))?.behavior, 'deny', mode);
			assert.equal(prompter.requests.length, 0, mode);
			assert.equal(prompter.audits.filter(a => a.outcome === 'denied-by-policy').length, 3, mode);
		}
	});

	it('dot-files, build files and package-like names are auto-accepted in acceptEdits when no rule lists them', async () => {
		const {call, prompter} = setup('acceptEdits');
		for (const rel of ['.gitignore', 'Dockerfile', 'src/package.json', '.github/ci.yml']) assert.equal((await call('Edit', edit(rel)))?.behavior, 'allow', rel);
		assert.equal(prompter.requests.length, 0);
		assert.equal(prompter.audits.filter(a => a.outcome === 'auto-accepted').length, 4);
	});

	it('the hub instructions are auto-accepted like the rest of the hub', async () => {
		const {call, prompter} = setup();
		assert.equal((await call('Edit', {file_path: path.join(fx.hub, 'CLAUDE.md'), old_string: 'a', new_string: 'b'}))?.behavior, 'allow');
		assert.equal(prompter.requests.length, 0);
	});
});

describe('Bash', () => {
	it('deny is refused without a prompt', async () => {
		const {call, prompter} = setup();
		const r = await call('Bash', {command: 'cat .env'}, {suggestions: bashSuggest});
		assert.deepEqual(r, {behavior: 'deny', message: POLICY_DENY.rulesBash, toolUseID: 'tu'});
		assert.equal(prompter.requests.length, 0);
		assert.equal((await call('Bash', {command: 'python x.py scripts/x.sh'}))?.behavior, 'deny');
	});

	it('ask ignores a saved approval and offers no "always"', async () => {
		const {call, prompter} = setup();
		prompter.approved.add('cat notes/private.md');
		const r = await call('Bash', {command: 'cat notes/private.md'}, {suggestions: bashSuggest});
		assert.equal(r?.behavior, 'allow');
		assert.equal(prompter.requests.length, 1, 'the saved approval did not skip the prompt');
		const req = prompter.requests[0];
		assert.ok(req?.kind === 'tool' && req.always === false);
		assert.equal(prompter.audits.some(a => a.outcome === 'always-allowed'), false);
		assert.ok(![...prompter.approved].some(k => k !== 'cat notes/private.md'));
	});

	it('a hook ask is kept even when the bridge sees no rule at its own cwd', async () => {
		const {call, prompter} = setup();
		prompter.approved.add('cat k');
		await call('Bash', {command: 'cat k'}, {suggestions: bashSuggest, decisionReason: POLICY_ASK.rulesBash});
		assert.equal(prompter.requests.length, 1);
	});

	it('a command the rules do not touch keeps the saved approval and the "always" offer', async () => {
		const {call, prompter} = setup();
		prompter.approved.add('npm test');
		await call('Bash', {command: 'npm test'}, {suggestions: bashSuggest});
		assert.equal(prompter.requests.length, 0);
		await call('Bash', {command: 'npm run lint'}, {suggestions: bashSuggest});
		const req = prompter.requests[0];
		assert.ok(req?.kind === 'tool' && req.always !== false);
	});
});

describe('Read, Grep and Glob', () => {
	it('an ask read prompts with the tool name and the path and offers no "always"', async () => {
		const {call, prompter} = setup();
		assert.equal((await call('Read', {file_path: w('notes/private.md')}))?.behavior, 'allow');
		const read = prompter.requests[0];
		assert.ok(read?.kind === 'tool' && read.toolName === 'Read' && read.path === w('notes/private.md') && read.always === false);
		assert.equal((await call('Grep', {pattern: 'x', path: w('notes')}))?.behavior, 'allow');
		const grep = prompter.requests[1];
		assert.ok(grep?.kind === 'tool' && grep.toolName === 'Grep' && grep.path === w('notes'));
	});

	it('a denied ask read is refused', async () => {
		const {call, prompter} = setup('auto');
		prompter.next = {kind: 'deny'};
		assert.equal((await call('Read', {file_path: w('notes/private.md')}))?.behavior, 'deny');
	});

	it('deny read is refused with the rules message and never prompts; a free path passes', async () => {
		const {call, prompter} = setup();
		const r = await call('Read', {file_path: w('.env')});
		assert.equal(r?.behavior, 'deny');
		assert.match(r?.behavior === 'deny' ? r.message : '', /\[deny read\]/);
		assert.equal((await call('Grep', {pattern: 'x', path: w('secrets')}))?.behavior, 'deny');
		assert.equal((await call('Read', {file_path: w('a.ts')}))?.behavior, 'allow');
		assert.equal((await call('Glob', {pattern: '*.md', path: w('notes')}))?.behavior, 'allow');
		assert.equal(prompter.requests.length, 0);
	});
});

describe('WebFetch', () => {
	it('still prompts by default with "always for <host>" and honours a saved host', async () => {
		const {call, prompter} = setup();
		await call('WebFetch', {url: 'https://docs.example.com/a'});
		const req = prompter.requests[0];
		assert.ok(req?.kind === 'tool' && req.always !== false && req.always.label === 'Yes, always for docs.example.com');
		prompter.approved.add('web:docs.example.com');
		await call('WebFetch', {url: 'https://docs.example.com/b'});
		assert.equal(prompter.requests.length, 1);
	});
});
