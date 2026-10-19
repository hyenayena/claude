import {POLICY_DENY} from './permission.js';

export const AGENT_TOOLS = new Set(['Agent', 'Task', 'SendMessage']);

/**
 * Subagents run in this container and this checkout (foreground or background): their own tool calls
 * go through the same prompts and path policy. Returns a denial message, or undefined to allow.
 */
export function agentDenial(toolName: string, input: Record<string, unknown>): string | undefined {
	if (!AGENT_TOOLS.has(toolName)) return undefined;
	if (input.isolation !== undefined && input.isolation !== null && input.isolation !== '') return POLICY_DENY.isolation;
	return undefined;
}
