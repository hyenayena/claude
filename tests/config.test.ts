import assert from 'node:assert/strict';
import {chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
	buildChatHint,
	buildChatOptions,
	buildEnv,
	buildHint,
	buildOptions,
	cliEnv,
	ensureMdLinks,
	restrictDataDirs,
	GUARD_DENY,
	resolvePaths,
	runtimeInfo,
	scrubChatEnv,
	soulSection,
} from '../src/config.js';
import {buildChatSettings, CHAT_DISALLOWED_TOOLS, CHAT_TOOLS} from '../src/policy.js';
import type {Credential} from '../src/types.js';

const SECRET = 'sk-ant-oat-TESTVALUE0123456789abcdef';
const oauth: Credential = {kind: 'oauth', source: 'env', value: SECRET};
const apiKey: Credential = {kind: 'api-key', source: 'env', value: 'sk-ant-api-TESTVALUE0123456789abcdef'};

const tmp = mkdtempSync(path.join(tmpdir(), 'claude-config-'));
after(() => rmSync(tmp, {recursive: true, force: true}));

function fakeModule(withBin: boolean): string {
	const dir = mkdtempSync(path.join(tmp, 'mod-'));
	if (withBin) {
		const bin = path.join(dir, '.runtime', 'node_modules', '.bin');
		mkdirSync(bin, {recursive: true});
		writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
		chmodSync(path.join(bin, 'claude'), 0o755);
	}
	return dir;
}

describe('resolvePaths', () => {
	it('derives all paths from the module and data dirs', () => {
		const p = resolvePaths('/data/claude', '/app/modules/claude');
		assert.equal(p.projectDir, '/app');
		assert.equal(p.mdDir, '/data/claude/md');
		assert.equal(p.hubDir, '/data/md');
		assert.equal(p.configDir, '/data/claude/config');
		assert.equal(p.runtimeBin, '/app/modules/claude/.runtime/node_modules/.bin/claude');
		assert.ok(!('tokenFile' in p));
		assert.equal(p.stateFile, '/data/claude/state.json');
		assert.equal(p.credentialsFile, '/data/claude/credentials.json');
	});

	it('defaults the module dir to the real one', () => {
		const here = path.dirname(fileURLToPath(import.meta.url));
		assert.equal(resolvePaths('/d').moduleDir, path.resolve(here, '..'));
	});
});

describe('buildEnv', () => {
	const paths = resolvePaths('/data/claude', '/app/modules/claude');

	it('keeps unrelated variables and sets the fixed ones', () => {
		const env = buildEnv({FOO: 'bar', PATH: ''}, paths, oauth);
		assert.equal(env.FOO, 'bar');
		assert.equal(env.CLAUDE_CONFIG_DIR, '/data/claude/config');
		assert.equal(env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD, '1');
		assert.equal(env.DISABLE_AUTOUPDATER, '1');
		assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
	});

	it('sets USE_BUILTIN_RIPGREP only when rg is on PATH', () => {
		const dir = mkdtempSync(path.join(tmp, 'path-'));
		assert.equal(buildEnv({PATH: dir}, paths, oauth).USE_BUILTIN_RIPGREP, undefined);
		writeFileSync(path.join(dir, 'rg'), '');
		chmodSync(path.join(dir, 'rg'), 0o755);
		assert.equal(buildEnv({PATH: dir}, paths, oauth).USE_BUILTIN_RIPGREP, '0');
	});

	it('lets an api-key credential replace an inherited oauth token', () => {
		const env = buildEnv(
			{CLAUDE_CODE_OAUTH_TOKEN: 'other', ANTHROPIC_AUTH_TOKEN: 'x'},
			paths,
			apiKey,
		);
		assert.equal(env.ANTHROPIC_API_KEY, apiKey.value);
		assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env));
		assert.ok(!('ANTHROPIC_AUTH_TOKEN' in env));
	});

	it('lets an oauth credential replace an inherited api key', () => {
		const env = buildEnv({ANTHROPIC_API_KEY: 'other', CLAUDE_CODE_OAUTH_TOKEN: 'old'}, paths, oauth);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, SECRET);
		assert.ok(!('ANTHROPIC_API_KEY' in env));
	});

	it('does not mutate the base env', () => {
		const base = {ANTHROPIC_API_KEY: 'other'};
		buildEnv(base, paths, oauth);
		assert.deepEqual(base, {ANTHROPIC_API_KEY: 'other'});
	});
});

