import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {
	ALLOWED_TOOLS,
	buildAskSettings,
	buildChatSettings,
	CHAT_DISALLOWED_TOOLS,
	CHAT_TOOLS,
	classifyEditTarget,
	buildScope,
	createCanUseTool,
	DISALLOWED_TOOLS,
	GUARD_DENY,
	isGuardedPath,
	isPathAllowed,
} from '../src/policy.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-policy-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

const projectDir = path.join(tmp, 'project');
const dataDir = path.join(projectDir, '.yena', 'claude');
const outside = path.join(tmp, 'outside');
const home = path.join(tmp, 'home');
const paths = {
	projectDir,
	mdDir: path.join(dataDir, 'md'),
	configDir: path.join(dataDir, 'config'),
	tokenFile: path.join(dataDir, '.token'),
	stateFile: path.join(dataDir, 'state.json'),
	credentialsFile: path.join(dataDir, 'credentials.json'),
};
for (const d of [paths.mdDir, paths.configDir, outside, path.join(home, '.ssh')]) {
	mkdirSync(d, {recursive: true});
}
writeFileSync(path.join(projectDir, 'a.txt'), 'a');
writeFileSync(path.join(projectDir, '.env'), 'SECRET=1');
writeFileSync(path.join(paths.mdDir, 'CLAUDE.md'), 'hi');
writeFileSync(paths.tokenFile, 'sk-ant-oat-TESTVALUE0123456789abcdef');
writeFileSync(paths.credentialsFile, '{}');
writeFileSync(path.join(outside, 'x.txt'), 'x');
writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'k');
symlinkSync(outside, path.join(projectDir, 'link'));

const scope = buildScope(paths, home);
const canUse = createCanUseTool(scope);
const opts = {signal: new AbortController().signal, toolUseID: 't'} as never;
const run = async (name: string, input: Record<string, unknown>) => (await canUse(name, input, opts))!;

describe('isPathAllowed', () => {
	it('allows project and md files, including new ones', async () => {
		assert.ok(await isPathAllowed(path.join(projectDir, 'a.txt'), scope));
		assert.ok(await isPathAllowed('a.txt', scope));
		assert.ok(await isPathAllowed(path.join(projectDir, 'new', 'file.txt'), scope));
		assert.ok(await isPathAllowed(path.join(paths.mdDir, 'CLAUDE.md'), scope));
		assert.ok(await isPathAllowed(path.join(paths.configDir, 'agents', 'coder.md'), scope));
		assert.ok(await isPathAllowed(paths.configDir, scope));
	});

	it('denies outside paths, traversal and symlink escapes', async () => {
		assert.ok(!(await isPathAllowed('/etc/passwd', scope)));
		assert.ok(!(await isPathAllowed('../outside/x.txt', scope)));
		assert.ok(!(await isPathAllowed(path.join(projectDir, '..', 'outside', 'x.txt'), scope)));
		assert.ok(!(await isPathAllowed('link/x.txt', scope)));
		assert.ok(!(await isPathAllowed('link', scope)));
	});

	it('denies secrets', async () => {
		for (const p of [
			paths.tokenFile,
			paths.credentialsFile,
			paths.stateFile,
			path.join(projectDir, '.env'),
			path.join(projectDir, 'sub', '.env.local'),
			path.join(projectDir, 'k.pem'),
			path.join(projectDir, '.yena', 'other'),
			'/proc/self/environ',
			path.join(home, '.ssh', 'id_rsa'),
		]) {
			assert.ok(!(await isPathAllowed(p, scope)), p);
		}
	});

	it('rejects empty and NUL paths', async () => {
		assert.ok(!(await isPathAllowed('', scope)));
		assert.ok(!(await isPathAllowed('a\0b', scope)));
	});
});

