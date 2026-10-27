import {accessSync, chmodSync, constants, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {CanUseTool, McpServerConfig, Options} from '@anthropic-ai/claude-agent-sdk';
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
import {CONSOLE_SERVER_NAME} from './chat/console-tools.js';
import {ensureHub, HUB_DIRS, hubDirFor} from './deps/md.js';
import {loadAccountSecretPaths, type AccountSecretPaths} from './deps/account.js';
import {loadProjectAccess, type ProjectAccessReader} from './deps/project.js';
import {applyTuning, type ChatTuning} from './chat-prefs.js';
import type {Credential} from './types.js';

export {GUARD_DENY};

export type ClaudePaths = {
	moduleDir: string;
	projectDir: string;
	dataDir: string;
	/** The shared md hub of the md module, <YENA_DATA>/md; mdDir links to it. */
	hubDir: string;
	mdDir: string;
	configDir: string;
	runtimeBin: string;
	stateFile: string;
	credentialsFile: string;
	/** Written by Claude Code's own login; only its metadata is ever inspected. */
	loginFile: string;
	/** The project module's access reader, when it is installed (see withProjects). */
	projects?: ProjectAccessReader;
	/** Where the account module keeps secrets, when it is installed (see withProjects). */
	accountSecrets?: AccountSecretPaths;
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
		hubDir: hubDirFor(dataDir),
		mdDir: path.join(dataDir, 'md'),
		configDir: path.join(dataDir, 'config'),
		runtimeBin: path.join(mod, '.runtime', 'node_modules', '.bin', 'claude'),
		stateFile: path.join(dataDir, 'state.json'),
		credentialsFile: path.join(dataDir, 'credentials.json'),
		loginFile: path.join(dataDir, 'config', '.credentials.json'),
	};
}

/**
 * Claude Code config folders kept in the md hub (where Claude may edit them) and linked into the config
 * dir, where Claude Code looks for them. settings and hooks stay in the config dir: they can run code
 * and change permissions.
 */
export const MD_LINKED_DIRS = ['agents', 'skills', 'commands', 'output-styles'] as const;

/**
 * The paths plus what the optional modules tell the policy (loaded at runtime): the project module's
 * access reader and the account module's secret dirs.
 */
export async function withProjects(paths: ClaudePaths): Promise<ClaudePaths> {
	const projects = await loadProjectAccess(paths.dataDir, paths.hubDir);
	const accountSecrets = await loadAccountSecretPaths(paths.dataDir);
	return {...paths, ...(projects && {projects}), ...(accountSecrets && {accountSecrets})};
}

const lexists = (p: string): boolean => {
	try {
		lstatSync(p);
		return true;
	} catch {
		return false;
	}
};

const isEmptyDir = (p: string): boolean => {
	try {
		return readdirSync(p).length === 0;
	} catch {
		return false;
	}
};

/** True when the hub is missing or holds nothing but empty hub folders (as the md module creates them). */
function hubIsBlank(hub: string): boolean {
	if (!lexists(hub)) return true;
	try {
		return readdirSync(hub).every(
			n => (HUB_DIRS as readonly string[]).includes(n) && isEmptyDir(path.join(hub, n)),
		);
	} catch {
		return false;
	}
}

/** Removes a blank hub; rmdir only removes empty folders, so nothing with content can be lost. */
function removeBlankHub(hub: string): void {
	if (!lexists(hub)) return;
	for (const n of readdirSync(hub)) rmdirSync(path.join(hub, n));
	rmdirSync(hub);
}

/**
 * Links Claude's md dir to the shared hub of the md module and the config dir to the hub's folders:
 *   <data>/claude/md           -> ../md        (the hub, <YENA_DATA>/md)
 *   <data>/claude/config/<dir> -> ../md/<dir>  (each of MD_LINKED_DIRS)
 * A real md dir from before the hub is moved into the hub when the hub is blank; otherwise it is left
 * alone (and keeps being used). A real config folder moves into the hub while the hub's folder is empty;
 * otherwise it is left alone.
 * Best effort: errors are ignored, so a chat still starts.
 */