describe('buildOptions', () => {
	const mod = fakeModule(true);
	const paths = resolvePaths('/data/claude', mod);
	const base = {paths, cred: oauth, abortController: new AbortController(), env: {X: '1'}};

	it('sets cwd, directories and setting sources', () => {
		const o = buildOptions(base);
		assert.equal(o.cwd, paths.projectDir);
		assert.deepEqual(o.additionalDirectories, [paths.hubDir, paths.configDir]);
		assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
		assert.equal(o.permissionMode, 'default');
		assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep']);
		assert.equal(o.strictMcpConfig, true);
		assert.deepEqual(o.mcpServers, {});
		assert.equal(typeof o.canUseTool, 'function');
		assert.equal(typeof o.maxTurns, 'number');
	});

	it('uses the runtime binary only when present', () => {
		assert.equal(buildOptions(base).pathToClaudeCodeExecutable, paths.runtimeBin);
		const none = resolvePaths('/data/claude', fakeModule(false));
		assert.equal(buildOptions({...base, paths: none}).pathToClaudeCodeExecutable, undefined);
	});

	it('passes resume only when given', () => {
		assert.ok(!('resume' in buildOptions(base)));
		assert.equal(buildOptions({...base, resume: 'abc'}).resume, 'abc');
	});

	it('never bypasses permissions and sets no model', () => {
		const o = buildOptions(base);
		const json = JSON.stringify({...o, env: undefined});
		assert.ok(!json.includes('bypassPermissions'));
		assert.ok(!('allowDangerouslySkipPermissions' in o));
		assert.ok(!('model' in o));
	});

	it('passes a chosen model through', () => {
		assert.equal(buildOptions({...base, model: 'opus'}).model, 'opus');
	});

	it('contains no secret outside env', () => {
		const o = buildOptions({...base, env: undefined});
		const {env, ...rest} = o;
		const json = JSON.stringify(rest);
		assert.ok(!json.includes(SECRET));
		assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, SECRET);
	});

	it('hardens settings', () => {
		const s = buildOptions(base).settings as {disableAllHooks: boolean; permissions: {deny: string[]}};
		assert.equal(s.disableAllHooks, true);
		for (const rule of GUARD_DENY) assert.ok(s.permissions.deny.includes(rule));
	});
});

