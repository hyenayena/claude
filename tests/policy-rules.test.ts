import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, beforeEach, describe, it} from 'node:test';
import type {ProjectAccess, ProjectAccessReader} from '../src/deps/project.js';
import {
	buildAskSettings,
	buildChatSettings,
	buildScope,
	classifyEditTarget,
	createCanUseTool,
	isPathAllowed,
	RULES_READ_DENY_MAX,
	rulesFor,
	rulesReadDeny,
} from '../src/policy.js';
import {resetRulesCaches} from '../src/rules.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-policy-rules-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
beforeEach(() => resetRulesCaches());

const workplace = path.join(tmp, 'workplace');
const stage = path.join(tmp, 'stage');
const web = path.join(workplace, 'web');
const api = path.join(workplace, 'api');
const hub = path.join(tmp, 'data', 'md');
const dataDir = path.join(tmp, 'data', 'claude');
const projectData = path.join(tmp, 'data', 'project');
const ruleFiles = path.join(projectData, 'rules');
const webStage = path.join(stage, 'web-stage-ab12cd34-1');

const put = (file: string, text = 'x') => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, text);
};
for (const d of [web, api, stage, hub, path.join(dataDir, 'config'), ruleFiles, webStage]) mkdirSync(d, {recursive: true});

const RULES = '[deny read]\n.yena/\n.env*\n!.env.example\n*.pem\n[ask read]\nnotes/private.md\n[deny write]\nscripts/\n/compose.yaml\n[ask write]\n/package.json\n**/.git/config\n';
for (const f of ['.env', '.env.example', 'a.ts', 'notes/private.md', 'scripts/x.sh', 'compose.yaml', 'package.json', '.git/config', 'keys/server.pem', '.claude/s.json']) put(path.join(web, f));
put(path.join(web, '.yenarules'), RULES);
put(path.join(api, 'a.ts'));
put(path.join(api, '.env'));
put(path.join(api, 'package.json'));
put(path.join(hub, 'CLAUDE.md'), 'c');
put(path.join(hub, 'SOUL.md'), 's');
put(path.join(web, 'CLAUDE.md'), 'c');

