import type {Logger} from '../../../../src/api.js';
import {noopLog} from '../log.js';
import {agentFiles, peekAgentFile} from './agent-defs.js';
import {clampTier, parseTierModel, type TierMap, type TierSpec} from './tiers.js';
import {type Tier} from '../deps/chat.js';

export type AgentRouteCtx = {
	routerOn: boolean;
	rating?: Tier;
	map: TierMap;
	dirs: readonly string[];
	log?: Logger;
};

export async function agentDefinition(type: string, dirs: readonly string[], log: Logger = noopLog): Promise<{tier?: TierSpec; hasModel: boolean} | undefined> {
	for (const dir of dirs) {
		for (const file of await agentFiles(dir)) {
			const peek = await peekAgentFile(file);
			if (!peek || peek.name !== type) continue;
			if (peek.model === undefined) return {hasModel: false};
			const spec = parseTierModel(peek.model);
			if (spec === 'invalid') log.debug('agent tier invalid');
			return spec === undefined || spec === 'invalid' ? {hasModel: true} : {tier: spec, hasModel: false};
		}
	}
	return undefined;
}

export async function routeAgentInput(input: Record<string, unknown>, ctx: AgentRouteCtx): Promise<Record<string, unknown> | undefined> {
	const log = ctx.log ?? noopLog;
	const type = typeof input.subagent_type === 'string' && input.subagent_type !== '' ? input.subagent_type : undefined;
	if (type === 'fork') return undefined;
	const rating = ctx.routerOn ? ctx.rating : undefined;
	let tier: Tier | undefined;
	let source: 'range' | 'fixed' | 'default' | 'rating';
	const def = type === undefined ? undefined : await agentDefinition(type, ctx.dirs, log);
	if (def?.tier) {
		const fixed = def.tier.low === def.tier.high;
		tier = rating !== undefined ? clampTier(rating, def.tier) : def.tier.default;
		source = fixed ? 'fixed' : rating !== undefined ? 'range' : 'default';
	} else if (!ctx.routerOn || def?.hasModel) {
		return undefined;
	} else if (def || type === undefined || type === 'general-purpose') {
		tier = rating;
		source = 'rating';
	} else {
		return undefined;
	}
	if (tier === undefined) return undefined;
	const setting = ctx.map[tier];
	log.info('agent routed', {tier, source});
	return {...input, model: setting.model, ...(setting.effort !== undefined && {effort: setting.effort})};
}
