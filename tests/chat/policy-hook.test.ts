import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {createPolicyHook, policyHooks, webKey} from '../../src/chat/policy-hook.js';
import {POLICY_ASK, POLICY_DENY} from '../../src/chat/permission.js';
import {buildScope} from '../../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-hook-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const projectDir = path.join(tmp, 'project');
const dataDir = path.join(tmp, 'data');
const paths = {
	projectDir,
	mdDir: path.join(dataDir, 'md'),
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
};
for (const d of [projectDir, paths.mdDir, paths.configDir]) mkdirSync(d, {recursive: true});
writeFileSync(path.join(projectDir, 'a.txt'), 'a');
const hook = createPolicyHook(buildScope(paths, path.join(tmp, 'home')), paths.configDir);
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

test('the hook does not deny the yena console tools', async () => {
	assert.equal(await decision('mcp__yena__list_commands', {}), 'pass');
	assert.equal(await decision('mcp__yena__run_command', {command: 'help'}), 'pass');
});

test('the hook never allows by itself and passes calls inside the policy', async () => {
	assert.equal(await decision('Read', {file_path: path.join(projectDir, 'a.txt')}), 'pass');
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'a.txt'), old_string: 'a', new_string: 'b'}), 'pass');
	assert.equal(await decision('Bash', {command: 'ls'}), 'pass');
	assert.equal(await decision('AskUserQuestion', {}), 'pass');
	assert.equal(await decision('Agent', {subagent_type: 'coder', prompt: 'x'}), 'pass');
});

test('the hook denies paths outside the policy in any mode', async () => {
	assert.equal(await decision('Read', {file_path: '/etc/passwd'}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Grep', {pattern: 'x', path: '/etc'}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Write', {file_path: '/etc/x', content: ''}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'CLAUDE.local.md')}), `deny:${POLICY_DENY.guard}`);
	assert.equal(await decision('Write', {file_path: path.join(projectDir, '.claude', 'x.md'), content: ''}), `deny:${POLICY_DENY.guard}`);
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'CLAUDE.md'), old_string: 'a', new_string: 'b'}), `deny:${POLICY_DENY.guard}`);
	assert.equal(await decision('Write', {file_path: path.join(projectDir, '.env'), content: ''}), `deny:${POLICY_DENY.secret}`);
	assert.equal(await decision('Read', {file_path: path.join(dataDir, '.token')}), `deny:${POLICY_DENY.outside}`);
	assert.equal(await decision('Edit', {}), `deny:${POLICY_DENY.invalidInput}`);
	assert.equal(await decision('Bash', {command: 'sleep 9', run_in_background: true}), 'pass');
	assert.equal(await decision('Bash', {command: 'ls', dangerouslyDisableSandbox: true}), `deny:${POLICY_DENY.background}`);
	assert.equal(await decision('Agent', {prompt: 'x', run_in_background: true}), 'pass');
	assert.equal(await decision('Agent', {prompt: 'x', isolation: 'remote'}), `deny:${POLICY_DENY.isolation}`);
});

test('policyHooks registers the hook for PreToolUse only', () => {
	const hooks = policyHooks(buildScope(paths));
	assert.deepEqual(Object.keys(hooks), ['PreToolUse']);
	assert.equal(hooks.PreToolUse[0]!.hooks.length, 1);
});

test('the hook keeps the Claude config read-only except the plan files of plan mode', async () => {
	assert.equal(await decision('Write', {file_path: path.join(paths.configDir, 'plans', 'p.md'), content: ''}), 'pass');
	for (const f of ['settings.json', 'agents/a.md', 'new-unknown-file', 'plansx/a.md']) {
		assert.equal(await decision('Write', {file_path: path.join(paths.configDir, f), content: ''}), `deny:${POLICY_DENY.guard}`, f);
	}
	symlinkSync(paths.configDir, path.join(projectDir, 'cfg-link'));
	assert.equal(await decision('Edit', {file_path: path.join(projectDir, 'cfg-link', 'settings.json')}), `deny:${POLICY_DENY.guard}`);
});

