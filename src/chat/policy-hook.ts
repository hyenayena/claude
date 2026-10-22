import type {HookCallback, HookCallbackMatcher, HookJSONOutput} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import {classifyEditTarget, createCanUseTool, PLANS_DIR, resolveReal, type Scope} from '../policy.js';
import {agentDenial} from './agent-policy.js';
import {POLICY_DENY} from './permission.js';

// Heuristic that over-denies on purpose: a shell command naming an auth file is refused in every mode.
const AUTH_FILE = /credentials\.json|\.claude\.json|config\/backups/;

const allow: HookJSONOutput = {continue: true};

const denyWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
});

/**
 * Hard path policy that holds in every permission mode. In auto mode the classifier can
 * approve a call without asking `canUseTool`, so the checks are repeated here; the hook
 * never allows anything itself, it only denies.
 */
export function createPolicyHook(scope: Scope, configDir?: string): HookCallback {
	const config = configDir ? path.resolve(configDir) : undefined;
	const plans = config ? path.join(config, PLANS_DIR) : undefined;
	const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
	const readTool = createCanUseTool(scope);
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
				// The Claude config is not Claude's to change, except the plan files plan mode writes.
				if (config && plans) {
					const target = await resolveReal(path.resolve(scope.roots[0] ?? '/', args.file_path)).catch(() => undefined);
					const realConfig = await resolveReal(config).catch(() => config);
					if (target === undefined) return denyWith(POLICY_DENY.outside);
					if (inside(target, realConfig) && !inside(target, path.join(realConfig, PLANS_DIR))) return denyWith(POLICY_DENY.guard);
				}
				if (cls === 'deny-guard') return denyWith(POLICY_DENY.guard);
				if (cls === 'deny-secret') return denyWith(POLICY_DENY.secret);
				return allow;
			}
			case 'Bash':
				if (args.dangerouslyDisableSandbox) return denyWith(POLICY_DENY.background);
				return typeof args.command === 'string' && AUTH_FILE.test(args.command) ? denyWith(POLICY_DENY.authFiles) : allow;
			default: {
				const denial = agentDenial(tool, args);
				return denial ? denyWith(denial) : allow;
			}
		}
	};
}

export const policyHooks = (scope: Scope, configDir?: string): {PreToolUse: HookCallbackMatcher[]} => ({
	PreToolUse: [{hooks: [createPolicyHook(scope, configDir)]}],
});
