import type {HookCallback, HookCallbackMatcher, HookJSONOutput} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import {classifyEditTarget, createCanUseTool, isAskFile, PLANS_DIR, resolveReal, type Scope} from '../policy.js';
import {agentDenial} from './agent-policy.js';
import {addsPrivilegedFrontmatter, isDefinitionPath} from './definition-guard.js';
import {POLICY_ASK, POLICY_DENY} from './permission.js';

const AUTH_FILE = /credentials\.json|\.claude\.json|config\/backups|accounts\.json|claude\/accounts\b|claude\/auth\.json/;

const AGENT_VAR = /\bSSH_AUTH_SOCK\b|\bssh-add\b/;
const usesAgent = (command: string, socket: string | undefined): boolean =>
	AGENT_VAR.test(command) || (socket !== undefined && socket !== '' && (command.includes(socket) || command.includes(path.dirname(socket) + '/')));

const PROC_ENV = /\benviron\b/;

const allow: HookJSONOutput = {continue: true};

const denyWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
});

const askWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason},
});

export const WEB_KEY_PREFIX = 'web:';
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
	approved?: (key: string) => boolean;
	beforeBash?: () => Promise<void>;
	procHidden?: boolean;
};

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
				if (config && plans) {
					const target = await resolveReal(path.resolve(scope.roots[0] ?? '/', args.file_path)).catch(() => undefined);
					const realConfig = await resolveReal(config).catch(() => config);
					if (target === undefined) return denyWith(POLICY_DENY.outside);
					if (inside(target, realConfig) && !inside(target, path.join(realConfig, PLANS_DIR))) return denyWith(POLICY_DENY.guard);
				}
				if (cls === 'deny-guard') return denyWith(POLICY_DENY.guard);
				if (cls === 'deny-secret') return denyWith(POLICY_DENY.secret);
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
				if (scope.shellDenied?.some(s => command.includes(s))) return denyWith(POLICY_DENY.accountSecrets);
				if (scope.hostStateDenied?.some(s => command.includes(s))) return denyWith(POLICY_DENY.hostState);
				if (!hookOpts.procHidden && PROC_ENV.test(command)) return denyWith(POLICY_DENY.procEnv);
				if (usesAgent(command, scope.agentSocket)) return denyWith(POLICY_DENY.sshAgent);
				if (projectData && command.includes(projectData)) return denyWith(POLICY_DENY.projectState);
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