describe('scrubChatEnv', () => {
	const env = {
		PATH: '/bin',
		HOME: '/root',
		SSH_AUTH_SOCK: '/s',
		SSH_AGENT_PID: '1',
		GITHUB_TOKEN: 'g',
		AWS_SECRET_ACCESS_KEY: 'a',
		DB_PASSWORD: 'p',
		MY_api_key: 'k',
		GOOGLE_CREDENTIALS: 'c',
	};

	it('removes agent sockets and token-like variables', () => {
		assert.deepEqual(scrubChatEnv(env), {PATH: '/bin', HOME: '/root'});
	});

	it('name-based deny-list drops secret-like names (residual risk: secrets under unexpected names)', () => {
		const bad = [
			'PRIVATE_KEY', 'DATABASE_URL', 'COOKIE', 'AUTH_HEADER', 'SOMEPWD', 'DB_PWD', 'REDIS_URI',
			'SENTRY_DSN', 'AZURE_CONNECTION_STRING', 'SIGNING_KEY', 'STRIPE_ACCESS_KEY', 'SESSION_COOKIE',
			'AWS_ACCESS_KEY_ID', 'OPENAI_API_KEY', 'NPM_TOKEN',
		];
		const out = scrubChatEnv(Object.fromEntries(bad.map(n => [n, 'x'])));
		assert.deepEqual(out, {});
	});

	it('name/value heuristic drops more secret-like names (residual risk remains)', () => {
		const bad = ['STRIPE_SK', 'DEPLOY_KEY', 'MY_DEPLOY_KEY', 'SLACK_WEBHOOK_URL', 'ENCRYPTION_KEY', 'MASTER_KEY', 'SESSION_KEY', 'SESSION_SECRET', 'BEARER_VALUE', 'CLIENT_SECRET'];
		assert.deepEqual(scrubChatEnv(Object.fromEntries(bad.map(n => [n, 'x']))), {});
	});

	it('value heuristic drops URLs with userinfo under any name, keeps credential-free URLs', () => {
		const out = scrubChatEnv({
			REDIS_URL: 'redis://:pw@h:6379',
			MONGO_URL: 'mongodb://u:p@h/db',
			FOO: 'postgres://u:p@h/db',
			HTTPS_PROXY: 'http://u:p@proxy.local:3128',
			ALL_PROXY: 'http://user@proxy.local:3128',
			NO_AT: 'http://proxy.local:3128',
			API_BASE: 'https://example.com/x',
			EMAIL_LIKE: 'mail me at a@b.c',
			PATH_AT: 'https://example.com/a@b',
		});
		assert.deepEqual(Object.keys(out).sort(), ['API_BASE', 'EMAIL_LIKE', 'NO_AT', 'PATH_AT']);
		assert.equal(scrubChatEnv({HTTPS_PROXY: 'http://proxy.local:3128'}).HTTPS_PROXY, 'http://proxy.local:3128');
	});

	it('value scan is linear on a 1 MiB value and ignores bytes after 8 KiB', () => {
		const big = 'a://'.repeat(262144);
		const start = performance.now();
		const out = scrubChatEnv({BIG: big, LATE: 'x'.repeat(9000) + 'http://u:p@h/'});
		assert.ok(performance.now() - start < 100);
		assert.deepEqual(Object.keys(out).sort(), ['BIG', 'LATE']);
	});

	it('keeps the credential by value even when it looks like userinfo', () => {
		const cred = 'https://u:p@h/';
		assert.equal(scrubChatEnv({X: cred}, ['X']).X, cred);
	});

	it('standard harmless names survive the deny-list', () => {
		const good = [
			'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TERM', 'COLORTERM', 'LANG',
			'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'NO_COLOR', 'FORCE_COLOR',
			'HOSTNAME', 'NODE_ENV', 'EDITOR', 'PAGER', 'SHLVL', '_', 'CUSTOM_FLAG',
		];
		const input = Object.fromEntries(good.map(n => [n, 'v']));
		assert.deepEqual(scrubChatEnv(input), input);
	});

	it('keeps listed names', () => {
		assert.equal(scrubChatEnv(env, ['GITHUB_TOKEN']).GITHUB_TOKEN, 'g');
	});
});

describe('buildChatHint', () => {
	it('extends buildHint', () => {
		const paths = resolvePaths('/data/claude', fakeModule(false));
		const hint = buildChatHint(paths);
		assert.ok(hint.startsWith(buildHint(paths)));
		assert.ok(hint.includes('need the user\'s approval'));
	});
});

