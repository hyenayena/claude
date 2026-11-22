import assert from 'node:assert/strict';
import path from 'node:path';
import {after, beforeEach, describe, it} from 'node:test';
import {POLICY_ASK, POLICY_DENY} from '../../src/chat/permission.js';
import {createPolicyHook, deniedReason} from '../../src/chat/policy-hook.js';
import {resetRulesCaches} from '../../src/rules.js';
import {rulesFixture} from './rules-fixture.js';

const fx = rulesFixture();
after(fx.cleanup);
beforeEach(() => resetRulesCaches());
const w = (rel: string) => path.join(fx.web, rel);
const opts = {signal: new AbortController().signal} as never;

const hookOf = (hookOpts: Parameters<typeof createPolicyHook>[2] = {}) => {
	const hook = createPolicyHook(fx.scope, fx.paths.configDir, hookOpts);
	return async (tool_name: string, tool_input: Record<string, unknown>) => {
		const out = (await hook(
			{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: fx.web} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string}};
		const d = out.hookSpecificOutput;
		return d?.permissionDecision === undefined ? 'pass' : `${d.permissionDecision}:${d.permissionDecisionReason}`;
	};
};
const run = hookOf();
const kind = (decision: string) => decision.split(':')[0];

describe('Read, Glob and Grep', () => {
	it('Read of a deny read path is refused with the rules file named, an ask read path asks, the rest passes', async () => {
		const denied = await run('Read', {file_path: w('.env')});
		assert.equal(kind(denied), 'deny');
		assert.match(denied, /lists it under \[deny read\]/);
		assert.ok(denied.includes(w('.yenarules')));
		assert.equal(await run('Read', {file_path: w('notes/private.md')}), `ask:${POLICY_ASK.rulesRead}`);
		assert.equal(await run('Read', {file_path: w('.env.example')}), 'pass');
		assert.equal(await run('Read', {file_path: w('a.ts')}), 'pass');
	});

	it('Grep: a deny file or folder is refused, a folder holding an ask read entry asks, other folders pass', async () => {
		assert.equal(kind(await run('Grep', {pattern: 'x', path: w('secrets')})), 'deny');
		assert.equal(kind(await run('Grep', {pattern: 'x', path: w('.env')})), 'deny');
		assert.equal(await run('Grep', {pattern: 'x', path: w('notes')}), `ask:${POLICY_ASK.rulesRead}`);
		assert.equal(await run('Grep', {pattern: 'x'}), `ask:${POLICY_ASK.rulesRead}`, 'the project root holds one too');
		assert.equal(await run('Grep', {pattern: 'x', path: w('scripts')}), 'pass');
	});

	it('Glob refuses a pattern whose base is closed and never asks', async () => {
		assert.equal(kind(await run('Glob', {pattern: path.join(w('secrets'), '*')})), 'deny');
		assert.equal(await run('Glob', {pattern: '*.md', path: w('notes')}), 'pass');
	});

	it('deniedReason gives the same refusal for the bridge', async () => {
		assert.match((await deniedReason(fx.scope, 'Read', {file_path: w('.env')})) ?? '', /\[deny read\]/);
		assert.equal(await deniedReason(fx.scope, 'Read', {file_path: w('a.ts')}), undefined);
	});

	it('a malformed rules file closes its folder with the line and the problem', async () => {
		fx.put(w('broken/.yenarules'), '[deny read]\nok\n[oops]\n');
		fx.put(w('broken/f.txt'));
		const denied = await run('Read', {file_path: w('broken/f.txt')});
		assert.equal(kind(denied), 'deny');
		assert.match(denied, /line 3: unknown section header; everything in its folder is closed until the user fixes it/);
		assert.equal(await run('Read', {file_path: w('broken/.yenarules')}), 'pass');
	});
});

describe('Edit and Write', () => {
	const edit = (rel: string) => run('Edit', {file_path: w(rel), old_string: 'a', new_string: 'b'});

	it('deny write is refused with the section named, ask write asks, the rest passes', async () => {
		const denied = await edit('scripts/x.sh');
		assert.equal(kind(denied), 'deny');
		assert.match(denied, /lists it under \[deny write\]/);
		assert.equal(kind(await run('Write', {file_path: w('scripts/new.sh'), content: 'x'})), 'deny');
		assert.equal(kind(await edit('compose.yaml')), 'deny');
		assert.equal(await edit('package.json'), `ask:${POLICY_ASK.rulesWrite}`);
		assert.equal(await edit('.git/config'), `ask:${POLICY_ASK.rulesWrite}`);
		assert.equal(await edit('a.ts'), 'pass');
		assert.equal(await edit('.github/workflows/ci.yml'), 'pass');
	});

	it('a deny read path is refused for writing too, and a .yenarules is the user\'s alone', async () => {
		assert.match(await edit('.env'), /deny\:/);
		const rules = await run('Write', {file_path: w('sub/.yenarules'), content: '[deny read]\n'});
		assert.equal(rules, `deny:${POLICY_DENY.rulesFile}`);
		assert.equal(await edit('.yenarules'), `deny:${POLICY_DENY.rulesFile}`);
	});

	it('the hub instructions pass without a prompt', async () => {
		assert.equal(await run('Edit', {file_path: path.join(fx.hub, 'CLAUDE.md'), old_string: 'a', new_string: 'b'}), 'pass');
		assert.equal(await run('Write', {file_path: path.join(fx.hub, 'SOUL.md'), content: 'x'}), 'pass');
	});
});

