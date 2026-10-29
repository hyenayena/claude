import {realpath, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import type {CanUseTool} from '@anthropic-ai/claude-agent-sdk';
import type {AccountSecretPaths} from './deps/account.js';
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
	image?: string;
	hostStateDenied?: string[];
	free?: string[];
	askFiles?: string[];
	transcriptDirs?: string[];
	locked?: string[];
	lockedExcept?: string[];
	projects?: () => Promise<ProjectAccess | undefined>;
	projectDataDir?: string;
	shellDenied?: string[];
	agentSocket?: string;
};

export type PolicyPaths = {
	projectDir: string;
	mdDir: string;
	hubDir?: string;
	dataDir?: string;
	configDir: string;
	stateFile: string;
	credentialsFile: string;
	projects?: ProjectAccessReader;
	accountSecrets?: AccountSecretPaths;
	agentSocket?: string;
	imageReadOnly?: boolean;
	hostState?: string;
};

export const HUB_ASK_FILES = ['CLAUDE.md', 'SOUL.md'];

export const CONFIG_TRANSCRIPTS = 'projects';
export const CONFIG_HISTORY = 'history.jsonl';

export const CONFIG_SECRET = ['.credentials.json', '.claude.json', 'backups'];

const SECRET_BASENAMES = [
	/^\.env(rc)?$/,
	/^\.env[.\-_]/,
	/\.(pem|key|p12|pfx)$/i,
	/^id_(rsa|dsa|ecdsa|ed25519)/,
	/^\.(netrc|npmrc|pgpass)$/,
];
export const ENV_TEMPLATE = /^\.env(\.[\w-]+)*\.(example|sample|template|dist)$/i;
const NOT_SECRET = [ENV_TEMPLATE, /\.d\.ts$/, /^id_\w+\.pub$/];

export const isSecretName = (name: string): boolean =>
	SECRET_BASENAMES.some(re => re.test(name)) && !NOT_SECRET.some(re => re.test(name));

export const accountPaths = (paths: PolicyPaths): [string, string] => {
	const dir = path.dirname(paths.credentialsFile);
	return [path.join(dir, 'accounts.json'), path.join(dir, 'accounts')];
};

export const authStatePath = (paths: PolicyPaths): string => path.join(path.dirname(paths.credentialsFile), 'auth.json');

export function accountShellDenied(secrets: AccountSecretPaths | undefined): string[] {
	if (!secrets) return [];
	const tails = secrets.secretDirs.map(d => path.join(path.basename(path.dirname(d)), path.basename(d)));
	return [path.resolve(secrets.dataDir), ...tails];
}

const accountSecretRules = (paths: PolicyPaths, tool: 'Read' | 'Edit'): string[] =>
	(paths.accountSecrets?.secretDirs ?? []).flatMap(d => [`${tool}(${absRule(d)})`, `${tool}(${absRule(d)}/**)`]);

const absRule = (p: string) => `/${p}`;

export function buildScope(paths: PolicyPaths, home = homedir()): Scope {
	const hub = paths.hubDir ?? paths.mdDir;
	return {
		roots: [paths.projectDir, hub, paths.configDir],
		free: [hub],
		askFiles: HUB_ASK_FILES.map(f => path.join(hub, f)),
		transcriptDirs: [path.join(paths.configDir, CONFIG_TRANSCRIPTS)],
		locked: paths.dataDir ? [paths.dataDir] : [],
		lockedExcept: [path.join(paths.configDir, PLANS_DIR)],
		denied: [
			paths.credentialsFile,
			...accountPaths(paths),
			authStatePath(paths),
			paths.stateFile,
			path.join(paths.projectDir, '.yena'),
			'/proc',
			path.join(home, '.ssh'),
			...CONFIG_SECRET.map(x => path.join(paths.configDir, x)),
			path.join(paths.configDir, CONFIG_HISTORY),
			...(paths.accountSecrets?.secretDirs ?? []),
		],
		...(paths.accountSecrets && {shellDenied: accountShellDenied(paths.accountSecrets)}),
		...(paths.agentSocket && {agentSocket: paths.agentSocket}),
		...(paths.imageReadOnly && {image: paths.projectDir}),
		...(paths.hostState && {hostStateDenied: [path.resolve(paths.hostState)]}),
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
				`Read(${absRule(authStatePath(paths))})`,
				`Read(${absRule(paths.stateFile)})`,
				`Read(${absRule(paths.configDir)}/.credentials.json)`,
				`Read(${absRule(paths.configDir)}/.claude.json)`,
				`Read(${absRule(paths.configDir)}/backups/**)`,
				`Read(${absRule(paths.configDir)}/${CONFIG_HISTORY})`,
				`Read(${absRule(paths.configDir)}/${CONFIG_TRANSCRIPTS}/**/*.jsonl)`,
				'Read(//proc/**)',
				'Read(~/.ssh/**)',
				'Read(**/.env*)',
				'Read(**/*.pem)',
				'Read(**/id_rsa*)',
				'Read(./.yena/**)',
				...accountSecretRules(paths, 'Read'),
			],
		},
		disableAllHooks: true,
	};
}

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

export const freeEditAllow = (paths: PolicyPaths): string[] => [`Edit(${absRule(paths.hubDir ?? paths.mdDir)}/**)`];

