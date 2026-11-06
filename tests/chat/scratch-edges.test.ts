import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {scratchDenied} from '../../src/chat/permission.js';
import {createPolicyHook} from '../../src/chat/policy-hook.js';
import {scratchParentOf, sweepScratch} from '../../src/chat/scratch.js';
import {buildChatHint, buildEnv, resolvePaths} from '../../src/config.js';
import {buildScope, classifyEditTarget, inSharedTmp, isPathAllowed} from '../../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-scratch-edges-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
const projectDir = path.join(tmp, 'project');
const dataDir = path.join(tmp, 'data');
const sessionTmp = path.join(tmp, 'sess');
const scratch = path.join(sessionTmp, 'scratch', 'aaaaaaaa');
const sibling = path.join(sessionTmp, 'scratch', 'aaaaaaaa2');
const tasks1 = path.join(sessionTmp, 'other', 'sid1', 'tasks');
const tasks2 = path.join(sessionTmp, 'other', 'sid2', 'tasks');
const paths = {
	projectDir,
	mdDir: path.join(dataDir, 'md'),
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'login-file'),
};
for (const d of [projectDir, paths.mdDir, paths.configDir, scratch, sibling, tasks1, tasks2]) mkdirSync(d, {recursive: true});
for (const f of [path.join(scratch, 'f.txt'), path.join(sibling, 'f.txt'), path.join(tasks1, 'a.output'), path.join(tasks2, 'b.output')]) {
	writeFileSync(f, 'x');
}
const scope = buildScope({...paths, sessionTmp, scratch, sessionTasks: () => [tasks1]}, path.join(tmp, 'home'));
const hook = createPolicyHook(scope, paths.configDir);
const decide = async (tool: string, input: Record<string, unknown>) => {
	const out = (await hook(
		{hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
		't',
		{signal: new AbortController().signal},
	)) as {hookSpecificOutput?: {permissionDecision?: string; permissionDecisionReason?: string}};
	return out.hookSpecificOutput ? `${out.hookSpecificOutput.permissionDecision}:${out.hookSpecificOutput.permissionDecisionReason}` : 'pass';
};

describe('scratch path edges', () => {
	it('does not treat a sibling sharing the scratch name as a prefix as own', async () => {
		const sib = path.join(sibling, 'f.txt');
		assert.ok(!(await isPathAllowed(sib, scope)));
		assert.equal(await classifyEditTarget(sib, scope), 'deny-outside');
		assert.ok(await inSharedTmp(sib, scope));
	});

	it('refuses .. out of the scratch for file tools and names the scratch', async () => {
		const up = path.join(scratch, '..', 'aaaaaaaa2', 'f.txt');
		assert.equal(await classifyEditTarget(up, scope), 'deny-outside');
		assert.equal(await decide('Read', {file_path: up}), `deny:${scratchDenied(scratch)}`);
		assert.equal(await decide('Grep', {pattern: 'x', path: path.join(scratch, '..')}), `deny:${scratchDenied(scratch)}`);
		assert.equal(await decide('Glob', {pattern: '*', path: path.join(scratch, '..', '..')}), `deny:${scratchDenied(scratch)}`);
	});

	it('allows Glob and Grep on the scratch itself and inside it, but not Write on the folder itself', async () => {
		assert.equal(await decide('Glob', {pattern: '*', path: scratch}), 'pass');
		assert.equal(await decide('Grep', {pattern: 'x', path: path.join(scratch, 'f.txt')}), 'pass');
		assert.equal(await decide('Read', {file_path: path.join(scratch, 'f.txt')}), 'pass');
		assert.match(await decide('Write', {file_path: scratch}), /^deny:/);
	});

	it('resolves a relative path against the project, never the scratch', async () => {
		const rel = path.relative(projectDir, path.join(scratch, 'f.txt'));
		assert.equal(await classifyEditTarget(rel, scope), 'free');
		assert.equal(await classifyEditTarget('f.txt', scope), 'auto-eligible');
	});

	it('reads only the listed session task dirs, never edits them', async () => {
		assert.equal(await decide('Read', {file_path: path.join(tasks1, 'a.output')}), 'pass');
		assert.equal(await decide('Read', {file_path: path.join(tasks2, 'b.output')}), `deny:${scratchDenied(scratch)}`);
		assert.notEqual(await classifyEditTarget(path.join(tasks1, 'a.output'), scope), 'free');
	});

	it('keeps the plain outside reason for paths outside tmp', async () => {
		const r = await decide('Read', {file_path: '/etc/hostname'});
		assert.match(r, /^deny:/);
		assert.ok(!r.includes('scratch folder'));
	});
});

describe('sweep liveness without /proc', () => {
	const parent = scratchParentOf(sessionTmp);
	const seedLive = (id: string, procStart: string | undefined) => {
		mkdirSync(path.join(parent, id), {recursive: true});
		writeFileSync(path.join(parent, `${id}.owner`), JSON.stringify({v: 1, pid: 4242, ...(procStart !== undefined && {procStart})}));
	};

	it('keeps a live pid whose start time was never recorded', () => {
		seedLive('10000001', undefined);
		assert.equal(sweepScratch(parent, {alive: () => true, procStartOf: () => undefined}), 0);
		assert.ok(existsSync(path.join(parent, '10000001')));
	});
});

describe('chat env and hint', () => {
	it('exports YENA_SCRATCH only with a scratch and names it in the hint', () => {
		const cp = resolvePaths(path.join(tmp, 'cd'), path.join(tmp, 'mod'));
		const cred = {source: 'api-key', value: 'v', passthrough: false} as never;
		assert.equal(buildEnv({}, cp, cred, undefined, scratch).YENA_SCRATCH, scratch);
		assert.ok(buildChatHint(cp, scratch).includes(scratch));
		assert.ok(!buildChatHint(cp).includes('YENA_SCRATCH'));
	});
});
