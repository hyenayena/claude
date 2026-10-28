import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {createPolicyHook} from '../src/chat/policy-hook.js';
import {POLICY_DENY} from '../src/chat/permission.js';
import {isReadOnlyDir, resolvePaths, withProjects} from '../src/config.js';
import type {ProjectAccess, ProjectAccessReader} from '../src/deps/project.js';
import {buildScope, classifyEditTarget, isPathAllowed, isYenaCheckout} from '../src/policy.js';

// IMG-9: the read-only image at /app, yena's working copy in the workplace, the host's state dir.
const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-image-policy-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

const image = path.join(tmp, 'app');
const data = path.join(tmp, 'data');
const hubDir = path.join(data, 'md');
const dataDir = path.join(data, 'claude');
const hostState = path.join(data, 'host');
const workplace = path.join(tmp, 'workplace');
const yena = path.join(workplace, 'yena');
const web = path.join(workplace, 'web');
const docs = path.join(hubDir, 'projects');

const touch = (file: string) => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, 'x');
};
for (const f of ['yena', 'compose.yaml', 'src/cli.ts']) {
	touch(path.join(image, f));
	touch(path.join(yena, f));
}
touch(path.join(yena, '.yena', 'claude', 'accounts.json'));
touch(path.join(web, 'compose.yaml'));
touch(path.join(hostState, 'mode.json'));
mkdirSync(path.join(dataDir, 'config'), {recursive: true});
mkdirSync(docs, {recursive: true});

const access: ProjectAccess = {roots: [workplace], docs, managed: [workplace, docs], writable: [yena, web]};
const reader: ProjectAccessReader = {dataDir: path.join(data, 'project'), read: async () => access, readSync: () => access};
const base = {
	projectDir: image,
	hubDir,
	mdDir: path.join(dataDir, 'md'),
	dataDir,
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
	projects: reader,
};
const imageScope = buildScope({...base, imageReadOnly: true, hostState}, path.join(tmp, 'home'));
const writableScope = buildScope(base, path.join(tmp, 'home'));

const hookRun = (scope: ReturnType<typeof buildScope>) => {
	const hook = createPolicyHook(scope, base.configDir);
	return async (tool_name: string, tool_input: Record<string, unknown>) => {
		const out = (await hook(
			{hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: image} as never,
			't',
			{signal: new AbortController().signal},
		)) as {hookSpecificOutput?: {permissionDecisionReason?: string}};
		return out.hookSpecificOutput?.permissionDecisionReason ?? 'pass';
	};
};

describe('policy with the read-only image', () => {
	it('refuses writes into the image with a pointer to the working copy, and still reads it', async () => {
		assert.equal(await classifyEditTarget(path.join(image, 'src', 'cli.ts'), imageScope), 'deny-image');
		assert.equal(await classifyEditTarget('src/new.ts', imageScope), 'deny-image');
		assert.ok(await isPathAllowed(path.join(image, 'src', 'cli.ts'), imageScope));
		const run = hookRun(imageScope);
		assert.equal(await run('Write', {file_path: path.join(image, 'src', 'cli.ts'), content: 'x'}), POLICY_DENY.image);
		assert.match(POLICY_DENY.image, /\/workplace\/yena/);
	});

	it('a writable project dir (today\'s bind mount) keeps the old classes', async () => {
		assert.equal(await classifyEditTarget(path.join(image, 'src', 'cli.ts'), writableScope), 'auto-eligible');
		assert.equal(await classifyEditTarget(path.join(image, 'yena'), writableScope), 'prompt-only');
	});

	it('in an isolated yena checkout the files that run on the host stay prompt-only', async () => {
		for (const rel of ['yena', 'compose.yaml', 'Dockerfile', '.dockerignore', 'package.json', 'scripts/each-module.sh', 'modules/claude/bin/claude', 'modules/claude/src/policy.ts', 'modules/core/yena.json', '.git/config']) {
			assert.equal(await classifyEditTarget(path.join(yena, rel), imageScope), 'prompt-only', rel);
		}
		for (const rel of ['src/cli.ts', 'modules/core/src/app.tsx', 'tests/x.test.ts']) {
			assert.equal(await classifyEditTarget(path.join(yena, rel), imageScope), 'auto-eligible', rel);
		}
	});

	it('other projects are not treated as yena checkouts', async () => {
		assert.ok(await isYenaCheckout(yena));
		assert.ok(!(await isYenaCheckout(web)));
		assert.equal(await classifyEditTarget(path.join(web, 'compose.yaml'), imageScope), 'auto-eligible');
	});

	it('a project\'s .yena (a checkout\'s data, secrets included) is closed to file tools', async () => {
		const secret = path.join(yena, '.yena', 'claude', 'accounts.json');
		assert.ok(!(await isPathAllowed(secret, imageScope)));
		assert.ok(!(await isPathAllowed(path.join(web, '.yena', 'x'), imageScope)));
		assert.equal(await classifyEditTarget(secret, imageScope), 'deny-secret');
		assert.ok(await isPathAllowed(path.join(yena, 'src', 'cli.ts'), imageScope));
	});

	it('the host state dir: file tools cannot reach it, shell commands naming it are refused', async () => {
		const run = hookRun(imageScope);
		assert.equal(await classifyEditTarget(path.join(hostState, 'modules', 'core', 'index.mjs'), imageScope), 'deny-outside');
		assert.ok(!(await isPathAllowed(path.join(hostState, 'mode.json'), imageScope)));
		assert.equal(await run('Bash', {command: `echo '{"mode":"dev"}' > ${hostState}/mode.json`}), POLICY_DENY.hostState);
		assert.equal(await run('Bash', {command: `cp -r x ${hostState}/modules/claude`}), POLICY_DENY.hostState);
		assert.equal(await run('Bash', {command: 'ls /workplace'}), 'pass');
	});
});

describe('withProjects', () => {
	const paths = resolvePaths(dataDir, path.join(image, 'modules', 'claude'));

	it('marks a read-only project dir and takes the host state from YENA_HOST_STATE', async () => {
		const got = await withProjects(paths, {YENA_HOST_STATE: hostState}, () => true);
		assert.equal(got.imageReadOnly, true);
		assert.equal(got.hostState, hostState);
	});

	it('leaves both out for a writable dir and a missing or relative YENA_HOST_STATE', async () => {
		for (const env of [{}, {YENA_HOST_STATE: 'relative/host'}]) {
			const got = await withProjects(paths, env, () => false);
			assert.equal(got.imageReadOnly, undefined);
			assert.equal(got.hostState, undefined);
		}
	});

	it('isReadOnlyDir is false for a writable dir (only EROFS counts)', () => {
		assert.equal(isReadOnlyDir(tmp), false);
		assert.equal(isReadOnlyDir(path.join(tmp, 'missing')), false);
	});
});
