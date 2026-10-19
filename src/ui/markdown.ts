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

export function renderMarkdown(text: string): string {
	const out: string[] = [];
	let fence: {lang: string; marker: string} | undefined;
	for (const line of text.split('\n')) {
		const open = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
		if (fence) {
			if (open && open[1]!.startsWith(fence.marker[0]!) && open[1]!.length >= fence.marker.length && open[2] === '') {
				fence = undefined;
				out.push(`${S.dim}╰─${S.reset}`);
			} else {
				out.push(`${S.dim}│${S.reset} ${highlightLine(line, fence.lang)}`);
			}
			continue;
		}
		if (open) {
			fence = {lang: open[2] ?? '', marker: open[1]!};
			out.push(`${S.dim}╭─${fence.lang ? ` ${fence.lang}` : ''}${S.reset}`);
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
	if (fence) out.push(`${S.dim}╰─${S.reset}`);
	return out.join('\n');
}
