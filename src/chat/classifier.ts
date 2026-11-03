import {randomUUID} from 'node:crypto';
import type {Options, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {Logger} from '../../../../src/api.js';
import {errClass} from '../log.js';
import type {ChatQueryFn} from '../types.js';
import {parseVerdict, type Verdict} from './router.js';

export const ROUTE_TIMEOUT_MS = 6000;
const RESULT_CAP = 400;

export type ClassifyResult =
	| {ok: true; verdict: Verdict; ms: number; tokens: {in: number; out: number}}
	| {ok: false; reason: 'timeout' | 'error' | 'invalid' | 'aborted'; ms: number};

export type Classifier = {classify(prompt: string, signal?: AbortSignal): Promise<ClassifyResult>};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

async function* once(text: string): AsyncIterable<SDKUserMessage> {
	yield {
		type: 'user',
		message: {role: 'user', content: text},
		parent_tool_use_id: null,
		uuid: randomUUID(),
		session_id: '',
	};
}

export function createClassifier(p: {query: ChatQueryFn; options: () => Options; log: Logger; timeoutMs?: number}): Classifier {
	const timeoutMs = p.timeoutMs ?? ROUTE_TIMEOUT_MS;
	return {
		async classify(prompt, signal) {
			const started = Date.now();
			const ms = (): number => Date.now() - started;
			if (signal?.aborted) return {ok: false, reason: 'aborted', ms: 0};
			let q: ReturnType<ChatQueryFn> | undefined;
			let stop: ((reason: 'timeout' | 'aborted') => void) | undefined;
			const stopped = new Promise<'timeout' | 'aborted'>(resolve => {
				stop = resolve;
			});
			const onAbort = (): void => stop?.('aborted');
			signal?.addEventListener('abort', onAbort, {once: true});
			const timer = setTimeout(() => stop?.('timeout'), timeoutMs);
			timer.unref?.();
			const run = async (): Promise<{text: string; tokens: {in: number; out: number}} | 'error'> => {
				q = p.query({prompt: once(prompt), options: p.options()});
				for await (const msg of q) {
					const m = msg as unknown;
					if (!isRec(m) || m['type'] !== 'result') continue;
					if (m['subtype'] !== 'success' || typeof m['result'] !== 'string') return 'error';
					const usage = isRec(m['usage']) ? m['usage'] : {};
					return {
						text: m['result'].slice(0, RESULT_CAP),
						tokens: {in: count(usage['input_tokens']) + count(usage['cache_read_input_tokens']) + count(usage['cache_creation_input_tokens']), out: count(usage['output_tokens'])},
					};
				}
				return 'error';
			};
			try {
				const running = run();
				running.catch(() => {});
				const outcome = await Promise.race([running, stopped]);
				if (outcome === 'timeout' || outcome === 'aborted') return {ok: false, reason: outcome, ms: ms()};
				if (outcome === 'error') return {ok: false, reason: 'error', ms: ms()};
				const verdict = parseVerdict(outcome.text);
				if (!verdict) return {ok: false, reason: 'invalid', ms: ms()};
				return {ok: true, verdict, ms: ms(), tokens: outcome.tokens};
			} catch (err) {
				p.log.debug('classifier failed', {errClass: errClass(err)});
				return {ok: false, reason: signal?.aborted ? 'aborted' : 'error', ms: ms()};
			} finally {
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				try {
					q?.close?.();
				} catch {
				}
			}
		},
	};
}