describe('buildChatOptions', () => {
	const mod = fakeModule(true);
	const paths = resolvePaths('/data/claude', mod);
	const canUseTool = (async () => ({behavior: 'deny', message: 'x'})) as never;
	const base = {paths, cred: oauth, abortController: new AbortController(), canUseTool};
	const dirty = {
		PATH: '/bin',
		HOME: '/root',
		SSH_AUTH_SOCK: '/s',
		GITHUB_TOKEN: 'g',
		AWS_SECRET_ACCESS_KEY: 'a',
		AWS_ACCESS_KEY_ID: 'i',
	};

	it('sets chat tools, mode and policy', () => {
		const o = buildChatOptions(base);
		assert.deepEqual(o.tools, CHAT_TOOLS);
		assert.deepEqual(o.disallowedTools, CHAT_DISALLOWED_TOOLS);
		assert.equal(o.permissionMode, 'default');
		assert.equal(o.canUseTool, canUseTool);
		assert.ok(!('allowedTools' in o));
		assert.ok(!('allowDangerouslySkipPermissions' in o));
		assert.ok(!JSON.stringify({...o, env: undefined}).includes('bypassPermissions'));
		assert.deepEqual(o.settings, buildChatSettings(paths));
		assert.equal((o.settings as {disableAllHooks: boolean}).disableAllHooks, true);
		const sp = o.systemPrompt as {append: string};
		assert.equal(sp.append, buildChatHint(paths) + soulSection(paths));
	});

	it('reuses the ask options for the rest', () => {
		const a = buildOptions({...base, canUseTool: undefined} as never);
		const o = buildChatOptions(base);
		for (const k of ['cwd', 'additionalDirectories', 'settingSources', 'pathToClaudeCodeExecutable'] as const) {
			assert.deepEqual(o[k], a[k], k);
		}
		// Only the one-shot ask has a turn limit.
		assert.equal(typeof a.maxTurns, 'number');
		assert.ok(!('maxTurns' in o));
		// The chat loads MCP servers from the Claude Code config; ask never does.
		assert.equal(a.strictMcpConfig, true);
		assert.equal(o.strictMcpConfig, false);
		assert.deepEqual(o.mcpServers, {});
		const off = buildChatOptions({...base, tuning: {noMcp: true}});
		assert.equal(off.strictMcpConfig, true);
		assert.deepEqual(off.mcpServers, {});
		const server = {type: 'sdk', name: 'yena', instance: {}} as never;
		const on = buildChatOptions({...base, consoleServer: server});
		assert.equal(on.strictMcpConfig, false);
		assert.equal(on.mcpServers?.['yena'], server);
		const offWith = buildChatOptions({...base, tuning: {noMcp: true}, consoleServer: server});
		assert.equal(offWith.strictMcpConfig, true);
		assert.deepEqual(Object.keys(offWith.mcpServers ?? {}), ['yena']);
		const hooks = buildChatOptions({...base, tuning: {hooks: true}}).settings as {disableAllHooks: boolean};
		assert.equal(hooks.disableAllHooks, false);
		assert.equal((o.settings as {disableAllHooks: boolean}).disableAllHooks, true);
	});

	it('omits subprocess env scrub because it requires bubblewrap which the container lacks', () => {
		assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in buildChatOptions(base).env!));
	});

	it('scrubs the env but keeps the credential for the CLI', () => {
		const o = buildChatOptions({...base, env: undefined, cred: oauth});
		assert.equal(o.env?.CLAUDE_CODE_OAUTH_TOKEN, SECRET);
		const k = buildChatOptions({...base, env: undefined, cred: apiKey});
		assert.equal(k.env?.ANTHROPIC_API_KEY, apiKey.value);
		assert.equal(k.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
		const e = buildChatOptions({...base, cred: apiKey, env: buildEnv(dirty, paths, apiKey)}).env!;
		assert.equal(e.ANTHROPIC_API_KEY, apiKey.value);
		for (const n of ['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID']) {
			assert.ok(!(n in e), n);
		}
		assert.equal(e.PATH, '/bin');
		assert.equal(e.HOME, '/root');
		assert.equal('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS' in e, false, 'background tasks are allowed in the chat');
		assert.ok(!('CLAUDE_CODE_SUBPROCESS_ENV_SCRUB' in e));
	});

	it('passes resume only when given', () => {
		assert.ok(!('resume' in buildChatOptions(base)));
		assert.equal(buildChatOptions({...base, resume: 'abc'}).resume, 'abc');
	});
});

describe('runtimeInfo', () => {
	it('reports a bundled binary when the runtime is missing', () => {
		const info = runtimeInfo(resolvePaths('/d', fakeModule(false)));
		assert.equal(info.binary, 'bundled');
		assert.equal(info.cli, undefined);
	});

	it('reads versions', () => {
		const mod = fakeModule(true);
		const cc = path.join(mod, '.runtime', 'node_modules', '@anthropic-ai', 'claude-code');
		mkdirSync(cc, {recursive: true});
		writeFileSync(path.join(cc, 'package.json'), '{"version":"1.2.3"}');
		writeFileSync(
			path.join(mod, 'package.json'),
			'{"dependencies":{"@anthropic-ai/claude-agent-sdk":"0.3.302"}}',
		);
		assert.deepEqual(runtimeInfo(resolvePaths('/d', mod)), {cli: '1.2.3', sdk: '0.3.302', binary: 'runtime'});
	});
});

