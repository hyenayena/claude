export type LimitType =
	| 'five_hour'
	| 'seven_day'
	| 'seven_day_opus'
	| 'seven_day_sonnet'
	| 'seven_day_overage_included'
	| 'overage';

export type RateLimitInfo = {
	status: 'allowed' | 'allowed_warning' | 'rejected';
	resetsAt?: number;
	type?: LimitType;
	utilization?: number;
	usingOverage?: boolean;
};

export type Clock = { now: () => number; timeZone?: string };

export const systemClock: Clock = { now: () => Date.now() };

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
const SHORT_LABELS: Record<LimitType, string> = {
	five_hour: '5h limit',
	seven_day: 'weekly limit',
	seven_day_overage_included: 'weekly limit',
	seven_day_opus: 'weekly Opus limit',
	seven_day_sonnet: 'weekly Sonnet limit',
	overage: 'extra usage',
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

const zoneOf = (clock: Clock): string => {
	const candidate = clock.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	try {
		new Intl.DateTimeFormat('en-GB', { timeZone: candidate });
		return candidate;
	} catch {
		return 'UTC';
	}
};

const timeText = (ms: number, zone: string): string =>
	new Intl.DateTimeFormat('en-GB', { hourCycle: 'h23', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(ms);

const dayKey = (ms: number, zone: string): string =>
	new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: zone }).format(ms);

const dateText = (ms: number, zone: string): string =>
	new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(ms);

const clockText = (resetsAt: number, clock: Clock, zone: string): string => {
	const ms = resetsAt * 1000;
	const time = timeText(ms, zone);
	return dayKey(ms, zone) === dayKey(clock.now(), zone) ? time : `${dateText(ms, zone)}, ${time}`;
};

const relative = (resetsAt: number, clock: Clock): string => {
	const diff = resetsAt - clock.now() / 1000;
	if (diff <= 0) return 'now';
	const minutes = Math.ceil(diff / 60);
	if (minutes < 60) return `in ${minutes}m`;
	if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `in ${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
};

export const formatReset = (resetsAt: number, clock: Clock): string => {
	const zone = zoneOf(clock);
	return `${clockText(resetsAt, clock, zone)} ${zone} (${relative(resetsAt, clock)})`;
};

export const limitIndicator = (info: RateLimitInfo | undefined, clock: Clock): string | undefined => {
	if (!info || info.status === 'allowed') return undefined;
	if (info.resetsAt !== undefined && clock.now() >= info.resetsAt * 1000) return undefined;
	const label = info.type ? SHORT_LABELS[info.type] : 'usage limit';
	const zone = zoneOf(clock);
	const resets = info.resetsAt === undefined ? '' : ` · resets ${clockText(info.resetsAt, clock, zone)}`;
	if (info.status === 'allowed_warning') {
		const pct =
			info.utilization === undefined ? '' : ` ${Math.min(999, Math.max(0, Math.round(info.utilization * 100)))}%`;
		return `${label}${pct}${resets}`;
	}
	return info.usingOverage ? `${label} reached · extra usage` : `${label} reached${resets}`;
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
				: 'The session is saved; run "claude ask <text>" after the reset to continue.';
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
				return 'The conversation no longer fits in the model\'s context. Run "claude chat" then "claude compact" to summarise it, or "claude ask --new <text>" to start over. The session is saved.';
			}
			const failed = /automatic compaction failed/i.test(p.cliText ?? '') ? ' Automatic compaction already failed.' : '';
			return `The conversation no longer fits in the model's context. Run "claude compact" in the console to summarise it and continue, or "chat" to start a new chat. The chat is saved.${failed}`;
		}
	}
};
