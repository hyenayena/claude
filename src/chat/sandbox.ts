import {spawnSync} from 'node:child_process';
import {accessSync, constants, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {ProjectAccess} from '../deps/project.js';
import {accountPaths, authStatePath, CONFIG_HISTORY, CONFIG_SECRET, CONFIG_TRANSCRIPTS, HUB_ASK_FILES, PLANS_DIR, type PolicyPaths} from '../policy.js';

export const SANDBOX_DOMAINS = ['github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org'];

export type SandboxSettings = {
	enabled: true;
	failIfUnavailable: false;
	autoAllowBashIfSandboxed: false;
	allowUnsandboxedCommands: false;
	enableWeakerNestedSandbox: true;
	filesystem: {allowWrite: string[]; denyWrite: string[]; denyRead: string[]};
	network: {allowedDomains: string[]; allowAllUnixSockets?: true};
};

export type SandboxExtras = {
	socketDirs?: string[];
};

export type ListDir = (dir: string) => string[];

const listDir: ListDir = dir => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

const within = (child: string, dir: string) => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

function readOnlyEntries(dir: string, writable: string[], list: ListDir): string[] {
	const out: string[] = [];
	for (const name of list(dir)) {
		const entry = path.join(dir, name);
		if (writable.includes(entry)) continue;
		if (writable.some(w => within(w, entry))) out.push(...readOnlyEntries(entry, writable, list));
		else out.push(entry);
	}
	return out;
}

export function buildSandbox(paths: PolicyPaths, access: ProjectAccess | undefined, list: ListDir = listDir, home = homedir(), extras: SandboxExtras = {}): SandboxSettings {
	const hub = path.resolve(paths.hubDir ?? paths.mdDir);
	const config = path.resolve(paths.configDir);
	const writable = (access?.writable ?? []).map(d => path.resolve(d));
	const managed = (access?.managed ?? []).map(d => path.resolve(d));
	const denyWrite = [
		...managed.flatMap(dir => readOnlyEntries(dir, writable, list)),
		...readOnlyEntries(config, [path.join(config, PLANS_DIR)], list),
		...HUB_ASK_FILES.map(f => path.join(hub, f)),
	];
	const [accountsFile, accountsDir] = accountPaths(paths);
	const denyRead = [
		paths.credentialsFile,
		accountsFile,
		accountsDir,
		authStatePath(paths),
		paths.stateFile,
		...CONFIG_SECRET.map(x => path.join(config, x)),
		path.join(config, CONFIG_HISTORY),
		path.join(config, CONFIG_TRANSCRIPTS),
		path.join(paths.projectDir, '.yena'),
		path.join(home, '.ssh'),
		...(paths.accountSecrets?.secretDirs ?? []),
		...(paths.projects?.dataDir ? [paths.projects.dataDir] : []),
		...(paths.hostState ? [paths.hostState] : []),
		...(extras.socketDirs ?? []),
		'/proc',
	].map(p => path.resolve(p));
	const unixSockets = paths.accountSecrets !== undefined;
	return {
		enabled: true,
		failIfUnavailable: false,
		autoAllowBashIfSandboxed: false,
		allowUnsandboxedCommands: false,
		enableWeakerNestedSandbox: true,
		filesystem: {allowWrite: ['/tmp'], denyWrite: [...new Set(denyWrite)], denyRead: [...new Set(denyRead)]},
		network: {allowedDomains: [...SANDBOX_DOMAINS], ...(unixSockets && {allowAllUnixSockets: true as const})},
	};
}

export function missingSandboxTools(pathVar: string | undefined, exists: (file: string) => boolean = isExecutable): string[] {
	const dirs = (pathVar ?? '').split(path.delimiter).filter(Boolean);
	return ['bwrap', 'socat'].filter(tool => !dirs.some(dir => exists(path.join(dir, tool))));
}

export function sandboxProblem(pathVar: string | undefined, starts: () => boolean = sandboxStarts, exists?: (file: string) => boolean): string | undefined {
	const missing = missingSandboxTools(pathVar, exists);
	if (missing.length > 0) return `${missing.join(', ')} not installed (rebuild the image: ./yena build, then ./yena rebuild)`;
	if (!starts()) return 'bubblewrap cannot create its namespaces in this container (recreate it with the seccomp profile from compose.yaml: ./yena rebuild)';
	return undefined;
}

type Run =(cmd: string, args: string[], opts: {stdio: 'ignore'; timeout: number}) => {status: number | null};

export function sandboxStarts(run: Run = spawnSync): boolean {
	const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--', 'true'];
	try {
		return run('bwrap', args, {stdio: 'ignore', timeout: 5000}).status === 0;
	} catch {
		return false;
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

export function createSandboxSync(build: () => Promise<SandboxSettings>, apply: (s: SandboxSettings) => Promise<void>) {
	let applied: string | undefined;
	return {
		spawned(s: SandboxSettings): void {
			applied = JSON.stringify(s);
		},
		async refresh(): Promise<void> {
			const next = await build();
			const key = JSON.stringify(next);
			if (key === applied) return;
			await apply(next);
			applied = key;
		},
	};
}