describe('bin/claude parity', () => {
	const paths = resolvePaths('/data/claude');
	const script = readFileSync(path.join(paths.moduleDir, 'bin', 'claude'), 'utf8');

	it('GUARD matches GUARD_DENY', () => {
		const m = script.match(/^GUARD='(.*)'$/m);
		assert.ok(m);
		assert.deepEqual(JSON.parse(m[1] as string), {permissions: {deny: GUARD_DENY}});
	});

	it('HINT matches buildHint', () => {
		const m = script.match(/^HINT="((?:[^"\\]|\\[\s\S])*)"$/m);
		assert.ok(m);
		const text = (m[1] as string)
			.replace(/\\\n/g, '')
			.replaceAll('$DATA_DIR', paths.dataDir)
			.replaceAll('$HUB_DIR', paths.hubDir)
			.replaceAll('$CLAUDE_DIR', paths.configDir)
			.replaceAll('$PROJECT_DIR', paths.projectDir);
		assert.equal(text, buildHint(paths));
	});
});

describe('ensureMdLinks', () => {
	const setup = () => {
		const data = mkdtempSync(path.join(tmp, 'data-'));
		const claude = path.join(data, 'claude');
		return {data, paths: {hubDir: path.join(data, 'md'), mdDir: path.join(claude, 'md'), configDir: path.join(claude, 'config')}};
	};

	it('creates the hub and links the md dir and the config folders to it', () => {
		const {paths} = setup();
		ensureMdLinks(paths);
		assert.equal(readlinkSync(paths.mdDir), path.join('..', 'md'));
		for (const name of ['agents', 'skills']) {
			assert.equal(readlinkSync(path.join(paths.configDir, name)), path.join('..', 'md', name));
			assert.ok(lstatSync(path.join(paths.hubDir, name)).isDirectory());
		}
		writeFileSync(path.join(paths.hubDir, 'agents', 'a.md'), 'x');
		assert.equal(readFileSync(path.join(paths.configDir, 'agents', 'a.md'), 'utf8'), 'x');
		ensureMdLinks(paths);
		assert.equal(readFileSync(path.join(paths.mdDir, 'agents', 'a.md'), 'utf8'), 'x');
	});

	it('moves an old md dir into a blank hub', () => {
		const {paths} = setup();
		mkdirSync(path.join(paths.mdDir, 'skills', 's'), {recursive: true});
		writeFileSync(path.join(paths.mdDir, 'CLAUDE.md'), 'mine');
		mkdirSync(path.join(paths.hubDir, 'agents'), {recursive: true});
		ensureMdLinks(paths);
		assert.ok(lstatSync(paths.mdDir).isSymbolicLink());
		assert.equal(readFileSync(path.join(paths.hubDir, 'CLAUDE.md'), 'utf8'), 'mine');
		assert.ok(lstatSync(path.join(paths.hubDir, 'skills', 's')).isDirectory());
		assert.ok(lstatSync(path.join(paths.hubDir, 'agents')).isDirectory());
	});

	it('leaves an old md dir alone when the hub already has content', () => {
		const {paths} = setup();
		mkdirSync(paths.mdDir, {recursive: true});
		writeFileSync(path.join(paths.mdDir, 'CLAUDE.md'), 'old');
		mkdirSync(paths.hubDir, {recursive: true});
		writeFileSync(path.join(paths.hubDir, 'CLAUDE.md'), 'hub');
		ensureMdLinks(paths);
		assert.ok(!lstatSync(paths.mdDir).isSymbolicLink());
		assert.equal(readFileSync(path.join(paths.mdDir, 'CLAUDE.md'), 'utf8'), 'old');
		assert.equal(readFileSync(path.join(paths.hubDir, 'CLAUDE.md'), 'utf8'), 'hub');
		assert.equal(readlinkSync(path.join(paths.configDir, 'agents')), path.join('..', 'md', 'agents'));
	});

	it('links commands and output-styles too', () => {
		const {paths} = setup();
		ensureMdLinks(paths);
		for (const name of ['commands', 'output-styles']) {
			assert.equal(readlinkSync(path.join(paths.configDir, name)), path.join('..', 'md', name));
		}
	});

	it('moves a real config folder into the hub when the hub folder is empty', () => {
		const {paths} = setup();
		mkdirSync(path.join(paths.configDir, 'commands'), {recursive: true});
		writeFileSync(path.join(paths.configDir, 'commands', 'pipeline.md'), 'p');
		ensureMdLinks(paths);
		assert.ok(lstatSync(path.join(paths.configDir, 'commands')).isSymbolicLink());
		assert.equal(readFileSync(path.join(paths.hubDir, 'commands', 'pipeline.md'), 'utf8'), 'p');
	});

	it('leaves a real config folder alone when the hub folder has content', () => {
		const {paths} = setup();
		mkdirSync(path.join(paths.configDir, 'skills'), {recursive: true});
		writeFileSync(path.join(paths.configDir, 'skills', 'mine'), 'c');
		mkdirSync(path.join(paths.hubDir, 'skills'), {recursive: true});
		writeFileSync(path.join(paths.hubDir, 'skills', 'hub'), 'h');
		ensureMdLinks(paths);
		assert.ok(!lstatSync(path.join(paths.configDir, 'skills')).isSymbolicLink());
		assert.equal(readFileSync(path.join(paths.configDir, 'skills', 'mine'), 'utf8'), 'c');
		assert.ok(lstatSync(path.join(paths.configDir, 'agents')).isSymbolicLink());
	});
});