export function ensureMdLinks(paths: Pick<ClaudePaths, 'hubDir' | 'mdDir' | 'configDir'>): void {
	try {
		const md = lstatSync(paths.mdDir, {throwIfNoEntry: false});
		if (md?.isDirectory() && hubIsBlank(paths.hubDir)) {
			removeBlankHub(paths.hubDir);
			renameSync(paths.mdDir, paths.hubDir);
		}
		ensureHub(paths.hubDir);
		if (!lexists(paths.mdDir)) {
			mkdirSync(path.dirname(paths.mdDir), {recursive: true});
			symlinkSync(path.relative(path.dirname(paths.mdDir), paths.hubDir), paths.mdDir, 'dir');
		}
	} catch {}
	for (const name of MD_LINKED_DIRS) {
		try {
			const hubSub = path.join(paths.mdDir, name);
			const link = path.join(paths.configDir, name);
			const own = lstatSync(link, {throwIfNoEntry: false});
			// A real config folder from before the hub moves into it while the hub's folder is empty.
			if (own?.isDirectory() && (!lexists(hubSub) || isEmptyDir(hubSub))) {
				if (lexists(hubSub)) rmdirSync(hubSub);
				renameSync(link, hubSub);
			}
			mkdirSync(hubSub, {recursive: true});
			if (lexists(link)) continue;
			mkdirSync(paths.configDir, {recursive: true});
			symlinkSync(path.relative(paths.configDir, hubSub), link, 'dir');
		} catch {}
	}
}

/**
 * Closes yena's Claude data dir and the Claude Code config dir to other users: transcripts, file
 * history and shell snapshots inside are created world-readable by Claude Code. Only real dirs are
 * changed (never through a symlink); a failed chmod (some bind mounts) is ignored.
 */
