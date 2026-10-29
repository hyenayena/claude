const ARGS_CAP = 100;
export const BLOCK_DISPLAY_CAP = 100 * 1024;
export const LIVE_BUFFER_CAP = 200 * 1024;

export const clampChars = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;

const one = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');

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
