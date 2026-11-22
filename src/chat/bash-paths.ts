import {stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {resolveReal} from '../policy.js';
import {entriesInside, expandRules, RULES_FILE, rulesVerdict, type RulesScope} from '../rules.js';

export type BashUse = {path: string; mode: 'read' | 'write' | 'both'; own?: true};
export type BashAnalysis = {uses: BashUse[]; unparsed: boolean};

export const MAX_WORDS = 512;
export const MAX_COMMANDS = 64;
const MAX_DEPTH = 4;

type Tok = {t: 'w'; v: string} | {t: 'op'; v: string} | {t: 'r'; v: string};
type Lexed = {toks: Tok[]; subs: string[]; truncated: boolean};

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v';

function matchParen(src: string, from: number): number {
	let depth = 1;
	for (let i = from; i < src.length; i++) {
		const c = src[i] as string;
		if (c === '\\') i++;
		else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return -1;
			i = end;
		} else if (c === '"') {
			for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
		} else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i;
	}
	return -1;
}

function lex(src: string): Lexed {
	const toks: Tok[] = [];
	const subs: string[] = [];
	let words = 0;
	let word = null as string | null;
	let digitsOnly = true;
	let skipNext = false;
	let heredoc: {strip: boolean} | undefined;
	const pending: Array<{delim: string; strip: boolean}> = [];
	const flush = (): void => {
		if (word === null) return;
		const v = word;
		word = null;
		digitsOnly = true;
		if (heredoc) {
			pending.push({delim: v, strip: heredoc.strip});
			heredoc = undefined;
			return;
		}
		if (skipNext) {
			skipNext = false;
			return;
		}
		toks.push({t: 'w', v});
		words++;
	};
	const add = (s: string, plain = false): void => {
		word = (word ?? '') + s;
		if (!plain || !/^\d+$/.test(s)) digitsOnly = false;
	};
	const dollar = (i: number): number => {
		const next = src[i + 1];
		if (next === '(') {
			if (src[i + 2] === '(') {
				const end = src.indexOf('))', i + 3);
				const stop = end < 0 ? src.length : end + 2;
				add(src.slice(i, stop));
				return stop - 1;
			}
			const end = matchParen(src, i + 2);
			const stop = end < 0 ? src.length : end;
			subs.push(src.slice(i + 2, stop));
			add(src.slice(i, stop + 1));
			return stop;
		}
		if (next === '{') {
			const end = src.indexOf('}', i + 2);
			const stop = end < 0 ? src.length : end + 1;
			add(src.slice(i, stop));
			return stop - 1;
		}
		add('$');
		return i;
	};
	const backtick = (i: number): number => {
		let j = i + 1;
		while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
		subs.push(src.slice(i + 1, Math.min(j, src.length)));
		add(src.slice(i, j + 1));
		return j;
	};
	let i = 0;
	for (; i < src.length; i++) {
		if (words > MAX_WORDS) return {toks, subs, truncated: true};
		const c = src[i] as string;
		if (c === '\n') {
			flush();
			toks.push({t: 'op', v: ';'});
			for (const h of pending.splice(0)) {
				let at = i + 1;
				for (;;) {
					if (at >= src.length) break;
					const nl = src.indexOf('\n', at);
					const line = src.slice(at, nl < 0 ? src.length : nl);
					at = nl < 0 ? src.length : nl + 1;
					if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
				}
				i = at - 1;
			}
		} else if (isSpace(c)) {
			flush();
		} else if (c === '#' && word === null) {
			while (i + 1 < src.length && src[i + 1] !== '\n') i++;
		} else if (c === ';' || c === '(' || c === ')') {
			flush();
			toks.push({t: 'op', v: c});
		} else if (c === '&' || c === '|') {
			flush();
			if (c === '&' && src[i + 1] === '>') {
				const op = src[i + 2] === '>' ? '&>>' : '&>';
				toks.push({t: 'r', v: op});
				i += op.length - 1;
			} else {
				const two = src.slice(i, i + 2);
				const op = two === '&&' || two === '||' || two === '|&' ? two : c;
				toks.push({t: 'op', v: op});
				i += op.length - 1;
			}
		} else if (c === '<' || c === '>') {
			if (src[i + 1] === '(') {
				const end = matchParen(src, i + 2);
				const stop = end < 0 ? src.length : end;
				subs.push(src.slice(i + 2, stop));
				i = stop;
				continue;
			}
			if (word !== null && digitsOnly) word = null;
			flush();
			let op = c;
			const rest = src.slice(i, i + 3);
			if (rest === '<<<') op = '<<<';
			else if (rest.startsWith('<<-')) op = '<<-';
			else if (rest.startsWith('<<')) op = '<<';
			else if (rest.startsWith('>>')) op = '>>';
			else if (rest.startsWith('>|')) op = '>|';
			else if (rest.startsWith('>&') || rest.startsWith('<&')) op = rest.slice(0, 2);
			else if (rest.startsWith('<>')) op = '<>';
			toks.push({t: 'r', v: op});
			i += op.length - 1;
			if (op === '<<' || op === '<<-') heredoc = {strip: op === '<<-'};
			else if (op === '<<<') skipNext = true;
		} else if (c === "'") {
			const end = src.indexOf("'", i + 1);
			const stop = end < 0 ? src.length : end;
			add(src.slice(i + 1, stop));
			digitsOnly = false;
			i = stop;
		} else if (c === '"') {
			add('');
			digitsOnly = false;
			for (i++; i < src.length && src[i] !== '"'; i++) {
				const d = src[i] as string;
				if (d === '\\' && i + 1 < src.length) {
					const e = src[i + 1] as string;
					if (e === '"' || e === '\\' || e === '$' || e === '`') add(e);
					else if (e !== '\n') add(d + e);
					i++;
				} else if (d === '$') i = dollar(i);
				else if (d === '`') i = backtick(i);
				else add(d);
			}
		} else if (c === '\\') {
			if (src[i + 1] === '\n') i++;
			else if (i + 1 < src.length) {
				add(src[i + 1] as string);
				i++;
			}
		} else if (c === '$') {
			i = dollar(i);
		} else if (c === '`') {
			i = backtick(i);
		} else {
			add(c, true);
		}
	}
	flush();
	return {toks, subs, truncated: false};
}

