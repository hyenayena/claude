// Order matters: string-terminated payload sequences first, then CSI, then the remainder.
const OSC_LIKE = /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const C1_OSC_LIKE = /[\u009d\u0090\u0098\u009e\u009f][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]?/g;
const ESC_TWO = /\u001b[ -~]?/g;
const C1 = /[\u0080-\u009f]/g;
const C0 = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const FORMAT = /(?!‍)\p{Cf}/gu;
const TAGS = /[\u{e0000}-\u{e007f}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const LINE_SEP = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

const strip = (text: string): string =>
	text
		.replace(OSC_LIKE, '')
		.replace(CSI, '')
		.replace(C1_OSC_LIKE, '')
		.replace(C1_CSI, '')
		.replace(ESC_TWO, '')
		.replace(C1, '')
		.replace(C0, '')
		.replace(FORMAT, '')
		.replace(TAGS, '')
		.replace(LONE_SURROGATE, '�');

const newlines = (text: string): string => text.replace(/\r\n?/g, '\n').replace(LINE_SEP, '\n');

// Lone CR is dropped by strip (C0), CRLF is folded first.
export const sanitizeForDisplay = (text: string): string =>
	strip(text.replace(/\r\n/g, '\n').replace(LINE_SEP, '\n')).replace(/\t/g, '    ');

// Keeps \n and \t; CR and CRLF become \n.
export const sanitizeInput = (text: string): string => strip(newlines(text));
