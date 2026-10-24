import type {Options} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../src/api.js';
import {classifyFailure, failureMessage, parseRateLimit, systemClock, type Clock, type FailureKind, type RateLimitInfo} from './chat/limits.js';
import {errClass, noopLog} from './log.js';
import type {QueryFn, TurnResult} from './types.js';

export const AUTH_MESSAGE =
	'Not authenticated. Run "claude auth status", "claude auth login", set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>".';
export const RESUME_MESSAGE = 'The stored session no longer exists. Run "claude new" or "claude ask --new <text>".';
export const CANCELLED_MESSAGE = 'Request cancelled';

type Loose = Record<string, unknown>;

const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const assistantText = (msg: Loose): string => {
	const inner = msg['message'];
	if (!isRecord(inner) || !Array.isArray(inner['content'])) return '';
	return inner['content']
		.filter(isRecord)
		.filter(b => b['type'] === 'text')
		.map(b => str(b['text']) ?? '')
		.join('');
};

export class TurnFailure extends Error {
	sessionId?: string;
	model?: string;
	// The last limit report of the turn (its reset time decides how long the account stays aside).
	rateLimit?: RateLimitInfo;
	kind?: FailureKind | 'auth' | 'resume' | 'cancelled' | 'timeout';

	constructor(message: string, kind?: TurnFailure['kind']) {
		super(message);
		if (kind !== undefined) this.kind = kind;
	}
}

export const mapFailure = (raw: string, redact: (s: string) => string): Error => {
	if (/no conversation found/i.test(raw)) return new Error(RESUME_MESSAGE);
	if (/not logged in|login|authenticat|\b401\b|unauthor/i.test(raw)) return new Error(AUTH_MESSAGE);
	return new Error(`Claude request failed: ${redact(raw)}`);
};

export const runTurn = async (p: {
	query: QueryFn;
	prompt: string;
	options: Options;
	signal?: AbortSignal;
	redact: (s: string) => string;
	log?: Logger;
	clock?: Clock;
}): Promise<TurnResult> => {
	const {signal, redact} = p;
	const log = p.log ?? noopLog;
	const clock = p.clock ?? systemClock;
	if (signal?.aborted) throw new TurnFailure(CANCELLED_MESSAGE, 'cancelled');

	let sessionId: string | undefined;
	let model: string | undefined;
	let apiKeySource: string | undefined;
	let numTurns: number | undefined;
	let lastAssistant = '';
	let text: string | undefined;
	let failure: TurnFailure | undefined;
	let authFailed = false;
	let errorCode: string | undefined;
	let errorText: string | undefined;
	let rateLimit: RateLimitInfo | undefined;

	const fail = (e: Error, kind?: TurnFailure['kind']): TurnFailure => {
		const f = e instanceof TurnFailure ? e : new TurnFailure(e.message, kind);
		if (f.kind !== 'resume') {
			if (sessionId !== undefined) f.sessionId = sessionId;
			if (model !== undefined) f.model = model;
		}
		if (rateLimit !== undefined) f.rateLimit = rateLimit;
		return f;
	};

	const q = p.query({prompt: p.prompt, options: p.options});
	const onAbort = () => {
		try {
			q.close?.();
		} catch {
			// closing an already finished query is harmless
		}
	};
	signal?.addEventListener('abort', onAbort, {once: true});

	try {
		for await (const raw of q) {
			const msg = raw as unknown as Loose;
			const type = msg['type'];
			if (type === 'system' && msg['subtype'] === 'init') {
				sessionId = str(msg['session_id']) ?? sessionId;
				model = str(msg['model']) ?? model;
				apiKeySource = str(msg['apiKeySource']) ?? apiKeySource;
			} else if (type === 'assistant') {
				const code = str(msg['error']);
				if (code === 'authentication_failed') authFailed = true;
				const t = assistantText(msg);
				if (code) {
					errorCode = code;
					errorText = t || undefined;
				}
				if (t) lastAssistant = t;
			} else if (type === 'rate_limit_event') {
				rateLimit = parseRateLimit(msg['rate_limit_info'], clock) ?? rateLimit;
			} else if (type === 'result') {
				sessionId = str(msg['session_id']) ?? sessionId;
				if (typeof msg['num_turns'] === 'number') numTurns = msg['num_turns'];
				if (msg['subtype'] === 'success' && msg['is_error'] !== true) {
					text = str(msg['result']) || lastAssistant;
				} else {
					const errors = Array.isArray(msg['errors']) ? msg['errors'].map(String).join('; ') : '';
					const detail = str(msg['result']) || errors || `${str(msg['subtype']) ?? 'error'}`;
					log.warn('result error', {subtype: str(msg['subtype']), authFailed});
					const kind = authFailed
						? undefined
						: classifyFailure({
								...(errorCode !== undefined && {code: errorCode}),
								...(str(msg['terminal_reason']) !== undefined && {terminalReason: str(msg['terminal_reason'])}),
								detail: errorText ?? detail,
								...(rateLimit !== undefined && {rateLimit}),
							});
					if (authFailed) failure = new TurnFailure(AUTH_MESSAGE, 'auth');
					else if (kind) {
						failure = new TurnFailure(
							redact(failureMessage(kind, {
								...(rateLimit !== undefined && {rateLimit}),
								...(errorText !== undefined && {cliText: errorText}),
								surface: 'ask',
								clock,
							})),
							kind,
						);
					} else {
						const mapped = mapFailure(detail, redact);
						failure = new TurnFailure(mapped.message, mapped.message === RESUME_MESSAGE ? 'resume' : undefined);
					}
				}
			}
		}
	} catch (err) {
		log.warn('query threw', {errClass: errClass(err), aborted: signal?.aborted === true});
		if (signal?.aborted) throw fail(new Error(CANCELLED_MESSAGE), 'cancelled');
		if (failure) throw fail(failure);
		if (authFailed) throw fail(new Error(AUTH_MESSAGE), 'auth');
		const mapped = mapFailure(err instanceof Error ? err.message : String(err), redact);
		throw fail(mapped, mapped.message === RESUME_MESSAGE ? 'resume' : undefined);
	} finally {
		signal?.removeEventListener('abort', onAbort);
		try {
			q.close?.();
		} catch {
			// already closed
		}
	}

	if (signal?.aborted) throw fail(new Error(CANCELLED_MESSAGE), 'cancelled');
	if (failure) throw fail(failure);
	if (authFailed) throw fail(new Error(AUTH_MESSAGE), 'auth');
	if (text === undefined || !sessionId) throw fail(new Error('Claude request failed: no result received'));
	return {
		sessionId,
		text,
		...(model !== undefined && {model}),
		...(apiKeySource !== undefined && {apiKeySource}),
		...(numTurns !== undefined && {numTurns}),
	};
};
