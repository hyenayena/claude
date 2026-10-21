import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	classifyFailure,
	failureMessage,
	formatReset,
	limitIndicator,
	parseRateLimit,
	systemClock,
	type Clock,
	type RateLimitInfo,
} from '../../src/chat/limits.js';

const NOW = Date.UTC(2026, 9, 21, 12, 46, 0);
const at = (iso: string): number => Date.parse(iso) / 1000;
const clock = (timeZone?: string, now = NOW): Clock => ({ now: () => now, timeZone });

describe('parseRateLimit', () => {
	it('parses a full valid object', () => {
		const resetsAt = NOW / 1000 + 3600;
		assert.deepEqual(
			parseRateLimit(
				{ status: 'allowed_warning', resetsAt, rateLimitType: 'five_hour', utilization: 0.85, isUsingOverage: false, extra: 1 },
				clock(),
			),
			{ status: 'allowed_warning', resetsAt, type: 'five_hour', utilization: 0.85 },
		);
	});

	it('sets usingOverage from either flag', () => {
		assert.equal(parseRateLimit({ status: 'rejected', isUsingOverage: true }, clock())?.usingOverage, true);
		assert.equal(parseRateLimit({ status: 'rejected', overageInUse: true }, clock())?.usingOverage, true);
		assert.equal(parseRateLimit({ status: 'rejected' }, clock())?.usingOverage, undefined);
	});

	it('rejects non-records and bad status', () => {
		for (const v of [undefined, null, 'x', 5, [], { status: 'nope' }, { status: 3 }, {}]) {
			assert.equal(parseRateLimit(v, clock()), undefined);
		}
	});

	it('drops out-of-range fields', () => {
		const now = NOW / 1000;
		const base = { status: 'rejected' };
		assert.equal(parseRateLimit({ ...base, resetsAt: now - 2 * 86400 }, clock())?.resetsAt, undefined);
		assert.equal(parseRateLimit({ ...base, resetsAt: now + 61 * 86400 }, clock())?.resetsAt, undefined);
		assert.equal(parseRateLimit({ ...base, resetsAt: Number.NaN }, clock())?.resetsAt, undefined);
		assert.equal(parseRateLimit({ ...base, resetsAt: '5' }, clock())?.resetsAt, undefined);
		assert.equal(parseRateLimit({ ...base, resetsAt: now - 3600 }, clock())?.resetsAt, now - 3600);
		assert.equal(parseRateLimit({ ...base, utilization: 11 }, clock())?.utilization, undefined);
		assert.equal(parseRateLimit({ ...base, utilization: -1 }, clock())?.utilization, undefined);
		assert.equal(parseRateLimit({ ...base, utilization: Infinity }, clock())?.utilization, undefined);
		assert.equal(parseRateLimit({ ...base, utilization: 1.2 }, clock())?.utilization, 1.2);
		assert.equal(parseRateLimit({ ...base, rateLimitType: 'bogus' }, clock())?.type, undefined);
		assert.equal(parseRateLimit({ ...base, rateLimitType: 'toString' }, clock())?.type, undefined);
	});

	it('uses the system clock by default', () => {
		const info = parseRateLimit({ status: 'rejected', resetsAt: Date.now() / 1000 + 60 });
		assert.ok(info?.resetsAt);
		assert.equal(typeof systemClock.now(), 'number');
	});
});

