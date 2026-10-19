import {accessSync, constants, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {CanUseTool, Options} from '@anthropic-ai/claude-agent-sdk';
import {
	ALLOWED_TOOLS,
	buildAskSettings,
	buildChatSettings,
	buildScope,
	CHAT_DISALLOWED_TOOLS,
	CHAT_TOOLS,
	createCanUseTool,
	DISALLOWED_TOOLS,
	GUARD_DENY,
	MAX_TURNS,
} from './policy.js';
import type {Credential} from './types.js';

export {GUARD_DENY};

export type ClaudePaths = {
	moduleDir: string;
	projectDir: string;
	dataDir: string;
	mdDir: string;
	configDir: string;
	runtimeBin: string;
	tokenFile: string;
	stateFile: string;
	credentialsFile: string;
};

export type RuntimeInfo = {
	cli?: string;
	sdk: string;
	binary: 'runtime' | 'bundled';
};

export function resolvePaths(dataDir: string, moduleDir?: string): ClaudePaths {
	const mod = moduleDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	return {
		moduleDir: mod,
		projectDir: path.resolve(mod, '..', '..'),
		dataDir,
		mdDir: path.join(dataDir, 'md'),
		configDir: path.join(dataDir, 'config'),
		runtimeBin: path.join(mod, '.runtime', 'node_modules', '.bin', 'claude'),
		tokenFile: path.join(dataDir, '.token'),
		stateFile: path.join(dataDir, 'state.json'),
		credentialsFile: path.join(dataDir, 'credentials.json'),
	};
}

function isExecutable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function onPath(name: string, envPath: string | undefined): boolean {
	return (envPath ?? '')
		.split(path.delimiter)
		.some(dir => dir !== '' && isExecutable(path.join(dir, name)));
}

export function buildEnv(
	base: NodeJS.ProcessEnv,
	paths: ClaudePaths,
	cred: Credential,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {...base};
	env.CLAUDE_CONFIG_DIR = paths.configDir;
	env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
	env.DISABLE_AUTOUPDATER = '1';
	if (onPath('rg', base.PATH)) {
		env.USE_BUILTIN_RIPGREP = '0';
	}
	delete env.ANTHROPIC_AUTH_TOKEN;
	if (cred.kind === 'api-key') {
		env.ANTHROPIC_API_KEY = cred.value;
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
	} else {
		env.CLAUDE_CODE_OAUTH_TOKEN = cred.value;
		delete env.ANTHROPIC_API_KEY;
	}
	return env;
}

// Must stay identical to HINT in bin/claude (a test compares them).
export function buildHint(paths: ClaudePaths): string {
	return (
		`This project's Claude files live outside the project, in ${paths.dataDir}: ` +
		`instructions (CLAUDE.md, SOUL.md) in ${paths.mdDir} (use ${paths.mdDir}/CLAUDE.md wherever you would use ./CLAUDE.md, e.g. for /init or remembering things) ` +
		`and Claude config (settings, agents, commands, skills) in ${paths.configDir} (instead of ./.claude). ` +
		`Never create CLAUDE.md, CLAUDE.local.md or .claude/ inside ${paths.projectDir}.`
	);
}

export function buildOptions(p: {
	paths: ClaudePaths;
	cred: Credential;
	abortController: AbortController;
	resume?: string;
	model?: string;
	env?: Record<string, string | undefined>;
	runtimeBin?: string;
}): Options {
	const {paths} = p;
	const runtimeBin = p.runtimeBin ?? paths.runtimeBin;
	const options: Options = {
		cwd: paths.projectDir,
		env: p.env ?? buildEnv(process.env, paths, p.cred),
		additionalDirectories: [paths.mdDir, paths.configDir],
		settingSources: ['user', 'project', 'local'],
		abortController: p.abortController,
		systemPrompt: {type: 'preset', preset: 'claude_code', append: buildHint(paths)},
		settings: buildAskSettings(paths),
		tools: [...ALLOWED_TOOLS],
		disallowedTools: [...DISALLOWED_TOOLS],
		permissionMode: 'default',
		canUseTool: createCanUseTool(buildScope(paths)),
		strictMcpConfig: true,
		mcpServers: {},
		maxTurns: MAX_TURNS,
	};
	if (isExecutable(runtimeBin)) {
		options.pathToClaudeCodeExecutable = runtimeBin;
	}
	if (p.resume !== undefined) {
		options.resume = p.resume;
	}
	if (p.model !== undefined) {
		options.model = p.model;
	}
	return options;
}

const SECRET_ENV_NAMES = [
	/^AWS_|TOKEN|SECRET|PASSW|API_?KEY|CREDENTIAL/i,
	/PRIVATE|COOKIE|AUTH/i,
	/.PWD$/i,
	/^DATABASE_URL$|_DSN$|_URI$|_CONNECTION_STRING$/i,
	/(ACCESS|SIGNING)_?KEY/i,
	/_SK$/i,
	/(^|_)DEPLOY_?KEY/i,
	/WEBHOOK|SIGNING|BEARER/i,
	/ENCRYPTION_?KEY|MASTER_?KEY|SESSION_?(KEY|SECRET)/i,
];

const VALUE_SCAN_MAX = 8192;

// Linear scan for scheme://user[:pass]@ in the first 8 KiB of a value.
function hasUrlUserinfo(value: string): boolean {
	const v = value.length > VALUE_SCAN_MAX ? value.slice(0, VALUE_SCAN_MAX) : value;
	let i = v.indexOf('://');
	while (i !== -1) {
		let j = i + 3;
		while (j < v.length && !/[\s/@?#]/.test(v[j] as string)) j++;
		if (j > i + 3 && v[j] === '@') return true;
		i = v.indexOf('://', i + 3);
	}
	return false;
}

const SAFE_ENV_NAME =
	/^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|COLORTERM|LANG|LANGUAGE|TZ|TMPDIR|TEMP|TMP|NO_COLOR|FORCE_COLOR|HOSTNAME|NODE_ENV|EDITOR|PAGER|SHLVL|_)$|^LC_/;

// keep lists names exempt from the deny-list (the credential injected for the CLI).
export function scrubChatEnv(
	env: Record<string, string | undefined>,
	keep: readonly string[] = [],
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(env)) {
		if (keep.includes(name) || SAFE_ENV_NAME.test(name)) {
			out[name] = value;
		} else if (
			name === 'SSH_AUTH_SOCK' ||
			name === 'SSH_AGENT_PID' ||
			SECRET_ENV_NAMES.some(re => re.test(name)) ||
			(typeof value === 'string' && hasUrlUserinfo(value))
		) {
			continue;
		} else {
			out[name] = value;
		}
	}
	return out;
}

export function buildChatHint(paths: ClaudePaths): string {
	return (
		buildHint(paths) +
		" Tool calls that run commands or change files (Bash, Edit, Write) need the user's approval in this interface." +
		' Bash runs as root in the project directory.' +
		' If the user denies a call, do not retry it or work around the denial; explain what you needed and ask.'
	);
}

export function buildChatOptions(p: {
	paths: ClaudePaths;
	cred: Credential;
	abortController: AbortController;
	canUseTool: CanUseTool;
	resume?: string;
	model?: string;
	env?: Record<string, string | undefined>;
	runtimeBin?: string;
}): Options {
	const {canUseTool, ...rest} = p;
	const base = buildOptions(rest);
	const full = base.env ?? {};
	// The credential is found by value, so no variable names are read here.
	const keep = Object.keys(full).filter(k => full[k] === p.cred.value && p.cred.value !== '');
	return {
		...base,
		env: {
			...scrubChatEnv(full, keep),
			CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
		},
		systemPrompt: {type: 'preset', preset: 'claude_code', append: buildChatHint(p.paths)},
		settings: buildChatSettings(p.paths),
		tools: [...CHAT_TOOLS],
		disallowedTools: [...CHAT_DISALLOWED_TOOLS],
		permissionMode: 'default',
		canUseTool,
	};
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export function runtimeInfo(paths: ClaudePaths): RuntimeInfo {
	const cli = readJson(
		path.join(paths.moduleDir, '.runtime', 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'),
	)?.version;
	const deps = readJson(path.join(paths.moduleDir, 'package.json'))?.dependencies as
		| Record<string, string>
		| undefined;
	return {
		...(typeof cli === 'string' ? {cli} : {}),
		sdk: deps?.['@anthropic-ai/claude-agent-sdk'] ?? 'unknown',
		binary: isExecutable(paths.runtimeBin) ? 'runtime' : 'bundled',
	};
}
