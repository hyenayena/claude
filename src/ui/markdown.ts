import {matchTable, renderTable} from './markdown-table.js';

// Terminal styling for Claude's Markdown. Input is already scrubbed (no escapes); the output adds
// only constant SGR codes. It is a light reading aid, not a full CommonMark renderer.

const S = {
	reset: '\u001b[0m',
	dim: '\u001b[2m',
	bold: '\u001b[1m',
	italic: '\u001b[3m',
	underline: '\u001b[4m',
	green: '\u001b[32m',
	cyan: '\u001b[36m',
	yellow: '\u001b[33m',
	magenta: '\u001b[35m',
	blue: '\u001b[34m',
	boldOff: '\u001b[22m',
	italicOff: '\u001b[23m',
	underlineOff: '\u001b[24m',
	fgOff: '\u001b[39m',
} as const;

const KEYWORDS = new Set(
	(
		'abstract as async await break case catch class const continue def default defer del delete do elif else enum ' +
		'export extends false final finally fn for from func function go if impl implements import in instanceof interface ' +
		'is lambda let loop match mod module mut new nil none null of package pass private protected pub public raise ' +
		'readonly return self static struct super switch this throw throws trait true try type typeof undefined use var ' +
		'void while with yield fi then done esac echo local export'
	).split(' '),
);

// One token per match: comment, string, number, word.
const TOKEN = /(\/\/.*$|#.*$|--\s.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)/g;

function highlightLine(line: string, lang: string): string {
	const hashComments = /^(py|python|sh|bash|zsh|shell|yaml|yml|toml|rb|ruby|r|make|makefile|dockerfile|conf|ini)$/i.test(lang);
	return line.replace(TOKEN, (m, comment: string | undefined, str: string | undefined, num: string | undefined, word: string | undefined) => {
		if (comment !== undefined) {
			if (comment.startsWith('#') && !hashComments) return m;
			return `${S.dim}${comment}${S.reset}`;
		}
		if (str !== undefined) return `${S.green}${str}${S.fgOff}`;
		if (num !== undefined) return `${S.yellow}${num}${S.fgOff}`;
		if (word !== undefined && KEYWORDS.has(word)) return `${S.magenta}${word}${S.fgOff}`;
		return m;
	});
}

function inline(text: string): string {
	// Code spans first, kept out of the other rules by placeholders.
	const spans: string[] = [];
	let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
		spans.push(`${S.cyan}${code}${S.fgOff}`);
		return `\u0000${spans.length - 1}\u0000`;
	});
	out = out
		.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_m, a?: string, b?: string) => `${S.bold}${a ?? b}${S.boldOff}`)
		.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, (_m, pre: string, t: string) => `${pre}${S.italic}${t}${S.italicOff}`)
		.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => `${S.underline}${label}${S.underlineOff}${S.dim} (${url})${S.reset}`);
	return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? '');
}

const DEFAULT_WIDTH = 100;

export type CodeBlock = {header: number; code: string};

export type MarkdownOptions = {width?: number; copyLabel?: boolean};

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	return renderMarkdownBlocks(text, options).text;
}

/**
 * The rendered text and its fenced code blocks: the index of each header line in the output and the
 * code as written. With `copyLabel` a header of a non-empty block ends with "· copy".
 */
export function renderMarkdownBlocks(text: string, options: MarkdownOptions = {}): {text: string; codeBlocks: CodeBlock[]} {
	const width = options.width !== undefined && Number.isFinite(options.width) ? options.width : DEFAULT_WIDTH;
	const out: string[] = [];
	let fence: {lang: string; marker: string; header: number; code: string[]} | undefined;
	const codeBlocks: CodeBlock[] = [];
	const header = (lang: string, copy: boolean) =>
		`${S.dim}╭─${lang ? ` ${lang}` : ''}${copy ? ` · ${S.reset}${S.underline}copy${S.underlineOff}` : ''}${S.reset}`;
	const closeFence = (f: NonNullable<typeof fence>) => {
		out.push(`${S.dim}╰─${S.reset}`);
		if (f.code.length === 0) return;
		codeBlocks.push({header: f.header, code: f.code.join('\n')});
		if (options.copyLabel) out[f.header] = header(f.lang, true);
	};
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const open = FENCE.exec(line);
		if (fence) {
			if (open && open[1]!.startsWith(fence.marker[0]!) && open[1]!.length >= fence.marker.length && open[2] === '') {
				closeFence(fence);
				fence = undefined;
			} else {
				fence.code.push(line);
				out.push(`${S.dim}│${S.reset} ${highlightLine(line, fence.lang)}`);
			}
			continue;
		}
		if (open) {
			fence = {lang: open[2] ?? '', marker: open[1]!, header: out.length, code: []};
			out.push(header(fence.lang, false));
			continue;
		}
		const table = matchTable(lines, i);
		if (table) {
			out.push(...renderTable(table, {width: width - 1, inline, style: S}));
			i = table.end - 1;
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			out.push(`${S.bold}${level <= 2 ? S.underline : ''}${inline(heading[2]!)}${S.reset}`);
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push(`${S.dim}${'─'.repeat(40)}${S.reset}`);
			continue;
		}
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			out.push(`${S.dim}│ ${S.reset}${S.italic}${inline(quote[1]!)}${S.italicOff}`);
			continue;
		}
		const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		if (bullet) {
			const task = /^\[( |x|X)\]\s+(.*)$/.exec(bullet[2]!);
			const mark = task ? (task[1] === ' ' ? '☐' : '☑') : '•';
			out.push(`${bullet[1]}${S.cyan}${mark}${S.fgOff} ${inline(task ? task[2]! : bullet[2]!)}`);
			continue;
		}
		const numbered = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
		if (numbered) {
			out.push(`${numbered[1]}${S.cyan}${numbered[2]}${S.fgOff} ${inline(numbered[3]!)}`);
			continue;
		}
		out.push(inline(line));
	}
	if (fence) closeFence(fence);
	return {text: out.join('\n'), codeBlocks};
}

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;

/** The opening line of the code fence still open at the end of `text`, if any. */
export function openFenceLine(text: string): string | undefined {
	let open: {line: string; marker: string} | undefined;
	for (const line of text.split('\n')) {
		const m = FENCE.exec(line);
		if (!m) continue;
		if (!open) open = {line, marker: m[1]!};
		else if (m[1]!.startsWith(open.marker[0]!) && m[1]!.length >= open.marker.length && m[2] === '') open = undefined;
	}
	return open?.line;
}