test('the hook denies the auth files of the config dir for every tool', async () => {
	mkdirSync(path.join(paths.configDir, 'backups'), {recursive: true});
	mkdirSync(path.join(paths.configDir, 'projects'), {recursive: true});
	const creds = path.join(paths.configDir, '.credentials.json');
	const state = path.join(paths.configDir, '.claude.json');
	const backups = path.join(paths.configDir, 'backups');
	const denied = `deny:${POLICY_DENY.outside}`;
	for (const f of [creds, state]) {
		assert.equal(await decision('Read', {file_path: f}), denied, f);
		assert.equal(await decision('Grep', {pattern: 'k', path: f}), denied, f);
		assert.notEqual(await decision('Edit', {file_path: f, old_string: 'a', new_string: 'b'}), 'pass', f);
		assert.notEqual(await decision('Write', {file_path: f, content: ''}), 'pass', f);
	}
	assert.equal(await decision('Glob', {pattern: '*', path: backups}), denied);
	assert.equal(await decision('Read', {file_path: path.join(backups, '.claude.json.backup.1')}), denied);
	assert.equal(await decision('Read', {file_path: path.join(paths.configDir, 'projects', 'p', 'memory', 'm.md')}), 'pass');
	assert.equal(await decision('Read', {file_path: path.join(paths.configDir, 'projects', 'x.jsonl')}), denied);
	assert.equal(await decision('Read', {file_path: path.join(paths.configDir, 'history.jsonl')}), denied);
});

test('the hook denies Bash commands that name an auth file', async () => {
	const reason = POLICY_DENY.authFiles;
	for (const command of [
		`cat ${path.join(paths.configDir, '.credentials.json')}`,
		'cat ~/.claude.json',
		'grep k "$X/credentials.json"',
		`ls ${path.join(paths.configDir, 'backups')}`,
		'cat $HOME/.claude.json',
		'cat ../config/.credentials.json',
	]) {
		assert.equal(await decision('Bash', {command}), `deny:${reason}`, command);
	}
	for (const command of ['ls', 'echo token', 'cat notes.tokens.md', 'git status', 'cat my.token', 'npm run token', 'cat foo/.tokens', 'cat .token', 'cat /data/claude/.token']) {
		assert.equal(await decision('Bash', {command}), 'pass', command);
	}
});

test('the hook denies permission frontmatter in skills, agents and commands, also through the config links', async () => {
	const skills = path.join(paths.mdDir, 'skills');
	mkdirSync(path.join(skills, 's'), {recursive: true});
	symlinkSync(skills, path.join(paths.configDir, 'skills'));
	const denied = `deny:${POLICY_DENY.privileged}`;
	const skill = '---\nname: s\nallowed-tools: Bash\n---\n';
	assert.equal(await decision('Write', {file_path: path.join(skills, 's', 'SKILL.md'), content: skill}), denied);
	assert.equal(await decision('Write', {file_path: path.join(paths.configDir, 'skills', 's', 'SKILL.md'), content: skill}), denied);
	assert.equal(await decision('Write', {file_path: path.join(paths.mdDir, 'agents', 'a.md'), content: '---\npermissionMode: auto\n---\n'}), denied);
	assert.equal(await decision('Write', {file_path: path.join(projectDir, 'src', '.claude', 'skills', 'x', 'SKILL.md'), content: skill}), denied);
	assert.equal(await decision('Write', {file_path: path.join(skills, 's', 'SKILL.md'), content: '---\nname: s\n---\nBody\n'}), 'pass');
	assert.equal(await decision('Write', {file_path: path.join(paths.mdDir, 'notes.md'), content: skill}), 'pass');
	writeFileSync(path.join(skills, 's', 'SKILL.md'), skill);
	assert.equal(await decision('Edit', {file_path: path.join(skills, 's', 'SKILL.md'), old_string: 'name: s', new_string: 'name: t'}), 'pass');
	assert.equal(await decision('Edit', {file_path: path.join(skills, 's', 'SKILL.md'), old_string: 'Bash', new_string: 'Bash Write'}), denied);
});

test('the hook denies Bash commands that read process environments', async () => {
	for (const command of ['cat /proc/1/environ', "tr '\\0' '\\n' < /proc/self/environ", 'for p in /proc/*; do cat $p/environ; done']) {
		assert.equal(await decision('Bash', {command}), `deny:${POLICY_DENY.procEnv}`, command);
	}
	for (const command of ['cat /proc/cpuinfo', 'echo environment', 'grep -r environment src']) {
		assert.equal(await decision('Bash', {command}), 'pass', command);
	}
});

