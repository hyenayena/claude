import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {createPolicyHook, policyHooks} from '../../src/chat/policy-hook.js';
import {POLICY_DENY} from '../../src/chat/permission.js';
import {buildScope} from '../../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-hook-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const projectDir = path.join(tmp, 'project');
const dataDir = path.join(tmp, 'data');
const paths = {
	projectDir,
	mdDir: path.join(dataDir, 'md'),
	configDir: path.join(dataDir, 'config'),
	tokenFile: path.join(dataDir, '.token'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
};
for (const d of [projectDir, paths.mdDir, paths.configDir]) mkdirSync(d, {recursive: true});
writeFileSync(path.join(projectDir, 'a.txt'), 'a');
const hook = createPolicyHook(buildScope(paths, path.join(tmp, 'home')));
const opts = {signal: new AbortController().signal};

const run = (tool_name: string, tool_input: Record<string, unknown>) =>
	hook(
		{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
		't',
		opts,
	);
const decision = async (tool: string, input: Record<string, unknown>) => {
	const out = (await run(tool, input)) as {hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string}};
	return out.hookSpecificOutput ? `${out.hookSpecificOutput.permissionDecision}:${out.hookSpecificOutput.permissionDecisionReason}` : 'pass';
};

test('the hook never allows by itself and passes calls inside the policy', async () => {
	assert.equal(await decision('Read', {file_path: path.join(projectDir, 'a.txt')}), 'pass');
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'a.txt'), old_string: 'a', new_string: 'b'}), 'pass');
	assert.equal(await decision('Bash', {command: 'ls'}), 'pass');
	assert.equal(await decision('AskUserQuestion', {}), 'pass');
});

test('the hook denies paths outside the policy in any mode', async () => {
	assert.equal(await decision('Read', {file_path: '/etc/passwd'}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Grep', {pattern: 'x', path: '/etc'}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Write', {file_path: '/etc/x', content: ''}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'CLAUDE.md')}), `deny:${POLICY_DENY.guard}`);
	assert.equal(await decision('Write', {file_path: path.join(projectDir, '.env'), content: ''}), `deny:${POLICY_DENY.secret}`);
	assert.equal(await decision('Read', {file_path: paths.tokenFile}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Edit', {}), `deny:${POLICY_DENY.invalidInput}`);
	assert.equal(await decision('Bash', {command: 'sleep 9', run_in_background: true}), `deny:${POLICY_DENY.background}`);
});

test('policyHooks registers the hook for PreToolUse only', () => {
	const hooks = policyHooks(buildScope(paths));
	assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
	assert.equal(hooks.PreToolUse[0]!.hooks.length, 1);
});