describe('classifyFailure', () => {
	const rejected: RateLimitInfo = { status: 'rejected' };
	it('billing', () => assert.equal(classifyFailure({ code: 'billing_error' }), 'billing'));
	it('rate_limit with rejected info is a usage limit', () =>
		assert.equal(classifyFailure({ code: 'rate_limit', rateLimit: rejected }), 'usage-limit'));
	it('rate_limit with limit text is a usage limit', () => {
		assert.equal(classifyFailure({ code: 'rate_limit', detail: "You've hit your limit · resets 3pm" }), 'usage-limit');
		assert.equal(classifyFailure({ code: 'rate_limit', detail: 'Usage limit reached' }), 'usage-limit');
	});
	it('plain rate_limit is a rate limit', () => {
		assert.equal(classifyFailure({ code: 'rate_limit' }), 'rate-limit');
		assert.equal(
			classifyFailure({ code: 'rate_limit', detail: 'Request rejected (429)', rateLimit: { status: 'allowed' } }),
			'rate-limit',
		);
	});
	it('context terminal reasons', () => {
		for (const terminalReason of ['prompt_too_long', 'blocking_limit', 'rapid_refill_breaker']) {
			assert.equal(classifyFailure({ terminalReason }), 'context');
		}
	});
	it('context by detail', () =>
		assert.equal(classifyFailure({ code: 'invalid_request', detail: 'Prompt is too long' }), 'context'));
	it('billing wins over context, other is undefined', () => {
		assert.equal(classifyFailure({ code: 'billing_error', terminalReason: 'blocking_limit' }), 'billing');
		assert.equal(classifyFailure({ code: 'server_error' }), undefined);
		assert.equal(classifyFailure({}), undefined);
	});
});

describe('formatReset', () => {
	it('same day in UTC', () => {
		assert.equal(formatReset(at('2026-10-21T15:00:00Z'), clock('UTC')), '15:00 UTC (in 2h 14m)');
	});
	it('next day adds the date', () => {
		assert.equal(formatReset(at('2026-10-23T15:00:00Z'), clock('UTC')), 'Oct 23, 15:00 UTC (in 2d 2h)');
	});
	it('uses the zone for the calendar day', () => {
		assert.equal(formatReset(at('2026-10-21T22:00:00Z'), clock('Etc/GMT-3')), 'Oct 22, 01:00 Etc/GMT-3 (in 9h 14m)');
		assert.equal(formatReset(at('2026-10-21T13:00:00Z'), clock('Etc/GMT-3')), '16:00 Etc/GMT-3 (in 14m)');
	});
	it('relative boundaries', () => {
		const rel = (s: number): string => formatReset(NOW / 1000 + s, clock('UTC')).replace(/^.*\(|\)$/g, '');
		assert.equal(rel(59 * 60), 'in 59m');
		assert.equal(rel(60 * 60), 'in 1h 0m');
		assert.equal(rel(24 * 3600 - 60), 'in 23h 59m');
		assert.equal(rel(24 * 3600), 'in 1d 0h');
		assert.equal(rel(30), 'in 1m');
	});
	it('past is now', () => {
		assert.equal(formatReset(at('2026-10-21T10:00:00Z'), clock('UTC')), '10:00 UTC (now)');
	});
	it('invalid zone falls back to UTC', () => {
		assert.equal(formatReset(at('2026-10-21T15:00:00Z'), clock('Not/AZone')), '15:00 UTC (in 2h 14m)');
	});
	it('defaults to the resolved zone', () => {
		assert.match(formatReset(at('2026-10-21T15:00:00Z'), clock()), /^\S.* \S+ \(in 2h 14m\)$/);
	});
});

describe('limitIndicator', () => {
	const c = clock('UTC');
	const reset = at('2026-10-21T15:00:00Z');
	it('hidden for allowed or missing', () => {
		assert.equal(limitIndicator(undefined, c), undefined);
		assert.equal(limitIndicator({ status: 'allowed', resetsAt: reset }, c), undefined);
	});
	it('warning', () => {
		assert.equal(
			limitIndicator({ status: 'allowed_warning', type: 'five_hour', utilization: 0.854, resetsAt: reset }, c),
			'5h limit 85% · resets 15:00',
		);
		assert.equal(limitIndicator({ status: 'allowed_warning', type: 'five_hour' }, c), '5h limit');
		assert.equal(limitIndicator({ status: 'allowed_warning', utilization: 50 }, c), 'usage limit 999%');
	});
	it('rejected', () => {
		assert.equal(limitIndicator({ status: 'rejected', type: 'five_hour', resetsAt: reset }, c), '5h limit reached · resets 15:00');
		assert.equal(
			limitIndicator({ status: 'rejected', type: 'five_hour', resetsAt: reset, usingOverage: true }, c),
			'5h limit reached · extra usage',
		);
		assert.equal(limitIndicator({ status: 'rejected', resetsAt: reset }, c), 'usage limit reached · resets 15:00');
		assert.equal(
			limitIndicator({ status: 'rejected', type: 'seven_day_opus', resetsAt: at('2026-10-23T09:00:00Z') }, c),
			'weekly Opus limit reached · resets Oct 23, 09:00',
		);
	});
	it('expires at the reset time', () => {
		const info: RateLimitInfo = { status: 'rejected', type: 'five_hour', resetsAt: reset };
		assert.ok(limitIndicator(info, clock('UTC', reset * 1000 - 1)));
		assert.equal(limitIndicator(info, clock('UTC', reset * 1000)), undefined);
	});
});

