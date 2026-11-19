import type {AgentDefinition} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../../src/api.js';
import {AGENT_TOOLS, SPAWN_TOOLS, dropCalls, newTracker, trackEvent, type ChatEvent, type ChatProfile, type ProfileLine} from '../deps/chat.js';
import type {TierMap} from './tiers.js';

export const DEFAULT_TURN_AGENT_CALLS = 3;
export const PERSONAS_HAVE_NO_TOOLS = 'Personas have no tools';
const PERSONA_MAX_TURNS = 3;
const STRIPPED_OPTIONS = ['model', 'effort', 'mode', 'isolation'];
export const WAIT_FOR_USER = "Wait for the user's message";
export const USER_TEXT_CAP = 8000;
export const LINE_TEXT_CAP = 2000;
export const TABLE_LINES = 8;
export const INPUT_CAP = 16 * 1024;
const KEPT_LINES = 16;

const cap = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

// A persona line is one row, so a line break inside it cannot fake another speaker's row.
const LINE_BREAKS = new RegExp('\\s*[\\r\\n\\u0085\\u2028\\u2029]+\\s*', 'g');
const oneRow = (text: string): string => text.replace(LINE_BREAKS, ' / ').trim();

export const composeAgentInput = (userText: string, lines: readonly ProfileLine[], labels: Record<string, string>): string => {
	const head = `The user says:\n${cap(userText, USER_TEXT_CAP)}`;
	const rows = lines.slice(-TABLE_LINES).map(l => `${labels[l.agent] ?? l.agent}: ${cap(oneRow(l.text), LINE_TEXT_CAP)}`);
	const build = () => (rows.length === 0 ? head : `${head}\n\nSaid at the table since then:\n${rows.join('\n')}`);
	while (rows.length > 0 && build().length > INPUT_CAP) rows.shift();
	return build();
};

export type GuardVerdict =
	| {kind: 'allow'}
	| {kind: 'deny'; reason: string}
	| {kind: 'rewrite'; input: Record<string, unknown>};

export type ProfileGuard = {
	observe: (event: ChatEvent) => void;
	inputFor: (tool: string, input: Record<string, unknown>) => Record<string, unknown> | undefined;
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

export const createProfileGuard = (profile: ChatProfile, log?: Logger): ProfileGuard => {
	const names = Object.keys(profile.agents);
	const limit = profile.turnAgentCalls ?? DEFAULT_TURN_AGENT_CALLS;
	const labels = Object.fromEntries(Object.entries(profile.agents).map(([name, a]) => [name, a.label]));
	let calls = 0;
	let tracker = newTracker(profile);
	let userText: string | undefined;
	let lines: ProfileLine[] = [];

	const addressee = (tool: string, input: Record<string, unknown>): string | undefined => {
		const key = SPAWN_TOOLS.has(tool) ? input.subagent_type : tool === 'SendMessage' ? input.to : undefined;
		return typeof key === 'string' && names.includes(key) ? key : undefined;
	};

	const compose = (tool: string, input: Record<string, unknown>): Record<string, string> | undefined => {
		if (profile.agentInput !== 'turn' || userText === undefined) return undefined;
		const to = addressee(tool, input);
		if (to === undefined) return undefined;
		const text = composeAgentInput(userText, lines.filter(l => l.agent !== to), labels);
		log?.debug('profile agent input', {tool, lines: Math.min(lines.length, TABLE_LINES), userChars: userText.length, chars: text.length});
		return {[SPAWN_TOOLS.has(tool) ? 'prompt' : 'message']: text};
	};

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
		observe: event => {
			if (event.type === 'sent') {
				calls = 0;
				userText = event.text;
				lines = [];
			} else if (event.type === 'ui') {
				const step = trackEvent(tracker, event.event);
				tracker = step.t;
				if (step.lines.length > 0) lines = [...lines, ...step.lines].slice(-KEPT_LINES);
			} else if (event.type === 'turn-end' && event.outcome === 'interrupted') {
				tracker = dropCalls(tracker);
			}
		},
		inputFor: (tool, input) => {
			const patch = compose(tool, input);
			return patch && {...input, ...patch};
		},
		preToolUse: (tool, input, agentId) => {
			const denial = staticDenial(tool, input, agentId);
			if (denial !== undefined) return {kind: 'deny', reason: denial};
			if (!AGENT_TOOLS.has(tool)) return {kind: 'allow'};
			if (profile.agentInput === 'turn' && userText === undefined) return {kind: 'deny', reason: WAIT_FOR_USER};
			if (calls >= limit) {
				return {kind: 'deny', reason: `The limit of ${limit} agent calls for this message is reached; answer the user now`};
			}
			calls++;
			if (!SPAWN_TOOLS.has(tool)) {
				const patch = compose(tool, input);
				return patch ? {kind: 'rewrite', input: {...input, ...patch}} : {kind: 'allow'};
			}
			const next: Record<string, unknown> = {...input, name: input.subagent_type, run_in_background: false};
			for (const key of STRIPPED_OPTIONS) delete next[key];
			return {kind: 'rewrite', input: {...next, ...compose(tool, input)}};
		},
		canUse: staticDenial,
	};
};