describe('canUseTool', () => {
	it('allows Read, Glob and Grep in scope', async () => {
		const input = {file_path: path.join(projectDir, 'a.txt')};
		assert.deepEqual(await run('Read', input), {behavior: 'allow', updatedInput: input});
		assert.equal((await run('Read', {file_path: path.join(paths.mdDir, 'CLAUDE.md')})).behavior, 'allow');
		assert.equal((await run('Glob', {pattern: '**/*.ts'})).behavior, 'allow');
		assert.equal((await run('Glob', {pattern: '*.md', path: paths.mdDir})).behavior, 'allow');
		assert.equal((await run('Grep', {pattern: 'x', glob: '*.ts'})).behavior, 'allow');
	});

	it('denies paths outside scope with the path message', async () => {
		for (const [name, input] of [
			['Read', {file_path: '/etc/passwd'}],
			['Read', {file_path: '../outside/x.txt'}],
			['Read', {file_path: path.join(projectDir, 'link', 'x.txt')}],
			['Read', {file_path: paths.tokenFile}],
			['Read', {file_path: '/proc/self/environ'}],
			['Read', {file_path: path.join(home, '.ssh', 'id_rsa')}],
			['Read', {file_path: path.join(projectDir, '.env')}],
			['Read', {}],
			['Grep', {pattern: 'x', path: '/etc'}],
			['Grep', {pattern: 'x', glob: '/etc/*'}],
			['Grep', {pattern: 'x', glob: '../*'}],
			['Glob', {pattern: '/etc/*'}],
			['Glob', {pattern: '../*'}],
			['Glob', {pattern: '*', path: outside}],
		] as const) {
			assert.deepEqual(await run(name, input), {
				behavior: 'deny',
				message: 'Access to that path is not allowed.',
			}, `${name} ${JSON.stringify(input)}`);
		}
	});

	it('denies every other tool', async () => {
		for (const name of ['Bash', 'Edit', 'Write', 'WebFetch', 'Agent', 'mcp__x']) {
			assert.deepEqual(await run(name, {}), {
				behavior: 'deny',
				message: `Tool "${name}" is not available in "claude ask" (read-only mode).`,
			});
		}
	});
});

describe('static policy', () => {
	it('offers no Bash or writers', () => {
		assert.deepEqual(ALLOWED_TOOLS, ['Read', 'Glob', 'Grep']);
		for (const t of ['Bash', 'Edit', 'Write', 'WebFetch', 'Agent', 'mcp__*']) {
			assert.ok(DISALLOWED_TOOLS.includes(t), t);
		}
	});

	it('disables hooks and denies secret reads', () => {
		const s = buildAskSettings(paths);
		assert.equal(s.disableAllHooks, true);
		for (const rule of GUARD_DENY) assert.ok(s.permissions.deny.includes(rule));
		assert.ok(s.permissions.deny.includes(`Read(/${paths.tokenFile})`));
		assert.ok(s.permissions.deny.includes('Read(//proc/**)'));
		assert.ok(s.permissions.deny.includes('Read(**/.env*)'));
	});
});

describe('ask policy snapshot', () => {
	it('keeps the ask tools, deny list and tool lists unchanged', () => {
		assert.deepEqual(ALLOWED_TOOLS, ['Read', 'Glob', 'Grep']);
		assert.deepEqual(DISALLOWED_TOOLS, [
			'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
			'Agent', 'Task', 'Skill', 'SlashCommand', 'TodoWrite', 'ExitPlanMode', 'mcp__*',
		]);
		assert.deepEqual(buildAskSettings(paths), {
			permissions: {
				deny: [
					'Edit(./CLAUDE.md)',
					'Edit(./CLAUDE.local.md)',
					'Edit(./.claude/**)',
					`Read(/${paths.tokenFile})`,
					`Read(/${paths.credentialsFile})`,
					`Read(/${paths.stateFile})`,
					'Read(//proc/**)',
					'Read(~/.ssh/**)',
					'Read(**/.env*)',
					'Read(**/*.pem)',
					'Read(**/id_rsa*)',
					'Read(./.yena/**)',
				],
			},
			disableAllHooks: true,
		});
	});

	it('keeps the ask canUseTool scope', async () => {
		assert.deepEqual(scope.roots, [projectDir, paths.mdDir, paths.configDir]);
		assert.equal((await run('Bash', {command: 'ls'})).behavior, 'deny');
		assert.equal((await run('Read', {file_path: path.join(projectDir, 'a.txt')})).behavior, 'allow');
	});
});

