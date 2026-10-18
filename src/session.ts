import type {Options} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../src/api.js';
import {errClass, noopLog} from './log.js';
import type {QueryFn, TurnResult} from './types.js';

export const AUTH_MESSAGE =
	'Not authenticated. Run "claude auth status", set ANTHROPIC_API_KEY, or run "claude auth key --from-file <path>".';
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
}): Promise<TurnResult> => {
	const {signal, redact} = p;
	const log = p.log ?? noopLog;
	if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);

	let sessionId: string | undefined;
	let model: string | undefined;
	let apiKeySource: string | undefined;
	let numTurns: number | undefined;
	let lastAssistant = '';
	let text: string | undefined;
	let failure: Error | undefined;
	let authFailed = false;

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
				if (msg['error'] === 'authentication_failed') authFailed = true;
				const t = assistantText(msg);
				if (t) lastAssistant = t;
			} else if (type === 'result') {
				sessionId = str(msg['session_id']) ?? sessionId;
				if (typeof msg['num_turns'] === 'number') numTurns = msg['num_turns'];
				if (msg['subtype'] === 'success' && msg['is_error'] !== true) {
					text = str(msg['result']) || lastAssistant;
				} else {
					const errors = Array.isArray(msg['errors']) ? msg['errors'].map(String).join('; ') : '';
					const detail = str(msg['result']) || errors || `${str(msg['subtype']) ?? 'error'}`;
					log.warn('result error', {subtype: str(msg['subtype']), authFailed});
					failure = authFailed ? new Error(AUTH_MESSAGE) : mapFailure(detail, redact);
				}
			}
		}
	} catch (err) {
		log.warn('query threw', {errClass: errClass(err), aborted: signal?.aborted === true});
		if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
		if (failure) throw failure;
		if (authFailed) throw new Error(AUTH_MESSAGE);
		throw mapFailure(err instanceof Error ? err.message : String(err), redact);
	} finally {
		signal?.removeEventListener('abort', onAbort);
		try {
			q.close?.();
		} catch {
			// already closed
		}
	}

	if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
	if (failure) throw failure;
	if (authFailed) throw new Error(AUTH_MESSAGE);
	if (text === undefined || !sessionId) throw new Error('Claude request failed: no result received');
	return {
		sessionId,
		text,
		...(model !== undefined && {model}),
		...(apiKeySource !== undefined && {apiKeySource}),
		...(numTurns !== undefined && {numTurns}),
	};
};
