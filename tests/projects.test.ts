import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {createPolicyHook} from '../src/chat/policy-hook.js';
import {POLICY_DENY} from '../src/chat/permission.js';
import {buildChatHint, buildOptions, resolvePaths} from '../src/config.js';
import {buildChatSettings, buildScope, classifyEditTarget, isPathAllowed} from '../src/policy.js';
import {parseProjectState, projectStateFile, readProjectAccess} from '../src/projects.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-projects-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

const projectDir = path.join(tmp, 'app');
const data = path.join(tmp, 'data');
const hubDir = path.join(data, 'md');
const dataDir = path.join(data, 'claude');
const workplace = path.join(tmp, 'workplace');
const stage = path.join(tmp, 'stage');
const docs = path.join(hubDir, 'projects');
const stateFile = projectStateFile(hubDir);
const paths = {
	projectDir,
	hubDir,
	mdDir: path.join(dataDir, 'md'),
	dataDir,
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
	projectStateFile: stateFile,
};
for (const d of [projectDir, paths.configDir, path.join(workplace, 'web'), path.join(workplace, 'api'), path.join(docs, 'web'), path.join(docs, 'api'), stage]) {
	mkdirSync(d, {recursive: true});
}
mkdirSync(path.dirname(stateFile), {recursive: true});
symlinkSync(hubDir, paths.mdDir);
writeFileSync(path.join(workplace, 'web', 'a.txt'), 'a');
writeFileSync(path.join(workplace, 'web', '.env'), 'X=1');
const webStage = path.join(stage, 'web-stage-ab12cd34-1');
const apiStage = path.join(stage, 'api-stage-ab12cd34-2');
mkdirSync(webStage);
mkdirSync(apiStage);

const state = (session: unknown) => JSON.stringify({v: 1, workplace, stage, md: '/elsewhere', session});
const write = (session: unknown) => writeFileSync(stateFile, state(session));
const isolated = (names: string[]) =>
	write({
		id: 'ab12cd34',
		startedAt: 'x',
		isolated: names,
		nextStage: 3,
		stages: [
			{project: 'web', id: 1, path: webStage, base: null},
			{project: 'api', id: 2, path: apiStage, base: null},
		],
	});

const scope = buildScope(paths, path.join(tmp, 'home'));
const cls = (p: string) => classifyEditTarget(p, scope);

describe('project state', () => {
	it('gives roots and writable folders of the isolated projects only', () => {
		const access = parseProjectState(
			state({isolated: ['web'], stages: [{project: 'web', path: webStage}, {project: 'api', path: apiStage}]}),
			hubDir,
		);
		assert.deepEqual(access.roots, [workplace, stage]);
		assert.equal(access.docs, docs, 'docs come from the hub, not from the file');
		assert.deepEqual(access.writable, [path.join(workplace, 'web'), path.join(docs, 'web'), webStage]);
	});

	it('locks everything when the file is invalid or tampered', () => {
		const lockedAccess = {roots: [], docs, managed: [docs], writable: []};
		for (const text of [
			'{',
			JSON.stringify({v: 2, workplace, stage, session: null}),
			JSON.stringify({v: 1, workplace: 'rel', stage, session: null}),
			JSON.stringify({v: 1, workplace: '/', stage, session: null}),
			state({isolated: ['../x'], stages: []}),
			state({isolated: ['web'], stages: [{project: 'web', path: path.join(workplace, 'web')}]}),
			state({isolated: ['web'], stages: [{project: 'web', path: path.join(stage, 'api-stage-1')}]}),
		]) {
			assert.deepEqual(parseProjectState(text, hubDir), lockedAccess, text);
		}
	});

	it('a missing file means no project module', async () => {
		assert.equal(await readProjectAccess(path.join(tmp, 'none.json'), hubDir), undefined);
	});

	it('resolvePaths finds the file next to the hub', () => {
		assert.equal(resolvePaths('/data/claude').projectStateFile, '/data/project/state.json');
	});
});

