import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';
import type {ProjectAccess, ProjectAccessReader} from './deps/project.js';

export const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep'];

export const DISALLOWED_TOOLS = [
	'Bash',
	'BashOutput',
	'KillShell',
	'Edit',
	'Write',
	'NotebookEdit',
	'WebFetch',
	'WebSearch',
	'Agent',
	'Task',
	'Skill',
	'SlashCommand',
	'TodoWrite',
	'ExitPlanMode',
	'mcp__*',
];

export const CHAT_TOOLS = [
	'Read',
	'Glob',
	'Grep',
	'Bash',
	'Edit',
	'Write',
	'AskUserQuestion',
	'Agent',
	'SendMessage',
	'Skill',
	'TodoWrite',
	'WebFetch',
	'WebSearch',
	'ExitPlanMode',
	'TaskStop',
	'TaskGet',
	'TaskList',
	'TaskOutput',
	'BashOutput',
	'KillShell',
];

export const CHAT_DISALLOWED_TOOLS = [
	'NotebookEdit',
	'SlashCommand',
	'EnterPlanMode',
	'Monitor',
	'ToolSearch',
];

export const MAX_TURNS = 20;

export const GUARD_DENY = [
	'Edit(./CLAUDE.md)',
	'Edit(./CLAUDE.local.md)',
	'Edit(./.claude/**)',
];

export const PLANS_DIR = 'plans';

export type Scope = {
	roots: string[];
	denied: string[];
	/** Roots where Claude may change anything without asking, in every mode (the md hub). */
	free?: string[];
	/** Dirs Claude may not write into, by the given or the resolved path (yena's Claude data dir). */
	locked?: string[];
	/** Parts of the locked dirs that stay writable (plan mode's plans dir). */
	lockedExcept?: string[];
	/** The project module's current isolation, read on every check (it changes during a chat). */
	projects?: () => Promise<ProjectAccess | undefined>;
	/** The project module's data dir (its state decides what is writable); shell commands naming it are refused. */
	projectDataDir?: string;
};

export type PolicyPaths = {
	projectDir: string;
	mdDir: string;
	/** The md hub that mdDir links to; the one place Claude edits freely (defaults to mdDir). */
	hubDir?: string;
	/** yena's Claude data dir; closed for writes when given. */
	dataDir?: string;
	configDir: string;
	stateFile: string;
	credentialsFile: string;
	/** The project module's access reader; projects are read-only unless it isolates them. */
	projects?: ProjectAccessReader;
};

// `auth login --console` writes primaryApiKey into .claude.json and its backups.
export const CONFIG_SECRET = ['.credentials.json', '.claude.json', 'backups'];

// Env files (`.env`, `.envrc`, `.env.local`, `.env-prod`…), PEM files and private keys, key stores
// (`*.key`, `*.p12`, `*.pfx`), SSH private keys and files that hold login tokens (`.netrc`, `.npmrc`, `.pgpass`).
const SECRET_BASENAMES = [
	/^\.env(rc)?$/,
	/^\.env[.\-_]/,
	/\.(pem|key|p12|pfx)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/,
	/^\.(netrc|npmrc|pgpass)$/,
];
// Templates of an env file hold no secrets by convention and are meant to be committed.
export const ENV_TEMPLATE = /^\.env(\.[\w-]+)*\.(example|sample|template|dist)$/i;
// Not secrets either: type declarations named after env files and public SSH keys.
const NOT_SECRET = [ENV_TEMPLATE, /\.d\.ts$/, /^id_\w+\.pub$/];

export const isSecretName = (name: string): boolean =>
	SECRET_BASENAMES.some(re => re.test(name)) && !NOT_SECRET.some(re => re.test(name));

// The accounts (keys, tokens, saved logins; see accounts.ts) sit next to credentials.json.
const accountPaths = (paths: PolicyPaths): [string, string] => {
	const dir = path.dirname(paths.credentialsFile);
	return [path.join(dir, 'accounts.json'), path.join(dir, 'accounts')];
};

// Claude Code permission rules: "//path" is absolute, "~/" is the home directory.
const absRule = (p: string) => `/${p}`;

