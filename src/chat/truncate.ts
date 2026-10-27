const RESULT_INPUT_CAP = 64 * 1024;
const RESULT_LINES = 3;
const ARGS_CAP = 100;
export const BLOCK_DISPLAY_CAP = 100 * 1024;
export const LIVE_BUFFER_CAP = 200 * 1024;

export const clampChars = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;

/** First `maxLines` lines, each cut at `maxChars`, plus a "… +N lines (ctrl+o to expand)" footer. */
export const clampLines = (text: string, maxLines: number, maxChars: number): string => {
	const lines = text.split('\n');
	const shown = lines.slice(0, maxLines).map(l => (l.length > maxChars ? `${l.slice(0, maxChars)}…` : l));
	if (lines.length > maxLines) shown.push(`… +${lines.length - maxLines} line${lines.length - maxLines === 1 ? '' : 's'} (ctrl+o to expand)`);
	return shown.join('\n');
};

const one = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

/** Data-only one-line summary (<= 100 chars); callers scrub it. */
export const summarizeArgs = (name: string, input: unknown, cap = ARGS_CAP): string => {
	const rec = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	const pick = (...keys: string[]): string =>
		keys
			.filter(k => rec[k] !== undefined)
			.map(k => (k === keys[0] ? one(rec[k]) : `${k}=${one(rec[k])}`))
			.join(' ');
	let s: string;
	if (name === 'Read') s = pick('file_path', 'offset', 'limit');
	else if (name === 'Grep') s = pick('pattern', 'path', 'glob');
	else if (name === 'Glob') s = pick('pattern', 'path');
	else s = Object.keys(rec).join(', ');
	s = s.replace(/\s+/g, ' ');
	return s.length > cap ? `${s.slice(0, cap - 1)}…` : s;
};

/** Data-only: first 64 KiB, 3 whole lines (the view wraps them), "… +N lines (ctrl+o to expand)". */
export const summarizeResult = (text: string): string =>
	clampLines(text.slice(0, RESULT_INPUT_CAP), RESULT_LINES, Number.POSITIVE_INFINITY);