test('the hook denies Bash commands that use the host ssh-agent', async () => {
	const sock = '/run/host-services/ssh-auth.sock';
	const guarded = createPolicyHook(buildScope({...paths, agentSocket: sock}), paths.configDir);
	const verdict = async (command: string) => {
		const out = (await guarded(
			{hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecisionReason?: string}};
		return out.hookSpecificOutput?.permissionDecisionReason ?? 'pass';
	};
	for (const command of [`SSH_AUTH_SOCK=${sock} git push`, 'ls /run/host-services/', 'ssh-add -l', 'export SSH_AUTH_SOCK=/x']) {
		assert.equal(await verdict(command), POLICY_DENY.sshAgent, command);
	}
	for (const command of ['git push', 'ssh -V', 'ls /run']) {
		assert.equal(await verdict(command), 'pass', command);
	}
	assert.equal(await decision('Bash', {command: 'ssh-add -l'}), `deny:${POLICY_DENY.sshAgent}`);
});

test('the hook denies the account secrets to Bash and the file tools', async () => {
	const accountDir = path.join(dataDir, 'account');
	const secretDirs = [path.join(accountDir, 'secrets'), path.join(accountDir, 'keys')];
	const guarded = createPolicyHook(buildScope({...paths, accountSecrets: {dataDir: accountDir, secretDirs}}), paths.configDir);
	const verdict = async (tool_name: string, tool_input: Record<string, unknown>) => {
		const out = (await guarded(
			{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecisionReason?: string}};
		return out.hookSpecificOutput?.permissionDecisionReason ?? 'pass';
	};
	for (const command of [`cat ${accountDir}/secrets/gh.json`, `ls ${accountDir}`, 'cd /x && cat account/keys/gh', 'tar c account/secrets']) {
		assert.equal(await verdict('Bash', {command}), POLICY_DENY.accountSecrets, command);
	}
	for (const command of ['git status', 'ls modules/account/src', 'cat accounts.md']) {
		assert.equal(await verdict('Bash', {command}), 'pass', command);
	}
	assert.notEqual(await verdict('Read', {file_path: path.join(accountDir, 'keys', 'gh')}), 'pass');
	assert.notEqual(await verdict('Write', {file_path: path.join(accountDir, 'secrets', 'x.json'), content: ''}), 'pass');
});

test('the hook forces a prompt for the hub instructions every session loads', async () => {
	const md = (f: string) => path.join(paths.mdDir, f);
	writeFileSync(md('SOUL.md'), 's');
	assert.equal(await decision('Edit', {file_path: md('CLAUDE.md'), old_string: 'a', new_string: 'b'}), `ask:${POLICY_ASK.instructions}`);
	assert.equal(await decision('Write', {file_path: md('SOUL.md'), content: 'x'}), `ask:${POLICY_ASK.instructions}`);
	assert.equal(await decision('Write', {file_path: md('notes.md'), content: 'x'}), 'pass');
});

test('the hook asks for the first fetch from a host until it is allowed for good', async () => {
	const approved = new Set(['web:docs.example.com']);
	const webHook = createPolicyHook(buildScope(paths, path.join(tmp, 'home')), paths.configDir, {approved: k => approved.has(k)});
	const fetchDecision = async (url: unknown) => {
		const out = (await webHook(
			{hook_event_name: 'PreToolUse', tool_name: 'WebFetch', tool_input: {url, prompt: 'p'}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecision?: string}};
		return out.hookSpecificOutput?.permissionDecision ?? 'pass';
	};
	assert.equal(await fetchDecision('https://docs.example.com/a?q=1'), 'pass');
	assert.equal(await fetchDecision('https://DOCS.Example.com/b'), 'pass');
	assert.equal(await fetchDecision('https://evil.example.net/?d=secret'), 'ask');
	assert.equal(await fetchDecision('https://docs.example.com.evil.net/'), 'ask');
	assert.equal(await fetchDecision('ftp://docs.example.com/'), 'deny');
	assert.equal(await fetchDecision(42), 'deny');
	assert.equal(await decision('WebFetch', {url: 'https://docs.example.com/'}), `ask:${POLICY_ASK.newHost}`);
});

test('webKey keys a fetch by its lower-case host', () => {
	assert.equal(webKey('https://User:pw@Example.COM:8443/x'), 'web:example.com');
	assert.equal(webKey('http://[::1]/'), 'web:[::1]');
	assert.equal(webKey('file:///etc/passwd'), undefined);
	assert.equal(webKey('not a url'), undefined);
});

test('the hook brings the Bash sandbox up to date before a command and denies when it cannot', async () => {
	let calls = 0;
	let fail = false;
	const synced = createPolicyHook(buildScope(paths, path.join(tmp, 'home')), paths.configDir, {
		beforeBash: async () => {
			calls++;
			if (fail) throw new Error('no query');
		},
	});
	const ask = async (command: string) => {
		const out = (await synced(
			{hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {command}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
			't',
			opts,
		)) as {hookSpecificOutput?: {permissionDecisionReason?: string}};
		return out.hookSpecificOutput?.permissionDecisionReason ?? 'pass';
	};
	assert.equal(await ask('ls'), 'pass');
	assert.equal(calls, 1);
	fail = true;
	assert.equal(await ask('ls'), POLICY_DENY.sandbox);
	assert.equal(await ask('cat /proc/1/environ'), POLICY_DENY.procEnv);
	assert.equal(calls, 2, 'a command refused by name never reaches the sandbox');
});
