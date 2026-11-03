import type {Effort} from '../chat-prefs.js';
import type {ClaudeState} from '../types.js';

export const TIERS = ['light', 'standard', 'strong', 'max'] as const;
export type Tier = (typeof TIERS)[number];

export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
export const tierRank = (t: Tier): number => TIERS.indexOf(t);
export const maxTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b);

export type TierRange = {low: Tier; high: Tier};

export const clampTier = (t: Tier, r: TierRange): Tier =>
	tierRank(t) < tierRank(r.low) ? r.low : tierRank(t) > tierRank(r.high) ? r.high : t;

export type TierSpec = TierRange & {default: Tier};

const MAX_ENTRIES = TIERS.length;

export function parseTierModel(value: string): TierSpec | 'invalid' | undefined {
	const raw = value.trim();
	const parts = raw.split('/').map(p => p.trim());
	if (parts.length === 1) {
		const one = parts[0]!.toLowerCase();
		return isTier(one) ? {low: one, high: one, default: one} : undefined;
	}
	if (parts.length > MAX_ENTRIES || parts.some(p => p === '')) return 'invalid';
	const tiers = parts.map(p => p.toLowerCase());
	if (!tiers.every(isTier)) return 'invalid';
	for (let i = 1; i < tiers.length; i++) if (tierRank(tiers[i] as Tier) <= tierRank(tiers[i - 1] as Tier)) return 'invalid';
	const caps = parts.map((p, i) => (p === p.toUpperCase() ? i : -1)).filter(i => i >= 0);
	if (caps.length > 1) return 'invalid';
	const at = caps[0] ?? (tiers.length === 2 ? 0 : 1);
	return {low: tiers[0] as Tier, high: tiers.at(-1) as Tier, default: tiers[at] as Tier};
}

export const TIER_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type TierModel = (typeof TIER_MODELS)[number];
export const isTierModel = (v: unknown): v is TierModel => TIER_MODELS.includes(v as TierModel);

export type TierSetting = {model: TierModel; effort?: Effort};
export type TierMap = Record<Tier, TierSetting>;

export const DEFAULT_TIERS: TierMap = {
	light: {model: 'haiku', effort: 'medium'},
	standard: {model: 'sonnet', effort: 'medium'},
	strong: {model: 'opus', effort: 'medium'},
	max: {model: 'opus', effort: 'high'},
};

export const TIER_STATE_KEYS = {
	light: {model: 'tierLightModel', effort: 'tierLightEffort'},
	standard: {model: 'tierStandardModel', effort: 'tierStandardEffort'},
	strong: {model: 'tierStrongModel', effort: 'tierStrongEffort'},
	max: {model: 'tierMaxModel', effort: 'tierMaxEffort'},
} as const satisfies Record<Tier, {model: keyof ClaudeState; effort: keyof ClaudeState}>;

export function tierMapFromState(state: ClaudeState): TierMap {
	const out = {} as TierMap;
	for (const t of TIERS) {
		const keys = TIER_STATE_KEYS[t];
		const model = state[keys.model] ?? DEFAULT_TIERS[t].model;
		const effort = state[keys.effort] ?? DEFAULT_TIERS[t].effort;
		out[t] = {model, ...(effort !== undefined && {effort})};
	}
	return out;
}
