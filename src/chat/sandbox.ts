import {spawnSync} from 'node:child_process';
import {accessSync, constants, readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import type {ProjectAccess} from '../deps/project.js';
import {accountPaths, authStatePath, CONFIG_HISTORY, CONFIG_SECRET, CONFIG_TRANSCRIPTS, HUB_ASK_FILES, PLANS_DIR, type PolicyPaths} from '../policy.js';

// Hosts the chat's Bash reaches without a prompt (git over https, npm); any other host asks.
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
	/** Folders with yena's own sockets (the chat's runner and control); Bash must not reach them. */
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

/**
 * Entries of `dir` that Bash must not write: every one that is not a writable folder. An entry holding a
 * writable folder is split further, because a write deny on a parent would also cover the folder inside it.
 */
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

/**
 * The chat's Bash sandbox (bubblewrap on Linux). Claude Code lets sandboxed commands write to the working
 * directory and every additional directory, which include `/workplace`, `/stage` and the Claude config dir,
 * so write denies carve out what is not Claude's: projects that are not isolated, the config dir except
 * plans, and the hub's instruction files. Write denies win over allows, which is why parents of writable
 * folders are never denied whole. Read denies cover the secrets the file tools are already denied.
 */
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
		// Start-up environments of yena and the CLI hold credentials; the policy hook relies on this deny.
		'/proc',
	].map(p => path.resolve(p));
	// Git signs through the account ssh-agents (account module), and the Linux sandbox can only open all
	// unix sockets or none; yena's own sockets are hidden above instead.
	const unixSockets = paths.accountSecrets !== undefined;
	return {
		enabled: true,
		// Without bubblewrap (an image built before it) Bash runs unsandboxed and the chat warns.
		failIfUnavailable: false,
		// A sandboxed command still goes through yena's prompts and policy hook.
		autoAllowBashIfSandboxed: false,
		allowUnsandboxedCommands: false,
		// The container is unprivileged: bubblewrap cannot mount a fresh /proc there.
		enableWeakerNestedSandbox: true,
		filesystem: {allowWrite: ['/tmp'], denyWrite: [...new Set(denyWrite)], denyRead: [...new Set(denyRead)]},
		network: {allowedDomains: [...SANDBOX_DOMAINS], ...(unixSockets && {allowAllUnixSockets: true as const})},
	};
}

/** The programs the Linux sandbox needs that are not on PATH (an image built before they were added). */
export function missingSandboxTools(pathVar: string | undefined, exists: (file: string) => boolean = isExecutable): string[] {
	const dirs = (pathVar ?? '').split(path.delimiter).filter(Boolean);
	return ['bwrap', 'socat'].filter(tool => !dirs.some(dir => exists(path.join(dir, tool))));
}

/** Why the chat's Bash cannot be sandboxed here, or undefined when it can. */
export function sandboxProblem(pathVar: string | undefined, starts: () => boolean = sandboxStarts, exists?: (file: string) => boolean): string | undefined {
	const missing = missingSandboxTools(pathVar, exists);
	if (missing.length > 0) return `${missing.join(', ')} not installed (rebuild the image: ./yena build, then ./yena rebuild)`;
	if (!starts()) return 'bubblewrap cannot create its namespaces in this container (recreate it with the seccomp profile from compose.yaml: ./yena rebuild)';
	return undefined;
}

type Run =(cmd: string, args: string[], opts: {stdio: 'ignore'; timeout: number}) => {status: number | null};

/**
 * Whether bubblewrap can create its namespaces here. Docker's default seccomp profile forbids that; Claude
 * Code then fails every Bash command instead of running it unsandboxed, so the chat must know beforehand.
 */
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

/** Keeps the running chat's sandbox in step with project isolation, which changes while the chat is open. */
export function createSandboxSync(build: () => Promise<SandboxSettings>, apply: (s: SandboxSettings) => Promise<void>) {
	let applied: string | undefined;
	return {
		/** Settings for a new query; they become the applied ones. */
		spawned(s: SandboxSettings): void {
			applied = JSON.stringify(s);
		},
		/** Rebuilds and applies the settings when they changed; throws when they could not be applied. */
		async refresh(): Promise<void> {
			const next = await build();
			const key = JSON.stringify(next);
			if (key === applied) return;
			await apply(next);
			applied = key;
		},
	};
}
