import type {CodeToken, DiffHighlighter, ThemeTone} from '../kit.js';

export const HIGHLIGHT_LANGUAGES = [
	'typescript',
	'javascript',
	'json',
	'xml',
	'css',
	'scss',
	'markdown',
	'yaml',
	'ini',
	'bash',
	'python',
	'go',
	'rust',
	'java',
	'kotlin',
	'swift',
	'c',
	'cpp',
	'csharp',
	'php',
	'ruby',
	'sql',
	'dockerfile',
	'makefile',
	'lua',
	'diff',
] as const;

export type HighlightLanguage = (typeof HIGHLIGHT_LANGUAGES)[number];

const MAX_LINES = 2000;
const MAX_CHARS = 64 * 1024;
const MAX_LINE = 1000;

const EXTENSIONS: Readonly<Record<string, HighlightLanguage>> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	html: 'xml',
	htm: 'xml',
	xml: 'xml',
	svg: 'xml',
	vue: 'xml',
	css: 'css',
	scss: 'scss',
	sass: 'scss',
	md: 'markdown',
	markdown: 'markdown',
	yml: 'yaml',
	yaml: 'yaml',
	toml: 'ini',
	ini: 'ini',
	cfg: 'ini',
	conf: 'ini',
	sh: 'bash',
	bash: 'bash',
	zsh: 'bash',
	py: 'python',
	go: 'go',
	rs: 'rust',
	java: 'java',
	kt: 'kotlin',
	kts: 'kotlin',
	swift: 'swift',
	c: 'c',
	h: 'c',
	cc: 'cpp',
	cpp: 'cpp',
	cxx: 'cpp',
	hpp: 'cpp',
	hh: 'cpp',
	cs: 'csharp',
	php: 'php',
	rb: 'ruby',
	sql: 'sql',
	lua: 'lua',
	diff: 'diff',
	patch: 'diff',
	mk: 'makefile',
};

const BASENAMES: Readonly<Record<string, HighlightLanguage>> = {
	dockerfile: 'dockerfile',
	makefile: 'makefile',
	'.bashrc': 'bash',
	'.profile': 'bash',
	'.zshrc': 'bash',
};

const SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([A-Za-z][\w.-]*)/;

function shebangLanguage(firstLine: string): HighlightLanguage | undefined {
	const prog = SHEBANG.exec(firstLine)?.[1]?.toLowerCase();
	if (prog === undefined) return undefined;
	if (/^(sh|bash|zsh|ash)$/.test(prog)) return 'bash';
	if (prog === 'node') return 'javascript';
	if (prog === 'tsx' || prog === 'deno') return 'typescript';
	if (/^python/.test(prog)) return 'python';
	return undefined;
}

export function languageFor(path: string, firstLine?: string): HighlightLanguage | undefined {
	const base = (path.split('/').pop() ?? '').toLowerCase();
	const byName = BASENAMES[base];
	if (byName !== undefined) return byName;
	const dot = base.lastIndexOf('.');
	if (dot >= 0) {
		const byExt = EXTENSIONS[base.slice(dot + 1)];
		if (byExt !== undefined) return byExt;
	}
	return firstLine === undefined ? undefined : shebangLanguage(firstLine);
}

export const HLJS_SCOPE_TONE: Readonly<Record<string, ThemeTone>> = Object.freeze({
	keyword: 'code.keyword',
	built_in: 'code.keyword',
	'selector-tag': 'code.keyword',
	literal: 'code.constant',
	string: 'code.string',
	'template-string': 'code.string',
	regexp: 'code.regexp',
	number: 'code.number',
	comment: 'code.comment',
	doc: 'code.comment',
	'title.function': 'code.function',
	function: 'code.function',
	title: 'code.function',
	'title.class': 'code.type',
	type: 'code.type',
	class: 'code.type',
	'variable.constant': 'code.constant',
	'variable.language': 'code.keyword',
	symbol: 'code.constant',
	attr: 'code.attribute',
	attribute: 'code.attribute',
	property: 'code.attribute',
	'selector-class': 'code.attribute',
	'selector-id': 'code.attribute',
	'selector-attr': 'code.attribute',
	tag: 'code.tag',
	name: 'code.tag',
	meta: 'code.meta',
	'keyword.meta': 'code.meta',
	punctuation: 'code.punctuation',
	operator: 'code.punctuation',
});

function toneOfClass(classAttr: string): ThemeTone | undefined {
	const names = classAttr
		.split(/\s+/)
		.filter(n => n !== '')
		.map(n => n.replace(/^hljs-/, '').replace(/_$/, ''));
	if (names.length === 0) return undefined;
	const candidates = [names.join('.'), ...names.map((n, i) => (i === 0 ? n : `${names[0]}.${n}`)), ...names];
	for (const c of candidates) {
		const tone = HLJS_SCOPE_TONE[c];
		if (tone !== undefined) return tone;
	}
	for (const n of names) {
		const first = n.split('.')[0]!;
		const tone = HLJS_SCOPE_TONE[first];
		if (tone !== undefined) return tone;
	}
	return undefined;
}

