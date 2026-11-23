import assert from 'node:assert/strict';
import path from 'node:path';
import {after, beforeEach, describe, it} from 'node:test';
import {POLICY_DENY} from '../../src/chat/permission.js';
import {createPolicyHook} from '../../src/chat/policy-hook.js';
import {buildSandbox} from '../../src/chat/sandbox.js';
import {resetRulesCaches, rulesLists} from '../../src/deps/rules.js';
import {rulesFixture} from './rules-fixture.js';

const fx = rulesFixture();
after(fx.cleanup);
beforeEach(() => resetRulesCaches());
const opts = {signal: new AbortController().signal} as never;

const bash = async (command: string) => {
	const hook = createPolicyHook(fx.scope, fx.paths.configDir, {});
	const out = (await hook(
		{hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: fx.web} as never,
		't',
		opts,
	)) as {hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string}};
	const d = out.hookSpecificOutput;
	return d?.permissionDecision === undefined ? 'pass' : `${d.permissionDecision}:${d.permissionDecisionReason}`;
};

describe('Bash against an ask-write path (package.json)', () => {
	it('every way of writing it is denied, never turned into a prompt', async () => {
		const cmds = [
			'sed -i s/a/b/ package.json',
			'echo x > package.json',
			'echo x >> package.json',
			'rm package.json',
			'rm -f ./package.json',
			'mv package.json old.json',
			'mv a.ts package.json',
			'cp a.ts package.json',
			'install -m 644 a.ts package.json',
			'echo x | tee package.json',
			'echo x | tee -a package.json',
			'node build.js package.json',
			'truncate -s 0 package.json',
			'cd notes && rm ../package.json',
			'git config --global x y',
		];
		for (const c of cmds) assert.equal(await bash(c), `deny:${POLICY_DENY.rulesBashAsk}`, c);
	});

	it('a folder operation that covers the file is denied too', async () => {
		for (const c of ['rm -rf .', 'mv ../web ../web2', 'rm -r ../web']) {
			assert.match(await bash(c), /^deny:/, c);
		}
	});

	it('reads of the file are allowed', async () => {
		for (const c of ['cat package.json', 'grep name package.json', 'head -n 1 package.json', 'cp package.json /tmp/copy.json', 'git status']) {
			assert.equal(await bash(c), 'pass', c);
		}
	});

	it('git config reads are allowed and every setting form is denied', async () => {
		for (const c of ['git config --get user.name', 'git config --list', 'git config -l', 'git config --get-all x', 'git config --get-regexp x', 'git config --list --show-origin', 'git config --show-origin --get x']) {
			assert.equal(await bash(c), 'pass', c);
		}
		for (const c of ['git config user.name x', 'git config --global x y', 'git config --unset x', 'git config --add x y', 'git config --replace-all x y', 'git config --rename-section a b', 'git config --remove-section a', 'git config -e', 'git config --edit', 'git config --get x --unset x']) {
			assert.equal(await bash(c), `deny:${POLICY_DENY.rulesBashAsk}`, c);
		}
	});
});

describe('sandbox write list', () => {
	it('holds the ask-write files and never a parent of a writable root', async () => {
		const lists = await rulesLists(fx.scope);
		assert.ok(lists.askWrite.includes(path.join(fx.web, 'package.json')));
		const access = await fx.paths.projects.read();
		const settings = buildSandbox(fx.paths, access, undefined, path.join(fx.tmp, 'home'), {
			rules: {denyRead: lists.denyRead, denyWrite: lists.denyWrite, rulesFiles: lists.rulesFiles, askWrite: lists.askWrite},
		});
		const deny = settings.filesystem.denyWrite;
		assert.ok(deny.includes(path.join(fx.web, 'package.json')));
		assert.ok(deny.includes(path.join(fx.web, '.yenarules')));
		for (const d of deny) assert.equal(fx.web === d || fx.web.startsWith(d + path.sep), false, `${d} must not cover the writable root`);
	});
});
