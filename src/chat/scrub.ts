import {sanitizeForDisplay} from './sanitize.js';

export const makeScrub =
	(redact: (s: string) => string) =>
	(s: string): string =>
		redact(sanitizeForDisplay(s));
