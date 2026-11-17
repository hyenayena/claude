import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {createChatCanUseTool} from '../../src/chat/permission-bridge.js';
import {POLICY_ASK, type PermissionPrompter} from '../../src/chat/permission.js';
import {createPolicyHook} from '../../src/chat/policy-hook.js';
import {createProfileGuard, profileAgents} from '../../src/chat/profile-guard.js';
import {DEFAULT_TIERS} from '../../src/chat/tiers.js';
import type {ChatProfile} from '../../src/deps/chat.js';
import {buildScope} from '../../src/policy.js';

const profile = (extra: Partial<ChatProfile> = {}): ChatProfile => ({
	id: 'clan',
	owner: 'clan',
	appendSystemPrompt: 'moderate',
	mainTools: ['Agent', 'SendMessage'],
	agents: {
		skeptic: {description: 'doubts', prompt: 'You doubt.', label: 'Skeptic', tone: 'teal'},
		dreamer: {description: 'dreams', prompt: 'You dream.', label: 'Dreamer', tone: 'violet', tier: 'standard'},
	},
	...extra,
});

test('agent definitions have no tools, no MCP and a tier model', () => {
	const defs = profileAgents(profile(), DEFAULT_TIERS);
	assert.deepEqual(Object.keys(defs), ['skeptic', 'dreamer']);
	assert.deepEqual(defs.skeptic?.tools, []);
	assert.deepEqual(defs.skeptic?.disallowedTools, ['mcp__*']);
	assert.equal(defs.skeptic?.maxTurns, 3);
	assert.equal(defs.skeptic?.model, DEFAULT_TIERS.light.model);
	assert.equal(defs.dreamer?.model, DEFAULT_TIERS.standard.model);
});

test('a subagent tool call is denied', () => {
	const g = createProfileGuard(profile());
	assert.deepEqual(g.preToolUse('Agent', {subagent_type: 'skeptic'}, 'agent-1'), {kind: 'deny', reason: 'Personas have no tools'});
	assert.equal(g.canUse('Read', {}, 'agent-1'), 'Personas have no tools');
});

test('a main tool outside mainTools is denied', () => {
	const g = createProfileGuard(profile());
	for (const tool of ['Bash', 'Read', 'mcp__yena__run_command', 'Edit']) {
		const v = g.preToolUse(tool, {});
		assert.equal(v.kind, 'deny', tool);
		assert.match((v as {reason: string}).reason, /limited to Agent, SendMessage/);
		assert.match(g.canUse(tool, {}) ?? '', /limited to/);
	}
});

test('Agent and Task only for profile agents', () => {
	const g = createProfileGuard(profile());
	for (const tool of ['Agent', 'Task']) {
		const v = g.preToolUse(tool, {subagent_type: 'general-purpose'});
		assert.deepEqual(v, {kind: 'deny', reason: 'Only these agents are available: skeptic, dreamer'});
		assert.equal(g.canUse(tool, {}), 'Only these agents are available: skeptic, dreamer');
	}
	assert.equal(g.canUse('Agent', {subagent_type: 'skeptic'}), undefined);
});

test('the rewrite runs the agent in the foreground and strips overrides', () => {
	const g = createProfileGuard(profile());
	const v = g.preToolUse('Agent', {
		subagent_type: 'skeptic',
		prompt: 'cue',
		run_in_background: true,
		name: 'other',
		model: 'opus',
		effort: 'high',
		mode: 'auto',
		isolation: 'worktree',
	});
	assert.deepEqual(v, {kind: 'rewrite', input: {subagent_type: 'skeptic', prompt: 'cue', run_in_background: false, name: 'skeptic'}});
});

test('SendMessage is allowed unchanged', () => {
	const g = createProfileGuard(profile());
	assert.deepEqual(g.preToolUse('SendMessage', {to: 'skeptic', message: 'hi'}), {kind: 'allow'});
});

test('SendMessage only to profile agents', () => {
	const g = createProfileGuard(profile());
	for (const input of [{to: 'general-purpose', message: 'hi'}, {to: 'main', message: 'hi'}, {message: 'hi'}]) {
		const v = g.preToolUse('SendMessage', input);
		assert.equal(v.kind, 'deny');
		assert.match((v as {reason: string}).reason, /Only these agents are available/);
		assert.match(g.canUse('SendMessage', input) ?? '', /Only these agents are available/);
	}
});

