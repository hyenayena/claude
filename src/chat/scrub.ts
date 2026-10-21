import {sanitizeBlock} from '../kit.js';

export const makeScrub =
	(redact: (s: string) => string) =>
	(s: string): string =>
		redact(sanitizeBlock(s));