let session = ['web'];
const access = (): ProjectAccess => ({
	roots: [workplace, stage],
	docs: path.join(hub, 'projects'),
	managed: [workplace, stage, path.join(hub, 'projects')],
	writable: session.flatMap(n => [path.join(workplace, n), ...(n === 'web' ? [webStage] : [])]),
	stages: [{path: webStage, project: 'web'}],
});
const readerWith = (rulesFile?: (n: string) => string | undefined): ProjectAccessReader => ({
	dataDir: projectData,
	...(rulesFile && {rulesFile}),
	read: async () => access(),
	readSync: () => access(),
});
const projectRules = (n: string) => path.join(ruleFiles, `${n}.yenarules`);
const paths = (projects: ProjectAccessReader, projectDir = web) => ({
	projectDir,
	hubDir: hub,
	mdDir: path.join(dataDir, 'md'),
	dataDir,
	configDir: path.join(dataDir, 'config'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
	projects,
});
const withRules = buildScope(paths(readerWith(projectRules)), path.join(tmp, 'home'));
const cls = (p: string, scope = withRules) => classifyEditTarget(p, scope);
const w = (rel: string) => path.join(web, rel);
const opts = {signal: new AbortController().signal, toolUseID: 't'} as never;

describe('classifyEditTarget with rules', () => {
	it('deny write and deny read are deny-rules, ask write is ask-rules, the rest of the project is auto-eligible', async () => {
		for (const rel of ['scripts/x.sh', 'scripts/new.sh', 'compose.yaml', 'keys/server.pem']) assert.equal(await cls(w(rel)), 'deny-rules', rel);
		for (const rel of ['package.json', '.git/config']) assert.equal(await cls(w(rel)), 'ask-rules', rel);
		for (const rel of ['a.ts', 'new/dir/file.ts', '.env.example', 'Dockerfile', '.github/w.yml', 'notes/private.md']) assert.equal(await cls(w(rel)), 'auto-eligible', rel);
	});

	it('a .yenarules is deny-rules at any depth, existing or new', async () => {
		for (const rel of ['.yenarules', 'sub/.yenarules', 'deep/er/.yenarules']) assert.equal(await cls(w(rel)), 'deny-rules', rel);
		assert.equal(await cls(path.join(api, '.yenarules')), 'deny-readonly', 'a project that is not isolated is read-only first');
	});

	it('the project rules file and folder are never writable', async () => {
		const reader = readerWith(projectRules);
		const scope = buildScope(paths(reader), path.join(tmp, 'home'));
		for (const f of [projectRules('web'), path.join(ruleFiles, 'new.yenarules')]) assert.notEqual(await cls(f, scope), 'auto-eligible', f);
		assert.equal((await rulesFor(projectRules('web'), scope))?.write, 'deny');
	});

	it('isolation is still checked first: another project is deny-readonly whatever its rules say', async () => {
		put(projectRules('api'), '[ask write]\n/package.json\n');
		assert.equal(await cls(path.join(api, 'package.json')), 'deny-readonly');
		session = ['web', 'api'];
		assert.equal(await cls(path.join(api, 'package.json')), 'ask-rules', 'the project file applies once isolated');
		assert.equal(await cls(path.join(api, 'a.ts')), 'auto-eligible');
		session = ['web'];
	});

	it('a stage uses its project file, a reader without rulesFile gives the in-repo rules only', async () => {
		put(projectRules('web'), '[deny write]\nstage-only.txt\n');
		assert.equal(await cls(path.join(webStage, 'stage-only.txt')), 'deny-rules');
		assert.equal(await cls(w('stage-only.txt')), 'deny-rules');
		const plain = buildScope(paths(readerWith(undefined)), path.join(tmp, 'home'));
		assert.equal(await cls(w('stage-only.txt'), plain), 'auto-eligible');
		assert.equal(await cls(w('scripts/x.sh'), plain), 'deny-rules');
		rmSync(projectRules('web'));
	});

	it('the floors hold without any rules file: .yena, secret names, .claude and the project CLAUDE.md', async () => {
		const bare = path.join(workplace, 'bare');
		for (const f of ['.env', 'k.pem', '.yena/x', 'a.ts', '.claude/s.json', 'CLAUDE.md']) put(path.join(bare, f));
		session = ['bare'];
		const scope = buildScope(paths(readerWith(undefined), bare), path.join(tmp, 'home'));
		const at = (rel: string) => cls(path.join(bare, rel), scope);
		assert.equal(await at('.env'), 'deny-secret');
		assert.equal(await at('k.pem'), 'deny-secret');
		assert.equal(await at('.yena/x'), 'deny-secret');
		assert.equal(await at('.claude/s.json'), 'deny-guard');
		assert.equal(await at('CLAUDE.md'), 'deny-guard');
		assert.equal(await at('a.ts'), 'auto-eligible');
		session = ['web'];
	});

	it('the hub instructions are free, no longer a prompt', async () => {
		assert.equal(await cls(path.join(hub, 'CLAUDE.md')), 'free');
		assert.equal(await cls(path.join(hub, 'SOUL.md')), 'free');
	});

	it('a symlink is classified by its target', async () => {
		symlinkSync(w('compose.yaml'), w('harmless.txt'));
		assert.equal(await cls(w('harmless.txt')), 'deny-rules');
	});

	it('a malformed rules file closes its folder to the file tools and Edit', async () => {
		put(w('broken/.yenarules'), '[oops]\n');
		put(w('broken/f.txt'));
		assert.equal(await cls(w('broken/f.txt')), 'deny-rules');
		assert.ok(!(await isPathAllowed(w('broken/f.txt'), withRules)));
		assert.ok(await isPathAllowed(w('broken/.yenarules'), withRules), 'the file itself stays readable');
		assert.equal(await cls(w('broken/.yenarules')), 'deny-rules');
	});
});

describe('read tools with rules', () => {
	const canUse = createCanUseTool(withRules);
	const verdict = async (tool: string, input: Record<string, unknown>) => (await canUse(tool, input, opts))?.behavior;

	it('deny read paths are refused for Read, Glob and Grep, the pattern base included', async () => {
		assert.equal(await verdict('Read', {file_path: w('.env')}), 'deny');
		assert.equal(await verdict('Read', {file_path: w('keys/server.pem')}), 'deny');
		assert.equal(await verdict('Grep', {pattern: 'x', path: w('.env')}), 'deny');
		assert.equal(await verdict('Glob', {pattern: path.join(w('.yena'), '**')}), 'deny');
		assert.equal(await verdict('Glob', {pattern: '*', path: w('keys')}), 'allow');
		assert.equal(await verdict('Read', {file_path: w('.env.example')}), 'allow');
		assert.equal(await verdict('Read', {file_path: w('a.ts')}), 'allow');
	});

	it('an ask read path is allowed by the root check and refused only in "chat ask", which has no prompt', async () => {
		assert.equal(await verdict('Read', {file_path: w('notes/private.md')}), 'allow');
		const ask = createCanUseTool(withRules, {refuseAsk: true});
		assert.equal((await ask('Read', {file_path: w('notes/private.md')}, opts))?.behavior, 'deny');
		assert.equal((await ask('Read', {file_path: w('a.ts')}, opts))?.behavior, 'allow');
	});

	it('Edit and Write targets that rules deny for reading are not readable either', async () => {
		assert.ok(!(await isPathAllowed(w('.env'), withRules)));
		assert.ok(await isPathAllowed(w('scripts/x.sh'), withRules), 'deny write alone does not close reading');
	});
});

describe('settings', () => {
	const p = paths(readerWith(projectRules));

	it('have no hub ask rules and no hub instruction rules', () => {
		const s = buildChatSettings(p);
		assert.deepEqual(s.permissions.ask, []);
		assert.ok(!s.permissions.allow.some(r => r.includes('CLAUDE.md')));
		assert.ok(!s.permissions.deny.some(r => r.startsWith('Edit(') && r.includes(`${hub}/CLAUDE.md`)));
	});

	it('carry Read deny rules for the expanded deny-read paths, concrete only', () => {
		const rules = [w('.env'), w('secrets'), w('odd*name'), 'relative/path', w('with(paren')];
		for (const s of [buildChatSettings(p, rules), buildAskSettings(p, rules)]) {
			for (const rule of [`Read(/${w('.env')})`, `Read(/${w('.env')}/**)`, `Read(/${w('secrets')})`, `Read(/${w('secrets')}/**)`]) assert.ok(s.permissions.deny.includes(rule), rule);
			assert.ok(!s.permissions.deny.some(r => r.includes('odd*name') || r.includes('relative/path') || r.includes('with(paren')));
		}
	});

	it('keep every existing deny, .yena included, and cap the number of rules', () => {
		const plain = buildChatSettings(p).permissions.deny;
		const withRulesDeny = buildChatSettings(p, [w('.env')]).permissions.deny;
		for (const r of plain) assert.ok(withRulesDeny.includes(r), r);
		assert.ok(withRulesDeny.includes('Read(./.yena/**)'));
		const many = Array.from({length: 5000}, (_, i) => `/w/f${i}`);
		assert.equal(rulesReadDeny(many).length, RULES_READ_DENY_MAX);
	});
});
