import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {createPolicyHook} from '../src/chat/policy-hook.js';
import {POLICY_DENY} from '../src/chat/permission.js';
import {buildChatHint, buildOptions, resolvePaths, withProjects} from '../src/config.js';
import {loadProjectAccess, type ProjectAccess, type ProjectAccessReader} from '../src/deps/project.js';
import {buildChatSettings, buildScope, classifyEditTarget, isPathAllowed} from '../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-projects-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

const projectDir = path.join(tmp, 'app');
const data = path.join(tmp, 'data');
const hubDir = path.join(data, 'md');
const dataDir = path.join(data, 'claude');
const projectData = path.join(data, 'project');
const workplace = path.join(tmp, 'workplace');
const stage = path.join(tmp, 'stage');
const docs = path.join(hubDir, 'projects');
for (const d of [projectDir, path.join(dataDir, 'config'), path.join(workplace, 'web'), path.join(workplace, 'api'), path.join(docs, 'web'), path.join(docs, 'api'), stage, projectData]) {
	mkdirSync(d, {recursive: true});
}
symlinkSync(hubDir, path.join(dataDir, 'md'));
writeFileSync(path.join(workplace, 'web', 'a.txt'), 'a');
writeFileSync(path.join(workplace, 'web', '.env'), 'X=1');
const webStage = path.join(stage, 'web-stage-ab12cd34-1');
const apiStage = path.join(stage, 'api-stage-ab12cd34-2');
mkdirSync(webStage);
mkdirSync(apiStage);

let current: ProjectAccess | undefined;
const access = (isolated: string[]): ProjectAccess => ({
	roots: [workplace, stage],
	docs,
	managed: [workplace, stage, docs],
	writable: [
		...isolated.flatMap(n => [path.join(workplace, n), path.join(docs, n)]),
		...(isolated.includes('web') ? [webStage] : []),
		...(isolated.includes('api') ? [apiStage] : []),
	],
});
const reader: ProjectAccessReader = {dataDir: projectData, read: async () => current, readSync: () => current};

const paths = {
	projectDir,
	hubDir,
	mdDir: path.join(dataDir, 'md'),
	dataDir,
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
	projects: reader,
};
const scope = buildScope(paths, path.join(tmp, 'home'));
const cls = (p: string) => classifyEditTarget(p, scope);

describe('policy with projects', () => {
	it('reads projects and stages whatever the isolation', async () => {
		current = access([]);
		assert.ok(await isPathAllowed(path.join(workplace, 'api', 'x.ts'), scope));
		assert.ok(await isPathAllowed(path.join(apiStage, 'x.ts'), scope));
		assert.ok(!(await isPathAllowed(path.join(workplace, 'web', '.env'), scope)));
		assert.ok(!(await isPathAllowed(path.join(projectData, 'state.json'), scope)), 'the project data dir is outside every root');
	});

	it('denies every project write without isolation, docs included', async () => {
		current = access([]);
		assert.equal(await cls(path.join(workplace, 'web', 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(webStage, 'a.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(docs, 'web', 'README.md')), 'deny-readonly');
		assert.equal(await cls(path.join(docs, 'new.md')), 'deny-readonly');
		assert.equal(await cls(path.join(workplace, 'new.txt')), 'deny-readonly');
		assert.equal(await cls(path.join(hubDir, 'notes.md')), 'free', 'the rest of the hub is unchanged');
		assert.equal(await cls(path.join(projectDir, 'x.ts')), 'auto-eligible', 'yena itself is unchanged');
	});

	it('opens the isolated project, its docs and its stages, nothing else', async () => {
		current = access(['web']);
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
		current = access(['web']);
		symlinkSync(path.join(workplace, 'api'), path.join(workplace, 'web', 'to-api'));
		assert.equal(await cls(path.join(workplace, 'web', 'to-api', 'x.ts')), 'deny-readonly');
		symlinkSync(path.join(workplace, 'web'), path.join(projectDir, 'to-web'));
		assert.equal(await cls(path.join(projectDir, 'to-web', 'x.ts')), 'auto-eligible');
		current = access([]);
		assert.equal(await cls(path.join(projectDir, 'to-web', 'x.ts')), 'deny-readonly');
	});

	it('picks up isolation changes during a chat', async () => {
		current = access([]);
		assert.equal(await cls(path.join(workplace, 'api', 'a.txt')), 'deny-readonly');
		current = access(['api']);
		assert.equal(await cls(path.join(workplace, 'api', 'a.txt')), 'auto-eligible');
	});

	it('a locked access closes what it manages and opens no roots', async () => {
		current = {roots: [], docs: hubDir, managed: [hubDir], writable: []};
		assert.equal(await cls(path.join(hubDir, 'notes.md')), 'deny-readonly');
		assert.ok(!(await isPathAllowed(path.join(workplace, 'web', 'a.txt'), scope)));
		current = undefined;
		assert.equal(await cls(path.join(docs, 'web', 'x.md')), 'free', 'no state: nothing is managed');
	});

	it('the hook denies read-only writes and shell commands naming the project data dir', async () => {
		current = access([]);
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
		assert.equal(await run('Bash', {command: `echo {} > ${projectData}/state.json`}), POLICY_DENY.projectState);
		assert.equal(await run('Bash', {command: 'ls /workplace'}), 'pass');
	});

	it('settings deny edits in the project data dir', () => {
		assert.ok(buildChatSettings(paths).permissions.deny.includes(`Edit(/${projectData}/**)`));
		assert.ok(!buildChatSettings({...paths, projects: {...reader, dataDir: ''}}).permissions.deny.some(r => r.includes('Edit(///**)')));
	});
});

describe('chat options with projects', () => {
	const claudePaths = {...resolvePaths(dataDir, path.join(projectDir, 'modules', 'claude')), hubDir, projects: reader};
	const cred = {kind: 'api-key', source: 'env', value: 'k'} as never;

	it('adds existing project roots as working dirs and describes them in the hint', () => {
		current = access([]);
		const opts = buildOptions({paths: claudePaths, cred, abortController: new AbortController()});
		assert.deepEqual(opts.additionalDirectories, [hubDir, claudePaths.configDir, workplace, stage]);
		const hint = buildChatHint(claudePaths);
		assert.match(hint, new RegExp(`mounted in ${workplace}/<name>`));
		assert.match(hint, /read-only until the console command "project isolate <name>"/);
	});

	it('leaves both alone without the project module', () => {
		const {projects: _none, ...none} = claudePaths;
		assert.deepEqual(buildOptions({paths: none, cred, abortController: new AbortController()}).additionalDirectories, [hubDir, none.configDir]);
		assert.doesNotMatch(buildChatHint(none), /project isolate/);
	});
});

describe('the optional project dependency', () => {
	it('loads the installed module and reads through its public entry', async () => {
		const loaded = await loadProjectAccess('/data/claude', '/data/md');
		assert.ok(loaded, 'the project module is installed next to claude');
		assert.equal(loaded.dataDir, '/data/project');
		assert.equal(typeof loaded.readSync, 'function');
		const withIt = await withProjects(resolvePaths('/data/claude'));
		assert.equal(withIt.projects?.dataDir, '/data/project');
	});
});