describe('chat static policy', () => {
	it('lists the chat tools and disables the rest', () => {
		assert.deepEqual(CHAT_TOOLS, [
			'Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'AskUserQuestion', 'Agent', 'SendMessage', 'Skill', 'TodoWrite', 'WebFetch', 'WebSearch', 'ExitPlanMode',
			'TaskStop', 'TaskGet', 'TaskList', 'TaskOutput', 'BashOutput', 'KillShell',
		]);
		for (const t of ['NotebookEdit', 'EnterPlanMode', 'Monitor', 'ToolSearch']) {
			assert.ok(CHAT_DISALLOWED_TOOLS.includes(t), t);
		}
		for (const t of CHAT_TOOLS) assert.ok(!CHAT_DISALLOWED_TOOLS.includes(t), t);
	});

	it('extends the ask deny list with Edit denies', () => {
		const s = buildChatSettings(paths);
		assert.equal(s.disableAllHooks, true);
		assert.ok(!('ask' in s.permissions));
		assert.deepEqual(s.permissions.allow, [`Edit(/${paths.mdDir}/**)`]);
		const hubbed = buildChatSettings({...paths, hubDir: '/data/md'}).permissions;
		assert.deepEqual(hubbed.allow, ['Edit(//data/md/**)']);
		// Claude Code resolves symlinks in rule paths: no deny rule may name the md link or the linked config folders.
		for (const rule of hubbed.deny) {
			assert.ok(!rule.startsWith(`Edit(/${paths.mdDir}`), rule);
			for (const d of ['agents', 'skills', 'commands', 'output-styles']) {
				assert.ok(!rule.startsWith(`Edit(/${paths.configDir}/${d}`), rule);
			}
		}
		for (const rule of buildAskSettings(paths).permissions.deny) assert.ok(s.permissions.deny.includes(rule), rule);
		for (const rule of GUARD_DENY) assert.ok(s.permissions.deny.includes(rule));
		for (const rule of [
			`Edit(/${paths.tokenFile})`,
			`Edit(/${paths.credentialsFile})`,
			`Edit(/${paths.stateFile})`,
			`Edit(/${paths.configDir}/settings.json)`.replace('settings.json', '*.json'),
			`Edit(/${paths.configDir}/projects/**)`,
			'Edit(//proc/**)',
			'Edit(~/.ssh/**)',
			'Edit(**/.env*)',
			'Edit(**/*.pem)',
			'Edit(**/id_rsa*)',
			'Edit(./.yena/**)',
		]) {
			assert.ok(s.permissions.deny.includes(rule), rule);
		}
	});
});

describe('locked data dir', () => {
	const hub = path.join(tmp, 'hub');
	const lpaths = {...paths, hubDir: hub, dataDir};
	mkdirSync(path.join(hub, 'agents'), {recursive: true});
	mkdirSync(path.join(paths.configDir, 'plans'), {recursive: true});
	const lscope = buildScope(lpaths, home);
	const cls = (p: string) => classifyEditTarget(p, lscope);

	it('refuses every write into the data dir, the md link included, except plans', async () => {
		for (const f of ['new.txt', 'exports/x.md', 'state.json', 'config/settings.json', 'config/agents/x.md', 'md/CLAUDE.md']) {
			assert.equal(await cls(path.join(dataDir, f)), 'deny-locked', f);
		}
		assert.equal(await cls(path.join(paths.configDir, 'plans', 'p.md')), 'prompt-only');
	});

	it('leaves the hub free at its own path', async () => {
		assert.equal(await cls(path.join(hub, 'CLAUDE.md')), 'free');
		assert.equal(await cls(path.join(hub, 'agents', 'new', 'x.md')), 'free');
	});
});