describe('policy with projects', () => {
	it('reads projects and stages whatever the isolation', async () => {
		write(null);
		assert.ok(await isPathAllowed(path.join(workplace, 'api', 'x.ts'), scope));
		assert.ok(await isPathAllowed(path.join(apiStage, 'x.ts'), scope));
		assert.ok(!(await isPathAllowed(path.join(workplace, 'web', '.env'), scope)));
		assert.ok(!(await isPathAllowed(stateFile, scope)), 'the state file is outside every root');
	});

	it('denies every project write without a session, docs included', async () => {
		write(null);
		assert.equal(await cls(path.join(workplace, 'web', 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(webStage, 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(docs, 'web', 'README.md')), 'deny-readonly');
		assert.equal(await cls(path.join(docs, 'new.md')), 'deny-readonly');
		assert.equal(await cls(path.join(workplace, 'new.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(hubDir, 'notes.md')), 'free', 'the rest of the hub is unchanged');
		assert.equal(await cls(path.join(projectDir, 'x.ts')), 'auto-eligible', 'yena itself is unchanged');
	});

	it('opens the isolated project, its docs and its stages, nothing else', async () => {
		isolated(['web']);
		assert.equal(await cls(path.join(workplace, 'web', 'a.txt')), 'auto-eligible');
		assert.equal(await cls(path.join(workplace, 'web', 'src', 'new.ts')), 'auto-eligible');
		assert.equal(await cls(path.join(workplace, 'web', '.gitignore')), 'prompt-only');
		assert.equal(await cls(path.join(workplace, 'web', '.env')), 'deny-secret');
		assert.equal(await cls(path.join(workplace, 'web', 'CLAUDE.md')), 'deny-guard');
		assert.equal(await cls(path.join(webStage, 'a.txt')), 'auto-eligible');
		assert.equal(await cls(path.join(docs, 'web', 'CLAUDE.md')), 'free');
		assert.equal(await cls(path.join(workplace, 'api', 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(apiStage, 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(docs, 'api', 'x.md')), 'deny-readonly');
		assert.equal(await cls(path.join(workplace, 'web')), 'deny-readonly', 'the project folder itself');
	});

	it('follows symlinks to their target', async () => {
		isolated(['web']);
		symlinkSync(path.join(workplace, 'api'), path.join(workplace, 'web', 'to-api'));
		assert.equal(await cls(path.join(workplace, 'web', 'to-api', 'x.ts')), 'deny-readonly');
		symlinkSync(path.join(workplace, 'web'), path.join(projectDir, 'to-web'));
		assert.equal(await cls(path.join(projectDir, 'to-web', 'x.ts')), 'auto-eligible');
		write(null);
		assert.equal(await cls(path.join(projectDir, 'to-web', 'x.ts')), 'deny-readonly');
	});

	it('picks up isolation changes during a chat', async () => {
		isolated([]);
		assert.equal(await cls(path.join(workplace, 'api', 'a.txt')), 'deny-readonly');
		isolated(['api']);
		assert.equal(await cls(path.join(workplace, 'api', 'a.txt')), 'auto-eligible');
	});

	it('locks the hub projects dir when the state file is broken', async () => {
		writeFileSync(stateFile, 'not json');
		assert.equal(await cls(path.join(docs, 'web', 'x.md')), 'deny-readonly');
		assert.ok(!(await isPathAllowed(path.join(workplace, 'web', 'a.txt'), scope)));
	});

	it('the hook denies read-only writes and shell commands naming the state file', async () => {
		write(null);
		const hook = createPolicyHook(scope, paths.configDir);
		const run = async (tool_name: string, tool_input: Record<string, unknown>) => {
			const out = (await hook(
				{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: projectDir} as never,
				't',
				{signal: new AbortController().signal},
			)) as {hookSpecificOutput?: {permissionDecisionReason?: string}};
			return out.hookSpecificOutput?.permissionDecisionReason ?? 'pass';
		};
		assert.equal(await run('Write', {file_path: path.join(workplace, 'web', 'a.txt'), content: 'x'}), POLICY_DENY.readonly);
		assert.equal(await run('Read', {file_path: path.join(workplace, 'web', 'a.txt')}), 'pass');
		assert.equal(await run('Bash', {command: `echo {} > ${stateFile}`}), POLICY_DENY.projectState);
		assert.equal(await run('Bash', {command: 'ls /workplace'}), 'pass');
	});

	it('settings deny edits in the project data dir', () => {
		const deny = buildChatSettings(paths).permissions.deny;
		assert.ok(deny.includes(`Edit(/${path.dirname(stateFile)}/**)`));
	});
});

describe('chat options with projects', () => {
	const claudePaths = {...resolvePaths(dataDir, path.join(projectDir, 'modules', 'claude')), hubDir, projectStateFile: stateFile};
	const cred = {kind: 'api-key', source: 'env', value: 'k'} as never;

	it('adds existing project roots as working dirs and describes them in the hint', () => {
		write(null);
		const opts = buildOptions({paths: claudePaths, cred, abortController: new AbortController()});
		assert.deepEqual(opts.additionalDirectories, [hubDir, claudePaths.configDir, workplace, stage]);
		const hint = buildChatHint(claudePaths);
		assert.match(hint, new RegExp(`mounted in ${workplace}/<name>`));
		assert.match(hint, /read-only until the console command "project isolate <name>"/);
	});

	it('leaves both alone without the project module', () => {
		const none = {...claudePaths, projectStateFile: path.join(tmp, 'missing.json')};
		assert.deepEqual(buildOptions({paths: none, cred, abortController: new AbortController()}).additionalDirectories, [hubDir, none.configDir]);
		assert.doesNotMatch(buildChatHint(none), /project isolate/);
	});
});