type Simple = {words: string[]; redirs: Array<{op: string; target?: string}>};

function split(toks: Tok[]): Simple[] {
	const out: Simple[] = [];
	let cur: Simple = {words: [], redirs: []};
	const push = (): void => {
		if (cur.words.length > 0 || cur.redirs.length > 0) out.push(cur);
		cur = {words: [], redirs: []};
	};
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i] as Tok;
		if (t.t === 'op') push();
		else if (t.t === 'r') {
			const next = toks[i + 1];
			if (t.v === '<<' || t.v === '<<-' || t.v === '<<<') {
				cur.redirs.push({op: t.v});
			} else if (next?.t === 'w' && !((t.v === '>&' || t.v === '<&') && /^(\d+|-)$/.test(next.v))) {
				cur.redirs.push({op: t.v, target: next.v});
				i++;
			} else if (next?.t === 'w') i++;
		} else cur.words.push(t.v);
	}
	push();
	return out;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'case', 'esac', 'in', '{', '}', '!', 'function', 'coproc']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nice', 'time', 'timeout', 'nohup', 'stdbuf', 'exec', 'builtin', 'ionice', 'setsid', 'chronic']);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const READ_PROGS = new Set([
	'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'cut', 'sort', 'uniq', 'diff', 'cmp', 'comm', 'strings', 'xxd', 'od',
	'hexdump', 'base64', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'file', 'wc', 'nl', 'tac', 'rev', 'jq', 'yq', 'source', '.',
]);
const LISTING_PROGS = new Set(['ls', 'tree', 'du', 'readlink', 'realpath', 'stat']);
const WRITE_PROGS = new Set(['rm', 'rmdir', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'patch', 'shred', 'mkfifo']);
// Builtins and tiny programs that only print or wait: their words are text, not paths.
const NO_PATH_PROGS = new Set(['echo', 'printf', 'true', 'false', 'pwd', 'date', 'sleep', 'export', 'unset', 'set', 'which', 'type', 'whoami', 'id', 'uname', 'hostname', 'wait', ':']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
const GIT_READ = new Set(['show', 'diff', 'log', 'blame', 'cat-file', 'grep', 'status', 'ls-files']);
const GIT_WRITE = new Set(['checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'apply', 'stash', 'am']);
const NODE_PM = new Set(['npm', 'pnpm', 'yarn', 'npx']);
const FIND_WRITE = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls']);

export const homeDir = (): string => homedir();

function toPath(tok: string, cwd: string): string | undefined {
	if (tok === '' || tok.includes('\0')) return undefined;
	if (tok === '~') return homeDir();
	if (tok.startsWith('~/')) return path.join(homeDir(), tok.slice(2));
	return path.resolve(cwd, tok);
}

// A token naming something other than a path (remote host:path, URLs) is left out.
const foreign = (tok: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(tok) || /^[^/\s]+:[^/]/.test(tok);

function operands(args: string[]): string[] {
	const out: string[] = [];
	let rest = false;
	for (const a of args) {
		if (!rest && a === '--') {
			rest = true;
			continue;
		}
		if (!rest && a.startsWith('-')) {
			const eq = a.indexOf('=');
			if (a.startsWith('--') && eq > 0 && eq < a.length - 1) out.push(a.slice(eq + 1));
			continue;
		}
		const kv = ASSIGN.exec(a);
		out.push(kv ? a.slice(kv[0].length) : a);
	}
	return out.filter(a => a !== '');
}

type Ctx = {uses: BashUse[]; commands: number; capped: boolean; cwd: string};

function addUses(ctx: Ctx, tokens: string[], mode: BashUse['mode'], own?: true): void {
	for (const t of tokens) {
		if (foreign(t)) continue;
		const p = toPath(t, ctx.cwd);
		if (p !== undefined) ctx.uses.push({path: p, mode, ...(own && {own})});
	}
}

function stripWrappers(words: string[]): string[] {
	let w = words;
	for (;;) {
		while (w.length > 0 && ASSIGN.test(w[0] as string)) w = w.slice(1);
		while (w.length > 0 && KEYWORDS.has(w[0] as string)) w = w.slice(1);
		if (w.length === 0 || !WRAPPERS.has(path.basename(w[0] as string))) return w;
		const wrapper = path.basename(w[0] as string);
		w = w.slice(1);
		for (;;) {
			const x = w[0];
			if (x === undefined) break;
			if (x === '-n' || x === '-u' || x === '-C' || x === '-s' || x === '-k') w = w.slice(2);
			else if (x.startsWith('-') || ASSIGN.test(x)) w = w.slice(1);
			else if (wrapper === 'timeout' && /^[0-9.]+[smhd]?$/.test(x)) w = w.slice(1);
			else break;
		}
	}
}

function tarUses(ctx: Ctx, args: string[]): void {
	let mode = '';
	let archive: string | undefined;
	let dest: string | undefined;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a.startsWith('--')) {
			if (a === '--extract' || a === '--get') mode = 'x';
			else if (a === '--create') mode = 'c';
			else if (a === '--list') mode = 't';
			else if (a.startsWith('--file=')) archive = a.slice(7);
			else if (a === '--file') archive = args[++i];
			else if (a.startsWith('--directory=')) dest = a.slice(12);
			else if (a === '--directory') dest = args[++i];
			continue;
		}
		const cluster = a.startsWith('-') ? a.slice(1) : i === 0 && /^[A-Za-z]+$/.test(a) ? a : undefined;
		if (cluster === undefined) {
			rest.push(a);
			continue;
		}
		for (const ch of cluster) {
			if (ch === 'x' || ch === 'c' || ch === 't') mode = ch;
			else if (ch === 'f') archive = args[++i];
			else if (ch === 'C') dest = args[++i];
		}
	}
	if (mode === 'x') {
		addUses(ctx, [dest ?? '.'], 'write');
		if (archive !== undefined) addUses(ctx, [archive], 'read');
	} else if (mode === 'c') {
		if (archive !== undefined) addUses(ctx, [archive], 'write');
		addUses(ctx, rest, 'read');
	} else if (mode === 't') {
		addUses(ctx, [...(archive === undefined ? [] : [archive]), ...rest], 'read');
	} else addUses(ctx, [...(archive === undefined ? [] : [archive]), ...(dest === undefined ? [] : [dest]), ...rest], 'both');
}

const changesGitConfig = (sub: string, rest: string[]): boolean =>
	sub === 'config' ||
	(sub === 'remote' && rest.some(a => !a.startsWith('-') && a !== 'show' && a !== 'get-url')) ||
	(sub === 'push' && rest.some(a => a === '-u' || a === '--set-upstream')) ||
	(sub === 'branch' && rest.some(a => a === '-u' || a.startsWith('--set-upstream') || a === '--unset-upstream'));

// Git reads committed content that the sandbox does not cover: "<rev>:<path>" names a file and a pathspec names a path.
// Without a pathspec the command stays "own", so whole-repo output can still show a tracked deny-read file.
const OBJECT_PATH = /^[^:\s]*:(?:[0-3]:)?(.+)$/;
const PATHSPEC_SUBS = new Set(['archive', 'grep', 'log', 'show', 'cat-file', 'blame']);

function gitReadUses(ctx: Ctx, sub: string | undefined, rest: string[]): void {
	const cut = rest.indexOf('--');
	const before = cut < 0 ? rest : rest.slice(0, cut);
	const after = cut < 0 ? [] : rest.slice(cut + 1).filter(a => a !== '');
	const named = sub !== undefined && PATHSPEC_SUBS.has(sub);
	addUses(ctx, operands(before), 'read', named ? undefined : true);
	addUses(ctx, after, 'read');
	for (const tok of [...before, ...after]) {
		if (tok.startsWith('-') || tok.includes('://')) continue;
		const m = OBJECT_PATH.exec(tok);
		if (m?.[1] !== undefined) addUses(ctx, [m[1]], 'read');
	}
}

function gitUses(ctx: Ctx, args: string[]): void {
	let cwd = ctx.cwd;
	let i = 0;
	for (; i < args.length; i++) {
		const a = args[i] as string;
		if (a === '-C') {
			const next = args[++i];
			const p = next === undefined ? undefined : toPath(next, cwd);
			if (p !== undefined) cwd = p;
		} else if (a === '-c' || a === '--exec-path' || a === '--namespace') i++;
		else if (a.startsWith('-')) continue;
		else break;
	}
	const sub = args[i];
	const rest = args.slice(i + 1);
	const saved = ctx.cwd;
	ctx.cwd = cwd;
	const mode = sub !== undefined && GIT_WRITE.has(sub) ? 'write' : 'read';
	if (mode === 'write') addUses(ctx, operands(rest), mode, true);
	else gitReadUses(ctx, sub, rest);
	if (sub !== undefined && changesGitConfig(sub, rest)) addUses(ctx, [path.join('.git', 'config')], 'write', true);
	ctx.cwd = saved;
}

function copyUses(ctx: Ctx, prog: string, args: string[]): void {
	if (prog === 'install' && args.includes('-d')) return addUses(ctx, operands(args), 'write');
	let target: string | undefined;
	const plain: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i] as string;
		if (a === '-t' || a === '--target-directory') target = args[++i];
		else if (a.startsWith('--target-directory=')) target = a.slice(19);
		else plain.push(a);
	}
	const ops = operands(plain);
	if (prog === 'mv') return addUses(ctx, [...ops, ...(target === undefined ? [] : [target])], 'write');
	if (target !== undefined) {
		addUses(ctx, ops, 'read');
		addUses(ctx, [target], 'write');
		return;
	}
	addUses(ctx, ops.slice(0, -1), 'read');
	addUses(ctx, ops.slice(-1), 'write');
}