test('the call cap counts Agent, Task and SendMessage and resets on a user message only', () => {
	const g = createProfileGuard(profile());
	assert.equal(g.preToolUse('Agent', {subagent_type: 'skeptic'}).kind, 'rewrite');
	assert.equal(g.preToolUse('SendMessage', {to: 'skeptic'}).kind, 'allow');
	assert.equal(g.preToolUse('Agent', {subagent_type: 'dreamer'}).kind, 'rewrite');
	const over = g.preToolUse('SendMessage', {to: 'skeptic'});
	assert.deepEqual(over, {kind: 'deny', reason: 'The limit of 3 agent calls for this message is reached; answer the user now'});
	assert.equal(g.preToolUse('Agent', {subagent_type: 'skeptic'}).kind, 'deny');
	assert.equal(g.canUse('SendMessage', {to: 'skeptic'}), undefined);
	g.newUserMessage();
	assert.equal(g.preToolUse('Agent', {subagent_type: 'skeptic'}).kind, 'rewrite');
});

test('turnAgentCalls sets the cap', () => {
	const g = createProfileGuard(profile({turnAgentCalls: 1}));
	assert.equal(g.preToolUse('SendMessage', {to: 'skeptic'}).kind, 'allow');
	assert.match((g.preToolUse('SendMessage', {to: 'skeptic'}) as {reason: string}).reason, /limit of 1 agent calls/);
});

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-profile-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const projectDir = path.join(tmp, 'project');
const paths = {
	projectDir,
	mdDir: path.join(tmp, 'md'),
	configDir: path.join(tmp, 'config'),
	stateFile: path.join(tmp, 'state.json'),
	credentialsFile: path.join(tmp, 'creds'),
};
for (const d of [projectDir, paths.mdDir, paths.configDir]) mkdirSync(d, {recursive: true});
const scope = buildScope(paths, path.join(tmp, 'home'));

const callHook = async (hook: ReturnType<typeof createPolicyHook>, tool_name: string, tool_input: Record<string, unknown>, agent_id?: string) =>
	(await hook(
		{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir, ...(agent_id && {agent_id})} as never,
		't',
		{signal: new AbortController().signal},
	)) as {hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown>}};

test('the policy hook applies the guard before its own switch', async () => {
	const hook = createPolicyHook(scope, paths.configDir, {profile: createProfileGuard(profile())});
	const bash = await callHook(hook, 'Bash', {command: 'ls'});
	assert.equal(bash.hookSpecificOutput?.permissionDecision, 'deny');
	const read = await callHook(hook, 'Read', {file_path: path.join(projectDir, 'a')});
	assert.equal(read.hookSpecificOutput?.permissionDecision, 'deny');
	const sub = await callHook(hook, 'Agent', {subagent_type: 'skeptic'}, 'agent-9');
	assert.equal(sub.hookSpecificOutput?.permissionDecisionReason, 'Personas have no tools');
	const agent = await callHook(hook, 'Agent', {subagent_type: 'skeptic', run_in_background: true, model: 'opus'});
	assert.equal(agent.hookSpecificOutput?.permissionDecision, 'allow');
	assert.deepEqual(agent.hookSpecificOutput?.updatedInput, {subagent_type: 'skeptic', run_in_background: false, name: 'skeptic'});
	const send = await callHook(hook, 'SendMessage', {to: 'skeptic'});
	assert.equal(send.hookSpecificOutput, undefined);
});

test('the policy hook is unchanged without a profile', async () => {
	const hook = createPolicyHook(scope, paths.configDir);
	const out = await callHook(hook, 'Agent', {subagent_type: 'general-purpose'}, 'agent-9');
	assert.equal(out.hookSpecificOutput, undefined);
	assert.ok(POLICY_ASK.newHost);
});

test('the permission bridge denies what the guard refuses and passes the rest', async () => {
	const audits: unknown[] = [];
	const prompter = {
		mode: 'default',
		request: () => Promise.reject(new Error('no prompt expected')),
		hasApproved: () => false,
		remember: () => undefined,
		audit: (e: unknown) => audits.push(e),
	} as unknown as PermissionPrompter;
	const can = createChatCanUseTool({scope, projectDir, mdDir: paths.mdDir, prompter, profile: createProfileGuard(profile())});
	const o = (agentID?: string) => ({signal: new AbortController().signal, toolUseID: 'u', ...(agentID && {agentID})}) as never;
	const bash = await can('Bash', {command: 'ls'}, o());
	assert.equal(bash?.behavior, 'deny');
	const sub = await can('SendMessage', {to: 'skeptic'}, o('agent-1'));
	assert.equal(sub?.behavior, 'deny');
	const other = await can('Agent', {subagent_type: 'nope'}, o());
	assert.equal(other?.behavior, 'deny');
	const ok = await can('Agent', {subagent_type: 'skeptic'}, o());
	assert.equal(ok?.behavior, 'allow');
	const send = await can('SendMessage', {to: 'skeptic'}, o());
	assert.equal(send?.behavior, 'allow');
	assert.equal(audits.length, 3);
});
