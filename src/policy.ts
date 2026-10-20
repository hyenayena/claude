import {realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';

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

export type Scope = {
	roots: string[];
	denied: string[];
};

export type PolicyPaths = {
	projectDir: string;
	mdDir: string;
	configDir: string;
	tokenFile: string;
	stateFile: string;
	credentialsFile: string;
};

const SECRET_BASENAMES = [/^\.env/, /\.pem$/, /^id_rsa/];

// Claude Code permission rules: "//path" is absolute, "~/" is the home directory.
const absRule = (p: string) => `/${p}`;

export function buildScope(paths: PolicyPaths, home = homedir()): Scope {
	return {
		roots: [paths.projectDir, paths.mdDir, paths.configDir],
		denied: [
			paths.tokenFile,
			paths.credentialsFile,
			paths.stateFile,
			path.join(paths.projectDir, '.yena'),
			'/proc',
			path.join(home, '.ssh'),
		],
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
				`Read(${absRule(paths.tokenFile)})`,
				`Read(${absRule(paths.credentialsFile)})`,
				`Read(${absRule(paths.stateFile)})`,
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
export const CONFIG_EDIT_DENY = [
	'*.json',
	'*.jsonl',
	'*.md',
	'agents/**',
	'commands/**',
	'skills/**',
	'plugins/**',
	'hooks/**',
	'output-styles/**',
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

export const PLANS_DIR = 'plans';

export function buildChatSettings(paths: PolicyPaths): {
	permissions: {deny: string[]};
	disableAllHooks: true;
} {
	const editDeny = [
		`Edit(${absRule(paths.tokenFile)})`,
		`Edit(${absRule(paths.credentialsFile)})`,
		`Edit(${absRule(paths.stateFile)})`,
		...CONFIG_EDIT_DENY.map(p => `Edit(${absRule(paths.configDir)}/${p})`),
		'Edit(//proc/**)',
		'Edit(~/.ssh/**)',
		'Edit(**/.env*)',
		'Edit(**/*.pem)',
		'Edit(**/id_rsa*)',
		'Edit(./.yena/**)',
	];
	return {
		permissions: {deny: [...buildAskSettings(paths).permissions.deny, ...editDeny]},
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
	const roots = await realList(scope.roots);
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
		.some(seg => SECRET_BASENAMES.some(re => re.test(seg)));
}

const isPlainRelative = (pattern: string) =>
	!path.isAbsolute(pattern) && !pattern.split(/[\\/]/).includes('..') && !pattern.startsWith('~');

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
				if (typeof input.glob === 'string' && !isPlainRelative(input.glob)) return pathDenied;
				paths = [(input.path as string | undefined) ?? cwd];
				break;
			case 'Glob':
				if (!optionalString(input.path) || typeof input.pattern !== 'string') return pathDenied;
				if (!isPlainRelative(input.pattern)) return pathDenied;
				paths = [(input.path as string | undefined) ?? cwd];
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
	| 'auto-eligible';

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
	const roots = await realList(scope.roots);
	const [realProject, ...promptRoots] = roots as [string, ...string[]];
	if (!within(real, realProject) && !promptRoots.some(r => within(real, r))) return 'deny-outside';
	if (isGuardedPath(real, realProject)) return 'deny-guard';
	if (!(await isPathAllowed(real, scope))) return 'deny-secret';
	if (!within(real, realProject) || promptRoots.some(r => within(real, r))) return 'prompt-only';
	return noAutoAccept(path.relative(realProject, real)) ? 'prompt-only' : 'auto-eligible';
}