const CHAT_NARROWED: Record<string, string> = {'Read(**/.env*)': 'Read(**/.env)', 'Read(**/id_rsa*)': 'Read(**/id_rsa)'};

export const hubAskEdit = (paths: PolicyPaths): string[] =>
	HUB_ASK_FILES.map(f => `Edit(${absRule(path.join(paths.hubDir ?? paths.mdDir, f))})`);

export function buildChatSettings(paths: PolicyPaths): {
	permissions: {allow: string[]; ask: string[]; deny: string[]};
	disableAllHooks: true;
} {
	const editDeny = [
		`Edit(${absRule(paths.credentialsFile)})`,
		`Edit(${absRule(accountPaths(paths)[0])})`,
		`Edit(${absRule(accountPaths(paths)[1])}/**)`,
		`Edit(${absRule(authStatePath(paths))})`,
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
		...accountSecretRules(paths, 'Edit'),
		...(paths.projects?.dataDir ? [`Edit(${absRule(paths.projects.dataDir)}/**)`] : []),
	];
	return {
		permissions: {
			allow: freeEditAllow(paths),
			ask: hubAskEdit(paths),
			deny: [...buildAskSettings(paths).permissions.deny.map(r => CHAT_NARROWED[r] ?? r), ...editDeny],
		},
		disableAllHooks: true,
	};
}

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
	for (const r of await realList(extra)) {
		if (!within(real, r)) continue;
		const segs = path.relative(r, real).split(path.sep);
		if (segs[0] === '.yena' || segs[1] === '.yena') return false;
	}
	const rootLen = Math.max(-1, ...roots.filter(r => within(real, r)).map(r => r.length));
	if (rootLen < 0) {
		return false;
	}
	const deniedLen = Math.max(-1, ...denied.filter(d => within(real, d)).map(d => d.length));
	if (deniedLen >= rootLen) {
		return false;
	}
	if (real.endsWith('.jsonl') && (await realList(scope.transcriptDirs ?? [])).some(d => within(real, d))) {
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
	| 'deny-readonly'
	| 'deny-image';

const NO_AUTO_EXACT = new Set([
	'Makefile',
	'yena',
	'Dockerfile',
	'compose.yaml',
	'seccomp.json',
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

export async function isYenaCheckout(dir: string): Promise<boolean> {
	const has = (rel: string) =>
		stat(path.join(dir, rel)).then(
			s => s.isFile(),
			() => false,
		);
	return (await has('yena')) && (await has('compose.yaml')) && (await has(path.join('src', 'cli.ts')));
}

async function projectTarget(real: string, access: ProjectAccess): Promise<'readonly' | {dir: string; docs: boolean} | undefined> {
	const managed = await realList(access.managed);
	if (!managed.some(d => within(real, d))) return undefined;
	const [docsRoot] = (await realList([access.docs])) as [string];
	const writable = await realList(access.writable);
	const dir = writable.filter(d => within(real, d)).sort((a, b) => b.length - a.length)[0];
	if (dir === undefined || dir === real) return 'readonly';
	return {dir, docs: within(dir, docsRoot)};
}

export async function isAskFile(filePath: string, scope: Scope): Promise<boolean> {
	const projectDir = scope.roots[0];
	if (projectDir === undefined || !scope.askFiles?.length) return false;
	const lexical = path.resolve(projectDir, filePath);
	const real = await resolveReal(lexical).catch(() => lexical);
	const files = [...scope.askFiles.map(f => path.resolve(f)), ...(await realList(scope.askFiles))];
	return files.includes(lexical) || files.includes(real);
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
	if (scope.image !== undefined) {
		const image = await resolveReal(scope.image).catch(() => path.resolve(scope.image as string));
		if (within(real, image) || within(lexical, path.resolve(scope.image))) return 'deny-image';
	}
	const access = await scope.projects?.();
	if (access) {
		const verdict = await projectTarget(real, access);
		if (verdict === 'readonly') return 'deny-readonly';
		if (verdict !== undefined) {
			if (!verdict.docs && isGuardedPath(real, verdict.dir)) return 'deny-guard';
			if (!(await isPathAllowed(real, scope))) return 'deny-secret';
			if (verdict.docs) return 'free';
			const rel = path.relative(verdict.dir, real);
			const [first] = rel.split(path.sep);
			if (first === undefined || first.startsWith('.')) return 'prompt-only';
			return (await isYenaCheckout(verdict.dir)) && noAutoAccept(rel) ? 'prompt-only' : 'auto-eligible';
		}
	}
	const roots = await realList(scope.roots);
	const [realProject, ...promptRoots] = roots as [string, ...string[]];
	if (!within(real, realProject) && !promptRoots.some(r => within(real, r))) return 'deny-outside';
	if (isGuardedPath(real, realProject)) return 'deny-guard';
	if (!(await isPathAllowed(real, scope))) return 'deny-secret';
	if (await isAskFile(filePath, scope)) return 'prompt-only';
	if ((await realList(scope.free ?? [])).some(r => within(real, r))) return 'free';
	if (!within(real, realProject) || promptRoots.some(r => within(real, r))) return 'prompt-only';
	return noAutoAccept(path.relative(realProject, real)) ? 'prompt-only' : 'auto-eligible';
}