describe('isGuardedPath', () => {
	it('guards CLAUDE.md, CLAUDE.local.md and .claude/**', () => {
		for (const f of ['CLAUDE.md', 'CLAUDE.local.md', '.claude', '.claude/x', '.claude/a/b']) {
			assert.ok(isGuardedPath(path.join(projectDir, f), projectDir), f);
		}
		for (const f of ['a.txt', 'sub/CLAUDE.md', '.claudex/y']) {
			assert.ok(!isGuardedPath(path.join(projectDir, f), projectDir), f);
		}
		assert.ok(!isGuardedPath('/elsewhere/CLAUDE.md', projectDir));
	});
});

describe('classifyEditTarget', () => {
	const cscope = {roots: [projectDir, paths.mdDir], denied: scope.denied, free: [paths.mdDir]};
	const cls = (p: string) => classifyEditTarget(p, cscope);
	const f = (rel: string) => path.join(projectDir, rel);
	writeFileSync(f('CLAUDE.md'), 'c');
	mkdirSync(f('.claude'), {recursive: true});
	symlinkSync(f('CLAUDE.md'), f('innocent.md'));

	it('denies outside paths and symlink escapes', async () => {
		assert.equal(await cls('/etc/passwd'), 'deny-outside');
		assert.equal(await cls('../outside/x.txt'), 'deny-outside');
		assert.equal(await cls(f('link/x.txt')), 'deny-outside');
	});

	it('denies guarded paths including through a symlink', async () => {
		assert.equal(await cls(f('CLAUDE.md')), 'deny-guard');
		assert.equal(await cls(f('.claude/x')), 'deny-guard');
		assert.equal(await cls(f('innocent.md')), 'deny-guard');
	});

	it('denies secrets', async () => {
		assert.equal(await cls(f('.env')), 'deny-secret');
		assert.equal(await cls(f('k.pem')), 'deny-secret');
		assert.equal(await cls(paths.tokenFile), 'deny-secret');
		assert.equal(await cls(f('.yena/other')), 'deny-secret');
	});

	it('leaves the md dir free, including new files and folders', async () => {
		assert.equal(await cls(path.join(paths.mdDir, 'CLAUDE.md')), 'free');
		assert.equal(await cls(path.join(paths.mdDir, 'agents', 'new', 'x.md')), 'free');
		assert.equal(await cls(path.join(paths.mdDir, '.env')), 'deny-secret');
	});

	it('prompts only for sensitive project files', async () => {
		for (const rel of [
			'.git/config', '.github/w.yml', '.vscode/s.json', 'Makefile', 'yena', 'Dockerfile', 'compose.yaml',
			'.dockerignore', 'package.json', 'package-lock.json', 'scripts/x.sh', 'modules/claude/bin/claude',
			'modules/claude/yena.json', 'yena-modules.json', 'modules/claude/src/a.ts',
		]) {
			assert.equal(await cls(f(rel)), 'prompt-only', rel);
		}
	});

	it('auto-accepts ordinary project files', async () => {
		for (const rel of ['a.txt', 'new/dir/file.ts', 'src/package.json', 'src/yena', 'modules/claude/tests/a.ts', 'modules/other/src/a.ts']) {
			assert.equal(await cls(f(rel)), 'auto-eligible', rel);
		}
		assert.equal(await cls('a.txt'), 'auto-eligible');
	});

	it('rejects malformed paths', async () => {
		assert.equal(await cls(''), 'deny-outside');
		assert.equal(await cls('a\0b'), 'deny-outside');
	});
});
