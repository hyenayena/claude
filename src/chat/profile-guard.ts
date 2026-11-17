import type {AgentDefinition} from '@anthropic-ai/claude-agent-sdk';
import {AGENT_TOOLS, SPAWN_TOOLS, type ChatProfile} from '../deps/chat.js';
import type {TierMap} from './tiers.js';

export const DEFAULT_TURN_AGENT_CALLS = 3;
export const PERSONAS_HAVE_NO_TOOLS = 'Personas have no tools';
const PERSONA_MAX_TURNS = 3;
const STRIPPED_OPTIONS = ['model', 'effort', 'mode', 'isolation'];

export type GuardVerdict =
	| {kind: 'allow'}
	| {kind: 'deny'; reason: string}
	| {kind: 'rewrite'; input: Record<string, unknown>};

export type ProfileGuard = {
	newUserMessage: () => void;
	preToolUse: (tool: string, input: Record<string, unknown>, agentId?: string) => GuardVerdict;
	canUse: (tool: string, input: Record<string, unknown>, agentId?: string) => string | undefined;
};

export const profileAgents = (profile: ChatProfile, map: TierMap): Record<string, AgentDefinition> =>
	Object.fromEntries(
		Object.entries(profile.agents).map(([name, agent]) => [
			name,
			{
				description: agent.description,
				prompt: agent.prompt,
				tools: [],
				disallowedTools: ['mcp__*'],
				model: map[agent.tier ?? 'light'].model,
				maxTurns: PERSONA_MAX_TURNS,
			},
		]),
	);

export const createProfileGuard = (profile: ChatProfile): ProfileGuard => {
	const names = Object.keys(profile.agents);
	const limit = profile.turnAgentCalls ?? DEFAULT_TURN_AGENT_CALLS;
	let calls = 0;

	const staticDenial = (tool: string, input: Record<string, unknown>, agentId: string | undefined): string | undefined => {
		if (agentId !== undefined) return PERSONAS_HAVE_NO_TOOLS;
		const listed = profile.mainTools.includes(tool) || (SPAWN_TOOLS.has(tool) && profile.mainTools.some(t => SPAWN_TOOLS.has(t)));
		if (!listed) return `This chat's tools are limited to ${profile.mainTools.join(', ')}`;
		if (SPAWN_TOOLS.has(tool) && !(typeof input.subagent_type === 'string' && names.includes(input.subagent_type))) {
			return `Only these agents are available: ${names.join(', ')}`;
		}
		if (tool === 'SendMessage' && !(typeof input.to === 'string' && names.includes(input.to))) {
			return `Only these agents are available: ${names.join(', ')}`;
		}
		return undefined;
	};

	return {
		newUserMessage: () => {
			calls = 0;
		},
		preToolUse: (tool, input, agentId) => {
			const denial = staticDenial(tool, input, agentId);
			if (denial !== undefined) return {kind: 'deny', reason: denial};
			if (!AGENT_TOOLS.has(tool)) return {kind: 'allow'};
			if (calls >= limit) {
				return {kind: 'deny', reason: `The limit of ${limit} agent calls for this message is reached; answer the user now`};
			}
			calls++;
			if (!SPAWN_TOOLS.has(tool)) return {kind: 'allow'};
			const next: Record<string, unknown> = {...input, name: input.subagent_type, run_in_background: false};
			for (const key of STRIPPED_OPTIONS) delete next[key];
			return {kind: 'rewrite', input: next};
		},
		canUse: staticDenial,
	};
};
