import type {HookCallback, HookCallbackMatcher, HookJSONOutput} from '@anthropic-ai/claude-agent-sdk';
import {classifyEditTarget, createCanUseTool, type Scope} from '../policy.js';
import {POLICY_DENY} from './permission.js';

const allow: HookJSONOutput = {continue: true};

const denyWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
});

/**
 * Hard path policy that holds in every permission mode. In auto mode the classifier can
 * approve a call without asking `canUseTool`, so the checks are repeated here; the hook
 * never allows anything itself, it only denies.
 */
export function createPolicyHook(scope: Scope): HookCallback {
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
				if (cls === 'deny-guard') return denyWith(POLICY_DENY.guard);
				if (cls === 'deny-secret') return denyWith(POLICY_DENY.secret);
				return allow;
			}
			case 'Bash':
				return args.run_in_background || args.dangerouslyDisableSandbox ? denyWith(POLICY_DENY.background) : allow;
			default:
				return allow;
		}
	};
}

export const policyHooks = (scope: Scope): {PreToolUse: HookCallbackMatcher[]} => ({
	PreToolUse: [{hooks: [createPolicyHook(scope)]}],
});