export function restrictDataDirs(paths: Pick<ClaudePaths, 'dataDir' | 'configDir'>): void {
	for (const dir of [paths.dataDir, paths.configDir]) {
		try {
			const st = lstatSync(dir, {throwIfNoEntry: false});
			if (st?.isDirectory() && (st.mode & 0o077) !== 0) chmodSync(dir, st.mode & 0o700);
		} catch {}
	}
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
	shellTmp?: string,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {...base};
	env.CLAUDE_CONFIG_DIR = paths.configDir;
	env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
	env.DISABLE_AUTOUPDATER = '1';
	// Turn start and end as Claude Code sees them, including the turns it starts itself.
	env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
	if (onPath('rg', base.PATH)) {
		env.USE_BUILTIN_RIPGREP = '0';
	}
	delete env.ANTHROPIC_AUTH_TOKEN;
	if (shellTmp !== undefined) env.CLAUDE_CODE_TMPDIR = shellTmp;
	if (cred.source === 'claude-login') {
		// The CLI must use its own login, which credentials from the environment would override.
		delete env.ANTHROPIC_API_KEY;
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
	} else if (cred.kind === 'api-key') {
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
		`instructions (CLAUDE.md, SOUL.md), agents and skills in the md hub ${paths.hubDir} (use ${paths.hubDir}/CLAUDE.md wherever you would use ./CLAUDE.md, e.g. for /init or remembering things; edit hub files at this path) ` +
		`and Claude config (settings, agents, commands, skills) in ${paths.configDir} (instead of ./.claude). ` +
		`The hub's CLAUDE.md is loaded into every session from there; never create CLAUDE.md, CLAUDE.local.md or .claude/ inside ${paths.projectDir}.`
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
		additionalDirectories: [paths.hubDir, paths.configDir, ...projectRoots(paths)],
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

/** Environment for Claude Code CLI subprocesses (auth status/login/logout): no credentials from the environment. */
export function cliEnv(
	base: NodeJS.ProcessEnv,
	paths: Pick<ClaudePaths, 'configDir'>,
): Record<string, string | undefined> {
	return {...scrubChatEnv(base), CLAUDE_CONFIG_DIR: paths.configDir, DISABLE_AUTOUPDATER: '1'};
}

/** The workplace and stage dirs, when the project module manages them and they exist. */
function projectRoots(paths: Pick<ClaudePaths, 'projects'>): string[] {
	const access = paths.projects?.readSync();
	return (access?.roots ?? []).filter(dir => lexists(dir));
}

function projectHint(paths: ClaudePaths): string {
	const access = paths.projects?.readSync();
	if (!access || access.roots.length === 0) return '';
	const [workplace, stage] = access.roots as [string, string];
	return (
		` Projects to work on are mounted in ${workplace}/<name>, their docs live in ${access.docs}/<name>, stage copies in ${stage}.` +
		' Every project, its docs and its stages are read-only until the console command "project isolate <name>" makes them writable for the work session;' +
		' "project list" shows them, "project stage make|apply" copies a project for parallel work and moves the changes back, "project finish" ends the session.'
	);
}

export function buildChatHint(paths: ClaudePaths): string {
	return (
		buildHint(paths) +
		projectHint(paths) +
		" Tool calls that run commands or change files (Bash, Edit, Write) need the user's approval in this interface." +
		' Bash runs as root in the project directory.' +
		' If the user denies a call, do not retry it or work around the denial; explain what you needed and ask.' +
		' The tools mcp__yena__list_commands and mcp__yena__run_command inspect and run yena console commands; commands that change state ask the user first.'
	);
}

const SOUL_MAX_BYTES = 16 * 1024;

/**
 * The persona from the md hub's SOUL.md for the main chat. CLAUDE.md's `@SOUL.md` import is skipped in the
 * SDK (a file outside the working directory, no approval dialog), so the model had to Read it in every
 * session; in the system prompt it is cached with the rest. Subagents get their own prompts, without it.
 */
export function soulSection(paths: Pick<ClaudePaths, 'mdDir'>): string {
	let text: string;
	try {
		text = readFileSync(path.join(paths.mdDir, 'SOUL.md'), 'utf8');
	} catch {
		return '';
	}
	if (Buffer.byteLength(text) > SOUL_MAX_BYTES) text = Buffer.from(text).subarray(0, SOUL_MAX_BYTES).toString('utf8');
	text = text.trim();
	return text ? `\n\nPersona and tone (SOUL.md from the md hub, already loaded; do not read it again):\n${text}` : '';
}

export function buildChatOptions(p: {
	paths: ClaudePaths;
	cred: Credential;
	abortController: AbortController;
	canUseTool: CanUseTool;
	// In-process MCP server with yena's console tools; kept even when MCP servers are turned off.
	consoleServer?: McpServerConfig;
	resume?: string;
	model?: string;
	tuning?: ChatTuning;
	env?: Record<string, string | undefined>;
	runtimeBin?: string;
}): Options {
	const {canUseTool, tuning, consoleServer, ...rest} = p;
	// The turn limit is for one-shot asks; a chat turn runs as long as Claude Code needs, as in Claude Code.
	const {maxTurns: _askLimit, ...base} = buildOptions(rest);
	const full = base.env ?? {};
	// The credential is found by value, so no variable names are read here.
	const keep = Object.keys(full).filter(k => full[k] === p.cred.value && p.cred.value !== '');
	return applyTuning(
		{
			...base,
			env: scrubChatEnv(full, keep),
			systemPrompt: {type: 'preset', preset: 'claude_code', append: buildChatHint(p.paths) + soulSection(p.paths)},
			settings: buildChatSettings(p.paths),
			tools: [...CHAT_TOOLS],
			disallowedTools: [...CHAT_DISALLOWED_TOOLS],
			permissionMode: 'default',
			canUseTool,
			...(consoleServer && {mcpServers: {...base.mcpServers, [CONSOLE_SERVER_NAME]: consoleServer}}),
			// Lets "claude rewind" restore files to their state at an earlier prompt.
			enableFileCheckpointing: true,
		},
		tuning,
	);
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
