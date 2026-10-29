import type {HookCallback, HookCallbackMatcher, HookJSONOutput} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import {classifyEditTarget, createCanUseTool, isAskFile, PLANS_DIR, resolveReal, type Scope} from '../policy.js';
import {agentDenial} from './agent-policy.js';
import {addsPrivilegedFrontmatter, isDefinitionPath} from './definition-guard.js';
import {POLICY_ASK, POLICY_DENY} from './permission.js';

// Heuristic that over-denies on purpose: a shell command naming an auth file is refused in every mode.
const AUTH_FILE = /credentials\.json|\.claude\.json|config\/backups|accounts\.json|claude\/accounts\b/;

// The host's ssh-agent signs with the user's own keys; git goes out through the account keys instead.
const AGENT_VAR = /\bSSH_AUTH_SOCK\b|\bssh-add\b/;
const usesAgent = (command: string, socket: string | undefined): boolean =>
	AGENT_VAR.test(command) || (socket !== undefined && socket !== '' && (command.includes(socket) || command.includes(path.dirname(socket) + '/')));

// A process's start-up environment (/proc/<pid>/environ) still holds the credentials yena and the CLI got.
const PROC_ENV = /\benviron\b/;

const allow: HookJSONOutput = {continue: true};

const denyWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
});

// "ask" forces the permission prompt even where an allow rule or auto mode's classifier would let the call through.
const askWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason},
});

export const WEB_KEY_PREFIX = 'web:';
/** The "always" key of a fetch: its host, lower-case. Undefined for anything that is not an http(s) URL. */
export function webKey(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		const u = new URL(url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
		return u.hostname === '' ? undefined : `${WEB_KEY_PREFIX}${u.hostname.toLowerCase()}`;
	} catch {
		return undefined;
	}
}

export type PolicyHookOptions = {
	/** Whether the user approved fetches from this "always" key (`webKey`) for good. */
	approved?: (key: string) => boolean;
	/** Brings the Bash sandbox up to date with project isolation before a command runs; throws when it cannot. */
	beforeBash?: () => Promise<void>;
	/** Bash runs in a sandbox that denies reading /proc, so the text check for process environments is not needed. */
	procHidden?: boolean;
};

/**
 * Hard path policy that holds in every permission mode. In auto mode the classifier can
 * approve a call without asking `canUseTool`, so the checks are repeated here; the hook
 * never allows anything itself, it only denies.
 */
export function createPolicyHook(scope: Scope, configDir?: string, hookOpts: PolicyHookOptions = {}): HookCallback {
	const config = configDir ? path.resolve(configDir) : undefined;
	const plans = config ? path.join(config, PLANS_DIR) : undefined;
	const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
	const readTool = createCanUseTool(scope);
	const projectData = scope.projectDataDir ? path.resolve(scope.projectDataDir) : undefined;
	const opts = {signal: new AbortController().signal, toolUseID: 'policy-hook'} as Parameters<typeof readTool>[2];
	return async input => {
		if (input.hook_event_name !== 'PreToolUse') return allow;
		const tool = input.tool_name;
		const args = (input.tool_input ?? {}) as Record<string, unknown>;
		switch (tool) {
			case 'Read':
			case 'Glob':
			case 'Grep': {
				const r = await readTool(tool, args, opts);
				return r?.behavior === 'allow' ? allow : denyWith(POLICY_DENY.outside);
			}
			case 'Edit':
			case 'Write': {
				if (typeof args.file_path !== 'string') return denyWith(POLICY_DENY.invalidInput);
				const cls = await classifyEditTarget(args.file_path, scope);
				if (cls === 'deny-outside') return denyWith(POLICY_DENY.outside);
				if (cls === 'deny-locked') return denyWith(POLICY_DENY.locked);
				if (cls === 'deny-readonly') return denyWith(POLICY_DENY.readonly);
				if (cls === 'deny-image') return denyWith(POLICY_DENY.image);
				// The Claude config is not Claude's to change, except the plan files plan mode writes.
				if (config && plans) {
					const target = await resolveReal(path.resolve(scope.roots[0] ?? '/', args.file_path)).catch(() => undefined);
					const realConfig = await resolveReal(config).catch(() => config);
					if (target === undefined) return denyWith(POLICY_DENY.outside);
					if (inside(target, realConfig) && !inside(target, path.join(realConfig, PLANS_DIR))) return denyWith(POLICY_DENY.guard);
				}
				if (cls === 'deny-guard') return denyWith(POLICY_DENY.guard);
				if (cls === 'deny-secret') return denyWith(POLICY_DENY.secret);
				// A skill's allowed-tools or an agent's permissionMode would let later calls skip the prompts.
				const lexical = path.resolve(scope.roots[0] ?? '/', args.file_path);
				const real = await resolveReal(lexical).catch(() => lexical);
				const hubs = await Promise.all((scope.free ?? []).map(d => resolveReal(d).catch(() => path.resolve(d))));
				if (
					(isDefinitionPath(real, hubs) || isDefinitionPath(lexical, hubs)) &&
					(await addsPrivilegedFrontmatter(real, tool, args))
				) {
					return denyWith(POLICY_DENY.privileged);
				}
				return (await isAskFile(args.file_path, scope)) ? askWith(POLICY_ASK.instructions) : allow;
			}
			// A fetch carries data out in its URL: the first one to a host asks, in auto mode too.
			case 'WebFetch': {
				const key = webKey(args.url);
				if (key === undefined) return denyWith(POLICY_DENY.invalidInput);
				return hookOpts.approved?.(key) ? allow : askWith(POLICY_ASK.newHost);
			}
			case 'Bash': {
				if (args.dangerouslyDisableSandbox) return denyWith(POLICY_DENY.background);
				const command = args.command;
				if (typeof command !== 'string') return allow;
				if (AUTH_FILE.test(command)) return denyWith(POLICY_DENY.authFiles);
				// Same heuristic for the account module's secrets and keys.
				if (scope.shellDenied?.some(s => command.includes(s))) return denyWith(POLICY_DENY.accountSecrets);
				// The host's state: the module overlay is code that runs at the next start, mode.json picks the root.
				if (scope.hostStateDenied?.some(s => command.includes(s))) return denyWith(POLICY_DENY.hostState);
				// The word check also refuses commands that only mention it (heredocs, greps); the sandbox does not.
				if (!hookOpts.procHidden && PROC_ENV.test(command)) return denyWith(POLICY_DENY.procEnv);
				if (usesAgent(command, scope.agentSocket)) return denyWith(POLICY_DENY.sshAgent);
				// And for the project module's data dir, whose state decides which projects are writable.
				if (projectData && command.includes(projectData)) return denyWith(POLICY_DENY.projectState);
				// An older sandbox could still let the command write to a project that is no longer isolated.
				if (hookOpts.beforeBash) {
					try {
						await hookOpts.beforeBash();
					} catch {
						return denyWith(POLICY_DENY.sandbox);
					}
				}
				return allow;
			}
			default: {
				const denial = agentDenial(tool, args);
				return denial ? denyWith(denial) : allow;
			}
		}
	};
}

export const policyHooks = (
	scope: Scope,
	configDir?: string,
	hookOpts: PolicyHookOptions = {},
): {PreToolUse: HookCallbackMatcher[]} => ({
	PreToolUse: [{hooks: [createPolicyHook(scope, configDir, hookOpts)]}],
});