const ENTITIES: Readonly<Record<string, string>> = {amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'"};
const MARKUP = /<span class="([^"]*)">|<\/span>|&(amp|lt|gt|quot|#x27|#39);/g;

export function tokensFromHljsHtml(html: string): CodeToken[][] {
	const lines: CodeToken[][] = [[]];
	const stack: (ThemeTone | undefined)[] = [];
	const push = (text: string) => {
		if (text === '') return;
		const tone = [...stack].reverse().find(t => t !== undefined);
		const parts = text.split('\n');
		parts.forEach((part, i) => {
			if (i > 0) lines.push([]);
			if (part === '') return;
			const line = lines[lines.length - 1]!;
			const last = line[line.length - 1];
			if (last !== undefined && last.tone === tone) last.text += part;
			else line.push(tone === undefined ? {text: part} : {text: part, tone});
		});
	};
	let at = 0;
	for (const m of html.matchAll(MARKUP)) {
		push(html.slice(at, m.index));
		at = m.index + m[0].length;
		if (m[1] !== undefined) stack.push(toneOfClass(m[1]));
		else if (m[2] !== undefined) push(ENTITIES[m[2]]!);
		else if (stack.length > 0) stack.pop();
		else push(m[0]);
	}
	push(html.slice(at));
	return lines;
}

type Hljs = {
	highlight(code: string, options: {language: string; ignoreIllegals: boolean}): {value: string};
	registerLanguage(name: string, definition: unknown): void;
};

type Importer = (specifier: string) => Promise<unknown>;

const defaultImporter: Importer = specifier => import(specifier);

let importer: Importer = defaultImporter;
let loading: Promise<boolean> | undefined;
let hljs: Hljs | undefined;
const registered = new Set<string>();

const CORE = 'highlight.js/lib/core';
const FENCE_ALIASES: Readonly<Record<string, HighlightLanguage>> = {
	shell: 'bash',
	console: 'bash',
	'shell-session': 'bash',
	golang: 'go',
	node: 'javascript',
	'c++': 'cpp',
	'c#': 'csharp',
	'objective-c': 'c',
	make: 'makefile',
	python3: 'python',
	typescript: 'typescript',
};

// Maps the info string of a code fence (```ts, ```c++, ```sh) to a highlighter language.
export function fenceLanguage(tag: string): HighlightLanguage | undefined {
	const name = tag.trim().toLowerCase().replace(/^\./, '');
	if (name === '' || name.length > 24) return undefined;
	if ((HIGHLIGHT_LANGUAGES as readonly string[]).includes(name)) return name as HighlightLanguage;
	return FENCE_ALIASES[name] ?? EXTENSIONS[name] ?? BASENAMES[name];
}

const languageModule = (name: string): string => `highlight.js/lib/languages/${name}`;

const defaultOf = (mod: unknown): unknown => (mod as {default?: unknown} | null)?.default;

export function preloadHighlighter(): Promise<boolean> {
	loading ??= (async () => {
		try {
			const core = defaultOf(await importer(CORE)) as {newInstance(): Hljs} | undefined;
			if (core === undefined || typeof core.newInstance !== 'function') return false;
			const instance = core.newInstance();
			const loaded = await Promise.all(HIGHLIGHT_LANGUAGES.map(async name => [name, defaultOf(await importer(languageModule(name)))] as const));
			for (const [name, definition] of loaded) {
				if (typeof definition !== 'function') continue;
				instance.registerLanguage(name, definition);
				registered.add(name);
			}
			hljs = instance;
			return true;
		} catch {
			hljs = undefined;
			registered.clear();
			return false;
		}
	})();
	return loading;
}

export const highlighterReady = (): boolean => hljs !== undefined;

export function highlighterFor(language: string | undefined): DiffHighlighter | undefined {
	const engine = hljs;
	if (engine === undefined || language === undefined || !registered.has(language)) return undefined;
	return lines => {
		if (lines.length > MAX_LINES) return undefined;
		let chars = 0;
		for (const l of lines) {
			if (l.length > MAX_LINE) return undefined;
			chars += l.length + 1;
		}
		if (chars > MAX_CHARS) return undefined;
		const tokens = tokensFromHljsHtml(engine.highlight(lines.join('\n'), {language, ignoreIllegals: true}).value);
		return tokens.length === lines.length ? tokens : undefined;
	};
}

export function resetHighlighterForTests(replacement?: Importer): void {
	importer = replacement ?? defaultImporter;
	loading = undefined;
	hljs = undefined;
	registered.clear();
}