function simpleUses(ctx: Ctx, words: string[], depth: number): void {
	const w = stripWrappers(words);
	if (w.length === 0) return;
	const prog = path.basename(w[0] as string);
	const args = w.slice(1);
	if (prog === 'cd' || prog === 'pushd') {
		const dir = operands(args)[0];
		const p = dir === undefined ? undefined : toPath(dir, ctx.cwd);
		if (p !== undefined && !dir?.includes('$')) ctx.cwd = p;
		return;
	}
	if (SHELLS.has(prog) || prog === 'eval') {
		const at = prog === 'eval' ? 0 : args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) + 1;
		const script = prog === 'eval' ? args.join(' ') : at > 0 ? args[at] : undefined;
		if (script !== undefined && depth < MAX_DEPTH) analyzeInto(ctx, script, depth + 1);
		addUses(ctx, operands(args), 'both');
		return;
	}
	if (NO_PATH_PROGS.has(prog)) return;
	if ((w[0] as string).includes('/')) addUses(ctx, [w[0] as string], 'read');
	if (READ_PROGS.has(prog)) return addUses(ctx, operands(args), 'read');
	if (LISTING_PROGS.has(prog)) return addUses(ctx, operands(args), 'read', true);
	if (WRITE_PROGS.has(prog)) return addUses(ctx, operands(args), 'write');
	switch (prog) {
		case 'sed':
			return addUses(ctx, operands(args), args.some(a => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')) ? 'write' : 'read');
		case 'perl':
			return addUses(ctx, operands(args), args.some(a => /^-[A-Za-z]*i/.test(a)) ? 'write' : 'both');
		case 'tar':
			return tarUses(ctx, args);
		case 'zip': {
			const ops = operands(args);
			addUses(ctx, ops.slice(0, 1), 'write');
			return addUses(ctx, ops.slice(1), 'read');
		}
		case 'unzip': {
			const at = args.indexOf('-d');
			const dest = at >= 0 ? args[at + 1] : undefined;
			const ops = operands(args.filter((a, i) => !(a === '-d' || (at >= 0 && i === at + 1))));
			addUses(ctx, [dest ?? '.'], 'write');
			return addUses(ctx, ops.slice(0, 1), 'read');
		}
		case 'cp':
		case 'rsync':
		case 'scp':
		case 'install':
		case 'mv':
			return copyUses(ctx, prog, args);
		case 'dd':
			for (const a of args) {
				if (a.startsWith('if=')) addUses(ctx, [a.slice(3)], 'read');
				else if (a.startsWith('of=')) addUses(ctx, [a.slice(3)], 'write');
			}
			return;
		case 'git':
			return gitUses(ctx, args);
		case 'find': {
			const writes = args.some(a => FIND_WRITE.has(a));
			const starts: string[] = [];
			for (const a of args) {
				if (a.startsWith('-') || a === '(' || a === '!') break;
				starts.push(a);
			}
			return addUses(ctx, starts.length > 0 ? starts : ['.'], writes ? 'both' : 'read', writes ? undefined : true);
		}
		default:
	}
	if (NODE_PM.has(prog)) {
		addUses(ctx, ['.'], 'write', true);
		return addUses(ctx, operands(args), 'write');
	}
	addUses(ctx, operands(args), 'both');
}

function redirUses(ctx: Ctx, redirs: Simple['redirs']): void {
	for (const r of redirs) {
		if (r.target === undefined) continue;
		const mode = r.op === '<' ? 'read' : r.op === '<>' ? 'both' : 'write';
		addUses(ctx, [r.target], mode);
	}
}

function analyzeInto(ctx: Ctx, command: string, depth: number): void {
	const {toks, subs, truncated} = lex(command);
	if (truncated) ctx.capped = true;
	for (const sub of subs) if (depth < MAX_DEPTH) analyzeInto(ctx, sub, depth + 1);
	for (const simple of split(toks)) {
		if (++ctx.commands > MAX_COMMANDS) {
			ctx.capped = true;
			return;
		}
		simpleUses(ctx, simple.words, depth);
		redirUses(ctx, simple.redirs);
	}
}

export function analyzeBash(command: string, cwd: string): BashAnalysis {
	const ctx: Ctx = {uses: [], commands: 0, capped: false, cwd: path.resolve(cwd)};
	analyzeInto(ctx, command, 0);
	return {uses: ctx.uses, unparsed: ctx.capped};
}

export type BashRulesVerdict = {decision: 'allow' | 'ask' | 'deny'; path?: string};

export async function bashRulesVerdict(analysis: BashAnalysis, scope: RulesScope): Promise<BashRulesVerdict> {
	let ask: string | undefined;
	let expansion: Awaited<ReturnType<typeof expandRules>> | undefined;
	for (const use of analysis.uses) {
		const mode = analysis.unparsed ? 'both' : use.mode;
		const reads = mode !== 'write';
		const writes = mode !== 'read';
		// rm, mv and ln act on a symlink itself, which the resolved path below no longer names.
		if (writes && path.basename(use.path) === RULES_FILE) return {decision: 'deny', path: use.path};
		const real = await resolveReal(use.path).catch(() => path.resolve(use.path));
		const isDir = await stat(real).then(s => s.isDirectory(), () => false);
		const v = await rulesVerdict(real, scope, isDir);
		if ((reads && v.read === 'deny') || (writes && v.write === 'deny')) return {decision: 'deny', path: use.path};
		if ((reads && v.read === 'ask') || (writes && v.write === 'ask')) ask ??= use.path;
		if (!isDir || (use.own && !analysis.unparsed)) continue;
		expansion ??= await expandRules(scope);
		const hit = (list: string[]): boolean => entriesInside(list, real).length > 0;
		if (reads && hit(expansion.denyRead)) return {decision: 'deny', path: use.path};
		if (writes && (hit(expansion.denyRead) || hit(expansion.denyWrite))) return {decision: 'deny', path: use.path};
		if ((reads && hit(expansion.askRead)) || (writes && hit(expansion.askWrite))) ask ??= use.path;
	}
	return ask === undefined ? {decision: 'allow'} : {decision: 'ask', path: ask};
}
