import {type Clock, formatReset, type LimitType, type RateLimitInfo, systemClock} from '../deps/chat.js';

export type FailureKind = 'usage-limit' | 'rate-limit' | 'billing' | 'context';

const STATUSES = new Set(['allowed', 'allowed_warning', 'rejected']);
const LABELS: Record<LimitType, string> = {
	five_hour: '5-hour limit',
	seven_day: 'weekly limit',
	seven_day_overage_included: 'weekly limit',
	seven_day_opus: 'weekly Opus limit',
	seven_day_sonnet: 'weekly Sonnet limit',
	overage: 'extra usage limit',
};
const DAY_S = 86400;
const CLI_TEXT_CAP = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const parseRateLimit = (raw: unknown, clock: Clock = systemClock): RateLimitInfo | undefined => {
	if (!isRecord(raw)) return undefined;
	const status = raw.status;
	if (typeof status !== 'string' || !STATUSES.has(status)) return undefined;
	const info: RateLimitInfo = { status: status as RateLimitInfo['status'] };
	const nowS = clock.now() / 1000;
	const resetsAt = raw.resetsAt;
	if (typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt >= nowS - DAY_S && resetsAt <= nowS + 60 * DAY_S) {
		info.resetsAt = resetsAt;
	}
	const type = raw.rateLimitType;
	if (typeof type === 'string' && Object.hasOwn(LABELS, type)) info.type = type as LimitType;
	const utilization = raw.utilization;
	if (typeof utilization === 'number' && Number.isFinite(utilization) && utilization >= 0 && utilization <= 10) {
		info.utilization = utilization;
	}
	if (raw.isUsingOverage === true || raw.overageInUse === true) info.usingOverage = true;
	return info;
};

export const classifyFailure = (p: {
	code?: string;
	terminalReason?: string;
	detail?: string;
	rateLimit?: RateLimitInfo;
}): FailureKind | undefined => {
	if (p.code === 'billing_error') return 'billing';
	if (p.code === 'rate_limit') {
		return p.rateLimit?.status === 'rejected' || /hit your limit|usage limit/i.test(p.detail ?? '')
			? 'usage-limit'
			: 'rate-limit';
	}
	if (
		p.terminalReason === 'prompt_too_long' ||
		p.terminalReason === 'blocking_limit' ||
		p.terminalReason === 'rapid_refill_breaker' ||
		/prompt is too long/i.test(p.detail ?? '')
	) {
		return 'context';
	}
	return undefined;
};

const oneLine = (text: string, cap: number): string => {
	const flat = text.replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
	const points = Array.from(flat);
	return points.length > cap ? `${points.slice(0, cap).join('')}…` : flat;
};

export const failureMessage = (
	kind: FailureKind,
	p: { rateLimit?: RateLimitInfo; cliText?: string; surface: 'chat' | 'ask'; clock: Clock },
): string => {
	const chat = p.surface === 'chat';
	switch (kind) {
		case 'usage-limit': {
			const saved = chat
				? 'The chat is saved; send a message after the reset to continue.'
				: 'The session is saved; run "chat ask <text>" after the reset to continue.';
			const info = p.rateLimit;
			if (info?.resetsAt !== undefined) {
				const label = info.type ? ` (${LABELS[info.type]})` : '';
				return `Usage limit reached${label}, resets at ${formatReset(info.resetsAt, p.clock)}. ${saved}`;
			}
			const text = oneLine(p.cliText ?? '', CLI_TEXT_CAP);
			return `Usage limit reached${text ? `: ${text}` : ''}. ${saved}`;
		}
		case 'rate-limit':
			return chat
				? 'Rate limited by the API. Wait a moment, then send again; the chat is saved.'
				: 'Rate limited by the API. Wait a moment, then run the command again; the session is saved.';
		case 'billing':
			return chat
				? 'The account cannot be billed (billing_error). Check the plan or credits, then send again; the chat is saved.'
				: 'The account cannot be billed (billing_error). Check the plan or credits, then run the command again; the session is saved.';
		case 'context': {
			if (!chat) {
				return 'The conversation no longer fits in the model\'s context. Run "chat continue" then "chat compact" to summarise it, or "chat ask --new <text>" to start over. The session is saved.';
			}
			const failed = /automatic compaction failed/i.test(p.cliText ?? '') ? ' Automatic compaction already failed.' : '';
			return `The conversation no longer fits in the model's context. Run "chat compact" in the console to summarise it and continue, or "chat" to start a new chat. The chat is saved.${failed}`;
		}
	}
};
