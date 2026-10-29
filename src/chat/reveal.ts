const LINE_SEP_CHARS = [0x2028, 0x2029];

const OPEN = '\u27e6';
const CLOSE = '\u27e7';

const token = (body: string): string => `${OPEN}${body}${CLOSE}`;

const NAMED: Record<number, string> = {
	0x09: token('⇥'),
	0x0d: token('\\r'),
	0x1b: token('\\x1b'),
	0x7f: token('\\x7f'),
};

const hex = (cp: number): string =>
	token(cp <= 0xff ? `\\x${cp.toString(16).padStart(2, '0')}` : `\\u{${cp.toString(16)}}`);

const isInvisible = (cp: number): boolean =>
	cp === 0x27e6 ||
	cp === 0x27e7 ||
	cp <= 0x08 ||
	(cp >= 0x0b && cp <= 0x1f) ||
	(cp >= 0x7f && cp <= 0x9f) ||
	LINE_SEP_CHARS.includes(cp) ||
	(cp >= 0xe0000 && cp <= 0xe007f);

const FORMAT = /^\p{Cf}$/u;

export const makeReveal =
	(redact: (s: string) => string) =>
	(s: string): string => {
		let out = '';
		for (let i = 0; i < s.length; i++) {
			const code = s.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = s.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					const cp = s.codePointAt(i) as number;
					const ch = String.fromCodePoint(cp);
					i++;
					out += isInvisible(cp) || FORMAT.test(ch) ? hex(cp) : ch;
				} else out += hex(code);
				continue;
			}
			if (code >= 0xdc00 && code <= 0xdfff) {
				out += hex(code);
				continue;
			}
			const ch = s[i] as string;
			if (code === 0x0a) out += ch;
			else if (NAMED[code] !== undefined) out += NAMED[code];
			else if (isInvisible(code) || FORMAT.test(ch)) out += hex(code);
			else out += ch;
		}
		return redact(out);
	};