describe('WebFetch', () => {
	it('passes a valid URL, refuses invalid input, and never asks', async () => {
		assert.equal(await run('WebFetch', {url: 'https://docs.example.com/'}), 'pass');
		assert.equal(await run('WebFetch', {url: 'https://never-seen.example.net/'}), 'pass');
		assert.equal(await run('WebFetch', {url: 'ftp://x/'}), `deny:${POLICY_DENY.invalidInput}`);
		assert.equal(await run('WebFetch', {url: 42}), `deny:${POLICY_DENY.invalidInput}`);
	});
});

describe('Bash', () => {
	it('denies commands that read or change a closed path', async () => {
		for (const c of ['cat .env', 'head secrets/k', 'echo x > scripts/y.sh', 'rm scripts/x.sh', 'sed -i s/a/b/ compose.yaml', 'cp a.ts scripts/z.sh', 'cat < .env', 'echo $(cat .env)']) {
			assert.equal(await run('Bash', {command: c}), `deny:${POLICY_DENY.rulesBash}`, c);
		}
	});

	it('an unknown program that names a deny write path is denied', async () => {
		assert.equal(await run('Bash', {command: 'python tool.py scripts/x.sh'}), `deny:${POLICY_DENY.rulesBash}`);
		assert.equal(await run('Bash', {command: './unknown --out=compose.yaml'}), `deny:${POLICY_DENY.rulesBash}`);
	});

	it('asks for ask read and ask write paths and for a folder that holds an ask read entry', async () => {
		for (const c of ['cat notes/private.md', 'echo {} > package.json', 'grep -r x notes', 'git config user.name x', 'git push -u origin main']) {
			assert.equal(await run('Bash', {command: c}), `ask:${POLICY_ASK.rulesBash}`, c);
		}
	});

	it('grep over a folder with a deny read entry is denied', async () => {
		assert.equal(await run('Bash', {command: 'grep -r token .'}), `deny:${POLICY_DENY.rulesBash}`);
	});

	it('lets ordinary commands through, reads of deny write paths included', async () => {
		for (const c of ['ls', 'git status', 'npm test', 'cat scripts/x.sh', 'cat a.ts', 'cat .env.example', 'cd notes && cat public.md', 'git commit -am x']) {
			assert.equal(await run('Bash', {command: c}), 'pass', c);
		}
	});

	it('an ask still brings the sandbox up to date and starts the tracker; a deny runs neither', async () => {
		const calls: string[] = [];
		const tracked = hookOf({
			beforeBash: async () => void calls.push('sandbox'),
			bashTracker: {begin: id => void calls.push(`begin:${id}`), end: async () => {}},
		});
		assert.equal(await tracked('Bash', {command: 'cat notes/private.md'}), `ask:${POLICY_ASK.rulesBash}`);
		assert.deepEqual(calls, ['sandbox', 'begin:t']);
		calls.length = 0;
		assert.equal(kind(await tracked('Bash', {command: 'cat .env'})), 'deny');
		assert.deepEqual(calls, []);
	});

	it('keeps the other guards: auth files, process environments, the project data dir', async () => {
		assert.equal(await run('Bash', {command: 'cat /data/claude/auth.json'}), `deny:${POLICY_DENY.authFiles}`);
		assert.equal(await run('Bash', {command: 'cat /proc/1/environ'}), `deny:${POLICY_DENY.procEnv}`);
		assert.equal(await run('Bash', {command: `ls ${fx.paths.projects.dataDir}`}), `deny:${POLICY_DENY.projectState}`);
	});

	it('uses the hook cwd for relative paths', async () => {
		const hook = createPolicyHook(fx.scope, fx.paths.configDir);
		const out = (await hook(
			{hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command: 'cat k'}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: w('secrets')} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecision?: string}};
		assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
	});
});