export function buildScope(paths: PolicyPaths, home = homedir()): Scope {
	return {
		roots: [paths.projectDir, paths.hubDir ?? paths.mdDir, paths.configDir],
		free: [paths.hubDir ?? paths.mdDir],
		locked: paths.dataDir ? [paths.dataDir] : [],
		lockedExcept: [path.join(paths.configDir, PLANS_DIR)],
		denied: [
			paths.credentialsFile,
			...accountPaths(paths),
			paths.stateFile,
			path.join(paths.projectDir, '.yena'),
			'/proc',
			path.join(home, '.ssh'),
			...CONFIG_SECRET.map(x => path.join(paths.configDir, x)),
		],
		...(paths.projects && {projects: () => paths.projects!.read()}),
		...(paths.projects?.dataDir && {projectDataDir: paths.projects.dataDir}),
	};
}

export function buildAskSettings(paths: PolicyPaths): {
	permissions: {deny: string[]};
	disableAllHooks: true;
} {
	return {
		permissions: {
			deny: [
				...GUARD_DENY,
				`Read(${absRule(paths.credentialsFile)})`,
				`Read(${absRule(accountPaths(paths)[0])})`,
				`Read(${absRule(accountPaths(paths)[1])}/**)`,
				`Read(${absRule(paths.stateFile)})`,
				`Read(${absRule(paths.configDir)}/.credentials.json)`,
				`Read(${absRule(paths.configDir)}/.claude.json)`,
				`Read(${absRule(paths.configDir)}/backups/**)`,
				'Read(//proc/**)',
				'Read(~/.ssh/**)',
				'Read(**/.env*)',
				'Read(**/*.pem)',
				'Read(**/id_rsa*)',
				'Read(./.yena/**)',
			],
		},
		disableAllHooks: true,
	};
}

// Edit rules also cover Write.
// Everything in the Claude config dir except plans/ (where plan mode writes its plan file): settings
// rules cannot express "all but", so the parts are listed; the policy hook still refuses any other
// write into the config dir.
// agents, skills, commands and output-styles are not listed: they are symlinks into the md hub, and
// Claude Code resolves symlinks in rule paths, so a deny rule on them would deny the hub itself. The
// policy hook still refuses writes through those links (class 'deny-locked').
export const CONFIG_EDIT_DENY = [
	'*.json',
	'*.jsonl',
	'*.md',
	'plugins/**',
	'hooks/**',
	'projects/**',
	'file-history/**',
	'sessions/**',
	'session-env/**',
	'shell-snapshots/**',
	'backups/**',
	'cache/**',
	'todos/**',
	'statsig/**',
	'ide/**',
];


// The md hub is Claude's to change: edits there are allowed without asking in every mode,
// auto mode's classifier included. Deny rules still win over these.
export const freeEditAllow = (paths: PolicyPaths): string[] => [`Edit(${absRule(paths.hubDir ?? paths.mdDir)}/**)`];

// Ask rules the chat narrows: its policy hook checks the rest by name (`isSecretName`), templates and public keys excepted.
const CHAT_NARROWED: Record<string, string> = {'Read(**/.env*)': 'Read(**/.env)', 'Read(**/id_rsa*)': 'Read(**/id_rsa)'};

export function buildChatSettings(paths: PolicyPaths): {
	permissions: {allow: string[]; deny: string[]};
	disableAllHooks: true;
} {
	// Settings rules cannot say "but not .env.example": the chat names only `.env` and `id_rsa` here and
	// leaves the other env files and keys to the policy hook, which runs in every mode and lets the
	// templates and public keys through (`isSecretName`).
	const editDeny = [
		`Edit(${absRule(paths.credentialsFile)})`,
		`Edit(${absRule(accountPaths(paths)[0])})`,
		`Edit(${absRule(accountPaths(paths)[1])}/**)`,
		`Edit(${absRule(paths.stateFile)})`,
		...CONFIG_EDIT_DENY.map(p => `Edit(${absRule(paths.configDir)}/${p})`),
		`Edit(${absRule(paths.configDir)}/.credentials.json)`,
		`Edit(${absRule(paths.configDir)}/.claude.json)`,
		'Edit(//proc/**)',
		'Edit(~/.ssh/**)',
		'Edit(**/.env)',
		'Edit(**/*.pem)',
		'Edit(**/id_rsa)',
		'Edit(./.yena/**)',
		...(paths.projects?.dataDir ? [`Edit(${absRule(paths.projects.dataDir)}/**)`] : []),
	];
	return {
		permissions: {
			allow: freeEditAllow(paths),
			deny: [...buildAskSettings(paths).permissions.deny.map(r => CHAT_NARROWED[r] ?? r), ...editDeny],
		},
		disableAllHooks: true,
	};
}