describe('failureMessage', () => {
	const c = clock('UTC');
	const info: RateLimitInfo = { status: 'rejected', type: 'five_hour', resetsAt: at('2026-10-21T15:00:00Z') };
	it('usage limit with info', () => {
		assert.equal(
			failureMessage('usage-limit', { rateLimit: info, surface: 'chat', clock: c }),
			'Usage limit reached (5-hour limit), resets at 15:00 UTC (in 2h 14m). The chat is saved; send a message after the reset to continue.',
		);
		assert.equal(
			failureMessage('usage-limit', { rateLimit: { ...info, type: undefined }, surface: 'ask', clock: c }),
			'Usage limit reached, resets at 15:00 UTC (in 2h 14m). The session is saved; run "claude ask <text>" after the reset to continue.',
		);
	});
	it('usage limit without info collapses and caps CLI text', () => {
		assert.equal(
			failureMessage('usage-limit', { cliText: "You've hit your limit\n· resets 3pm.", surface: 'chat', clock: c }),
			"Usage limit reached: You've hit your limit · resets 3pm. The chat is saved; send a message after the reset to continue.",
		);
		const long = failureMessage('usage-limit', { cliText: 'x'.repeat(500), surface: 'chat', clock: c });
		assert.ok(long.startsWith(`Usage limit reached: ${'x'.repeat(200)}…. `));
		assert.equal(
			failureMessage('usage-limit', { surface: 'chat', clock: c }),
			'Usage limit reached. The chat is saved; send a message after the reset to continue.',
		);
	});
	it('rate limit and billing', () => {
		assert.equal(
			failureMessage('rate-limit', { surface: 'chat', clock: c }),
			'Rate limited by the API. Wait a moment, then send again; the chat is saved.',
		);
		assert.equal(
			failureMessage('rate-limit', { surface: 'ask', clock: c }),
			'Rate limited by the API. Wait a moment, then run the command again; the session is saved.',
		);
		assert.equal(
			failureMessage('billing', { surface: 'chat', clock: c }),
			'The account cannot be billed (billing_error). Check the plan or credits, then send again; the chat is saved.',
		);
		assert.match(failureMessage('billing', { surface: 'ask', clock: c }), /run the command again; the session is saved\.$/);
	});
	it('context', () => {
		const chat = failureMessage('context', { surface: 'chat', clock: c });
		assert.equal(
			chat,
			'The conversation no longer fits in the model\'s context. Run "claude compact" in the console to summarise it and continue, or "chat" to start a new chat. The chat is saved.',
		);
		const failed = failureMessage('context', {
			cliText: 'Prompt is too long · automatic compaction failed: boom',
			surface: 'chat',
			clock: c,
		});
		assert.ok(failed.endsWith('The chat is saved. Automatic compaction already failed.'));
		assert.ok(!failed.includes('boom'));
		assert.equal(
			failureMessage('context', { surface: 'ask', clock: c }),
			'The conversation no longer fits in the model\'s context. Run "claude chat" then "claude compact" to summarise it, or "claude ask --new <text>" to start over. The session is saved.',
		);
	});
});
