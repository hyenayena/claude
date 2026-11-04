import {SGR_ATTR, colorDepth, sgrTable} from '../kit.js';

type Table = ReturnType<typeof sgrTable>;

const build = (t: Table) =>
	Object.freeze({
		error: t.error,
		ok: t.ok,
		warn: t.warn,
		accent: t.accent,
		muted: t.muted,
		added: t.added,
		removed: t.removed,
		surface: t.surface,
		codeKeyword: t['code.keyword'],
		codeString: t['code.string'],
		codeNumber: t['code.number'],
		codeComment: t['code.comment'],
		codeFunction: t['code.function'],
		reset: SGR_ATTR.reset,
		bold: SGR_ATTR.bold,
		boldOff: SGR_ATTR.boldOff,
		italic: SGR_ATTR.italic,
		italicOff: SGR_ATTR.italicOff,
		underline: SGR_ATTR.underline,
		underlineOff: SGR_ATTR.underlineOff,
		strike: SGR_ATTR.strike,
		fgOff: SGR_ATTR.fgOff,
	});

export type Sgr = ReturnType<typeof build>;

const bySource = new WeakMap<Table, Sgr>();

// One call per formatting entry point: the kit table is memoized per depth, so this is two reads.
export function sgr(): Sgr {
	const table = sgrTable(colorDepth());
	let s = bySource.get(table);
	if (!s) bySource.set(table, (s = build(table)));
	return s;
}