// Resolves symlinks of the nearest existing ancestor, so nonexistent targets
// still land where they would be created.
export async function resolveReal(p: string): Promise<string> {
	const tail: string[] = [];
	let cur = path.resolve(p);
	for (;;) {
		try {
			return path.join(await realpath(cur), ...tail.reverse());
		} catch (error) {
			const parent = path.dirname(cur);
			if (parent === cur || (error as NodeJS.ErrnoException).code === 'EACCES') {
				throw error;
			}
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

const within = (child: string, dir: string) =>
	child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

async function realList(list: string[]): Promise<string[]> {
	const out: string[] = [];
	for (const item of list) {
		try {
			out.push(await resolveReal(item));
		} catch {
			out.push(path.resolve(item));
		}
	}
	return out;
}

export async function isPathAllowed(p: string, scope: Scope): Promise<boolean> {
	if (typeof p !== 'string' || p === '' || p.includes('\0') || scope.roots.length === 0) {
		return false;
	}
	let real: string;
	try {
		real = await resolveReal(path.resolve(scope.roots[0] as string, p));
	} catch {
		return false;
	}
	const extra = (await scope.projects?.())?.roots ?? [];
	const roots = await realList([...scope.roots, ...extra]);
	const denied = await realList(scope.denied);
	const rootLen = Math.max(-1, ...roots.filter(r => within(real, r)).map(r => r.length));
	if (rootLen < 0) {
		return false;
	}
	// A root nested inside a denied dir (the md dir under .yena) stays readable.
	const deniedLen = Math.max(-1, ...denied.filter(d => within(real, d)).map(d => d.length));
	if (deniedLen >= rootLen) {
		return false;
	}
	return !path
		.relative('/', real)
		.split(path.sep)
		.some(isSecretName);
}

const isPlainRelative = (pattern: string) =>
	!path.isAbsolute(pattern) && !pattern.split(/[\\/]/).includes('..') && !pattern.startsWith('~');

const GLOB_CHARS = /[*?[\]{}!]/;

/**
 * The folder a glob pattern starts from: the part before its first wildcard, resolved against the
 * search path ("/app/src" for an absolute pattern under /app/src). Undefined when the pattern could
 * leave that folder (".." after a wildcard, "~").
 */
export function globBase(pattern: string, from: string): string | undefined {
	if (pattern.startsWith('~')) return undefined;
	const segs = pattern.split(/[\\/]/);
	const at = segs.findIndex(seg => GLOB_CHARS.test(seg));
	const fixed = at < 0 ? segs : segs.slice(0, at);
	if (at >= 0 && segs.slice(at).includes('..')) return undefined;
	const prefix = fixed.join('/');
	return path.resolve(from, prefix === '' && path.isAbsolute(pattern) ? '/' : prefix);
}

export function createCanUseTool(scope: Scope): CanUseTool {
	const notAvailable = (name: string) => ({
		behavior: 'deny' as const,
		message: `Tool "${name}" is not available in "claude ask" (read-only mode).`,
	});
	const pathDenied = {
		behavior: 'deny' as const,
		message: 'Access to that path is not allowed.',
	};
	const optionalString = (v: unknown) => v === undefined || typeof v === 'string';

	return async (toolName, input) => {
		const cwd = scope.roots[0] as string;
		let paths: string[];
		switch (toolName) {
			case 'Read':
				if (typeof input.file_path !== 'string') return pathDenied;
				paths = [input.file_path];
				break;
			case 'Grep':
				if (!optionalString(input.path) || !optionalString(input.glob)) return pathDenied;
				paths = [(input.path as string | undefined) ?? cwd];
				if (typeof input.glob === 'string' && !isPlainRelative(input.glob)) {
					const base = globBase(input.glob, path.resolve(cwd, paths[0]!));
					if (base === undefined) return pathDenied;
					paths.push(base);
				}
				break;
			case 'Glob':
				if (!optionalString(input.path) || typeof input.pattern !== 'string') return pathDenied;
				paths = [(input.path as string | undefined) ?? cwd];
				// An absolute pattern or one with ".." is checked by the folder it starts from.
				if (!isPlainRelative(input.pattern)) {
					const base = globBase(input.pattern, path.resolve(cwd, paths[0]!));
					if (base === undefined) return pathDenied;
					paths.push(base);
				}
				break;
			default:
				return notAvailable(toolName);
		}
		for (const p of paths) {
			if (!(await isPathAllowed(p, scope))) return pathDenied;
		}
		return {behavior: 'allow', updatedInput: input};
	};
}

export function isGuardedPath(realPath: string, projectDir: string): boolean {
	const rel = path.relative(path.resolve(projectDir), path.resolve(realPath));
	if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
	const [first] = rel.split(path.sep);
	return rel === 'CLAUDE.md' || rel === 'CLAUDE.local.md' || first === '.claude';
}

export type EditTargetClass =
	| 'deny-outside'
	| 'deny-guard'
	| 'deny-secret'
	| 'prompt-only'
	| 'auto-eligible'
	| 'free'
	| 'deny-locked'
	| 'deny-readonly';

const NO_AUTO_EXACT = new Set([
	'Makefile',
	'yena',
	'Dockerfile',
	'compose.yaml',
	'.dockerignore',
	'package.json',
	'package-lock.json',
	'yena-modules.json',
]);

function noAutoAccept(rel: string): boolean {
	const segs = rel.split(path.sep);
	const first = segs[0] as string;
	if (first.startsWith('.')) return true;
	if (NO_AUTO_EXACT.has(rel) || first === 'scripts') return true;
	if (first === 'modules') {
		if (segs[2] === 'bin' || (segs.length === 3 && segs[2] === 'yena.json')) return true;
		return segs[1] === 'claude' && segs[2] === 'src';
	}
	return false;
}

/**
 * A write under a managed dir (workplace, stages, the hub's projects dir) is allowed only inside a
 * writable folder (an isolated project, its docs or its stages). Undefined: not a project path.
 */
async function projectTarget(real: string, access: ProjectAccess): Promise<'readonly' | {dir: string; docs: boolean} | undefined> {
	const managed = await realList(access.managed);
	if (!managed.some(d => within(real, d))) return undefined;
	const [docsRoot] = (await realList([access.docs])) as [string];
	const writable = await realList(access.writable);
	const dir = writable.filter(d => within(real, d)).sort((a, b) => b.length - a.length)[0];
	if (dir === undefined || dir === real) return 'readonly';
	return {dir, docs: within(dir, docsRoot)};
}

export async function classifyEditTarget(filePath: string, scope: Scope): Promise<EditTargetClass> {
	const projectDir = scope.roots[0];
	if (projectDir === undefined || typeof filePath !== 'string' || filePath === '' || filePath.includes('\0')) {
		return 'deny-outside';
	}
	let real: string;
	try {
		real = await resolveReal(path.resolve(projectDir, filePath));
	} catch {
		return 'deny-outside';
	}
	const lexical = path.resolve(projectDir, filePath);
	const locked = [...(scope.locked ?? []).map(d => path.resolve(d)), ...(await realList(scope.locked ?? []))];
	const except = await realList(scope.lockedExcept ?? []);
	if (locked.some(d => within(lexical, d) || within(real, d)) && !except.some(d => within(real, d))) return 'deny-locked';
	const access = await scope.projects?.();
	if (access) {
		const verdict = await projectTarget(real, access);
		if (verdict === 'readonly') return 'deny-readonly';
		if (verdict !== undefined) {
			if (!verdict.docs && isGuardedPath(real, verdict.dir)) return 'deny-guard';
			if (!(await isPathAllowed(real, scope))) return 'deny-secret';
			if (verdict.docs) return 'free';
			const [first] = path.relative(verdict.dir, real).split(path.sep);
			return first === undefined || first.startsWith('.') ? 'prompt-only' : 'auto-eligible';
		}
	}
	const roots = await realList(scope.roots);
	const [realProject, ...promptRoots] = roots as [string, ...string[]];
	if (!within(real, realProject) && !promptRoots.some(r => within(real, r))) return 'deny-outside';
	if (isGuardedPath(real, realProject)) return 'deny-guard';
	if (!(await isPathAllowed(real, scope))) return 'deny-secret';
	if ((await realList(scope.free ?? [])).some(r => within(real, r))) return 'free';
	if (!within(real, realProject) || promptRoots.some(r => within(real, r))) return 'prompt-only';
	return noAutoAccept(path.relative(realProject, real)) ? 'prompt-only' : 'auto-eligible';
}