describe('claude login environment', () => {
	const paths = resolvePaths('/data/claude', '/app/modules/claude');
	const login: Credential = {kind: 'oauth', source: 'claude-login', value: ''};
	const consoleLogin: Credential = {kind: 'api-key', source: 'claude-login', value: ''};
	const base = {PATH: '/bin', ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: ' ', ANTHROPIC_AUTH_TOKEN: 'y'};

	it('loginFile lives in the config dir', () => {
		assert.equal(paths.loginFile, '/data/claude/config/.credentials.json');
	});

	it('buildEnv strips all credential variables for a login', () => {
		for (const cred of [login, consoleLogin]) {
			const env = buildEnv(base, paths, cred);
			for (const n of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(env[n], undefined, n);
			assert.equal(env.CLAUDE_CONFIG_DIR, paths.configDir);
		}
	});

	it('buildChatOptions env has no credential variables for a login', () => {
		const env = buildChatOptions({
			paths,
			cred: login,
			abortController: new AbortController(),
			canUseTool: async () => ({behavior: 'deny', message: 'n'}),
			env: buildEnv(base, paths, login),
		}).env!;
		for (const n of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) assert.ok(!(n in env), n);
	});

	it('cliEnv scrubs secrets and pins the config dir', () => {
		const env = cliEnv({...base, HOME: '/root', GITHUB_TOKEN: 'g'}, paths);
		assert.deepEqual(env, {PATH: '/bin', HOME: '/root', CLAUDE_CONFIG_DIR: paths.configDir, DISABLE_AUTOUPDATER: '1'});
	});
});

describe('soulSection', () => {
	it('carries SOUL.md from the md dir, trimmed and capped; nothing when it is missing or empty', () => {
		const mdDir = mkdtempSync(path.join(tmp, 'md-'));
		assert.equal(soulSection({mdDir}), '');
		writeFileSync(path.join(mdDir, 'SOUL.md'), '  \n');
		assert.equal(soulSection({mdDir}), '');
		writeFileSync(path.join(mdDir, 'SOUL.md'), '# SOUL\nWarm and brief.\n');
		const s = soulSection({mdDir});
		assert.ok(s.includes('do not read it again'));
		assert.ok(s.endsWith('# SOUL\nWarm and brief.'));
		writeFileSync(path.join(mdDir, 'SOUL.md'), 'x'.repeat(40_000));
		assert.ok(soulSection({mdDir}).length < 17_000);
	});
});

describe('restrictDataDirs', () => {
	it('closes the data and config dirs to other users, leaves symlinks and missing dirs alone', () => {
		const root = mkdtempSync(path.join(tmpdir(), 'claude-perm-'));
		try {
			const dataDir = path.join(root, 'claude');
			const configDir = path.join(dataDir, 'config');
			mkdirSync(configDir, {recursive: true});
			chmodSync(dataDir, 0o755);
			chmodSync(configDir, 0o775);
			const target = path.join(root, 'shared');
			mkdirSync(target, {mode: 0o755});
			chmodSync(target, 0o755);
			restrictDataDirs({dataDir, configDir});
			assert.equal(lstatSync(dataDir).mode & 0o777, 0o700);
			assert.equal(lstatSync(configDir).mode & 0o777, 0o700);
			const linked = path.join(root, 'linked');
			symlinkSync(target, linked);
			restrictDataDirs({dataDir: linked, configDir: path.join(root, 'missing')});
			assert.equal(lstatSync(target).mode & 0o777, 0o755);
		} finally {
			rmSync(root, {recursive: true, force: true});
		}
	});
});
