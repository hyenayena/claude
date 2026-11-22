import {constants, type Stats} from 'node:fs';
import {lstat, open, readdir, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import type {ProjectAccess} from './deps/project.js';

export const RULES_FILE = '.yenarules';
export const SECTIONS = ['deny read', 'ask read', 'deny write', 'ask write'] as const;
export type Section = (typeof SECTIONS)[number];
export type Level = 'deny' | 'ask' | 'free';

export const RULES_MAX_BYTES = 64 * 1024;
export const RULES_MAX_LINES = 2000;
export const EXPAND_MAX_ENTRIES = 200_000;
export const EXPAND_TTL_MS = 15_000;
const SKIPPED_DIR = 'node_modules';
const OPAQUE_DIR = '.yena';

export type Problem = {file: string; line?: number; problem: string};

type Line = {neg: boolean; folderOnly: boolean; anchored: boolean; re: RegExp; prefix: string[]};
type Sections = Record<Section, Line[]>;
export type ParseResult = {ok: true; sections: Sections} | {ok: false; problem: string; line?: number};

class PatternError extends Error {}

const escapeRe = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

function globSegment(seg: string): string {
	let src = '';
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i] as string;
		if (c === '\\') {
			if (i + 1 >= seg.length) throw new PatternError('a pattern cannot end with a backslash');
			src += escapeRe(seg[++i] as string);
		} else if (c === '*') {
			while (seg[i + 1] === '*') i++;
			src += '[^/]*';
		} else if (c === '?') {
			src += '[^/]';
		} else if (c === '[') {
			let j = i + 1;
			let neg = false;
			if (seg[j] === '!' || seg[j] === '^') {
				neg = true;
				j++;
			}
			let body = '';
			let first = true;
			for (; j < seg.length; j++) {
				const d = seg[j] as string;
				if (d === ']' && !first) break;
				first = false;
				body += d === '\\' || d === '[' || d === ']' || d === '^' ? `\\${d}` : d;
			}
			if (j >= seg.length || body === '') throw new PatternError('a "[" has no closing "]"');
			src += `[${neg ? '^' : ''}${body}]`;
			i = j;
		} else {
			src += escapeRe(c);
		}
	}
	return src;
}

function compileLine(text: string): Line {
	let p = text;
	let neg = false;
	if (!p.startsWith('\\#') && !p.startsWith('\\!') && p.startsWith('!')) {
		neg = true;
		p = p.slice(1);
	}
	if (p === '') throw new PatternError('the pattern is empty');
	const folderOnly = p.endsWith('/');
	let anchored = p.startsWith('/');
	const segs = p.split('/').filter(s => s !== '');
	if (segs.length === 0) throw new PatternError('the pattern is empty');
	if (segs.length > 1) anchored = true;
	if (segs.some(s => s === '.' || s === '..')) throw new PatternError('"." and ".." segments are not allowed');
	for (const s of segs) if (s !== '**' && s.includes('**')) throw new PatternError('"**" must be a whole path segment');
	const flat: string[] = [];
	for (const s of segs) if (!(s === '**' && flat[flat.length - 1] === '**')) flat.push(s);
	if (!anchored) {
		const only = flat[0] as string;
		return {neg, folderOnly, anchored, re: new RegExp(`^${only === '**' ? '.*' : globSegment(only)}$`, 's'), prefix: []};
	}
	let src = '';
	let needSlash = false;
	flat.forEach((s, i) => {
		const first = i === 0;
		const last = i === flat.length - 1;
		if (s === '**') {
			if (first && last) src += '.*';
			else if (first) src += '(?:.*/)?';
			else if (last) src += '/.*';
			else src += '/(?:.*/)?';
			needSlash = false;
			return;
		}
		if (needSlash) src += '/';
		src += globSegment(s);
		needSlash = true;
	});
	const prefix: string[] = [];
	for (const s of flat) {
		if (s === '**' || /[*?[\\]/.test(s)) break;
		prefix.push(s);
	}
	return {neg, folderOnly, anchored, re: new RegExp(`^${src}$`, 's'), prefix};
}

export function parseRules(text: string): ParseResult {
	const lines = text.split('\n');
	if (lines.length > RULES_MAX_LINES + 1) return {ok: false, problem: `more than ${RULES_MAX_LINES} lines`};
	const sections: Sections = {'deny read': [], 'ask read': [], 'deny write': [], 'ask write': []};
	let current: Line[] | undefined;
	for (let i = 0; i < lines.length; i++) {
		const n = i + 1;
		const t = (lines[i] as string).replace(/[ \r]+$/, '');
		if (t.includes('\0')) return {ok: false, problem: 'a NUL character', line: n};
		if (t === '' || t.startsWith('#')) continue;
		const header = /^\[([^\]]*)\]$/.exec(t);
		if (header) {
			const name = header[1] as string;
			if (!(SECTIONS as readonly string[]).includes(name)) return {ok: false, problem: 'unknown section header', line: n};
			current = sections[name as Section];
			continue;
		}
		if (current === undefined) return {ok: false, problem: 'a pattern before any section header', line: n};
		try {
			current.push(compileLine(t));
		} catch (error) {
			if (error instanceof PatternError) return {ok: false, problem: error.message, line: n};
			throw error;
		}
	}
	return {ok: true, sections};
}

function lineMatches(line: Line, segs: string[], isDir: boolean): boolean {
	for (let k = 1; k <= segs.length; k++) {
		if (line.folderOnly && k === segs.length && !isDir) continue;
		if (line.re.test(line.anchored ? segs.slice(0, k).join('/') : (segs[k - 1] as string))) return true;
	}
	return false;
}

const lineMatchesEntry = (line: Line, segs: string[], isDir: boolean): boolean => {
	if (line.folderOnly && !isDir) return false;
	return line.re.test(line.anchored ? segs.join('/') : (segs[segs.length - 1] as string));
};

function decide(lines: Line[], segs: string[], isDir: boolean): boolean {
	let inside = false;
	for (const line of lines) if (lineMatches(line, segs, isDir)) inside = !line.neg;
	return inside;
}

type Loaded = {kind: 'none'} | {kind: 'ok'; sections: Sections} | {kind: 'bad'; problem: string; line?: number};
type Entry = {key: string; loaded: Loaded};

const parsed = new Map<string, Entry>();
const PARSED_MAX = 4096;

export async function loadRules(file: string): Promise<Entry> {
	let info;
	try {
		info = await lstat(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return {key: 'none', loaded: {kind: 'none'}};
		return {key: 'unreadable', loaded: {kind: 'bad', problem: 'the file cannot be read'}};
	}
	const key = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
	const hit = parsed.get(file);
	if (hit?.key === key) return hit;
	const entry = await readRules(file, info, key);
	if (parsed.size >= PARSED_MAX) parsed.clear();
	parsed.set(file, entry);
	return entry;
}

async function readRules(file: string, info: Stats, key: string): Promise<Entry> {
	const bad = (problem: string): Entry => ({key, loaded: {kind: 'bad', problem}});
	if (!info.isFile()) return bad('not a regular file (a symlink, folder or special file)');
	if (info.size > RULES_MAX_BYTES) return bad(`larger than ${RULES_MAX_BYTES} bytes`);
	let text: string;
	try {
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			text = new TextDecoder('utf-8', {fatal: true}).decode(await handle.readFile());
		} finally {
			await handle.close();
		}
	} catch (error) {
		return bad(error instanceof TypeError ? 'not valid UTF-8' : 'the file cannot be read');
	}
	const result = parseRules(text);
	return result.ok
		? {key, loaded: {kind: 'ok', sections: result.sections}}
		: {key, loaded: {kind: 'bad', problem: result.problem, ...(result.line !== undefined && {line: result.line})}};
}

export type RulesScope = {
	roots: string[];
	projects?: () => Promise<ProjectAccess | undefined>;
	rulesFile?: (name: string) => string | undefined;
};

const within = (child: string, dir: string): boolean => child === dir || child.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

const realOf = (p: string): Promise<string> => realpath(p).catch(() => path.resolve(p));

type Base = {dir: string; projectFile?: string};

async function dirNames(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, {withFileTypes: true})).filter(e => e.isDirectory()).map(e => e.name);
	} catch {
		return [];
	}
}

async function stageProject(base: string, access: ProjectAccess | undefined, workplace: string): Promise<string | undefined> {
	for (const s of access?.stages ?? []) if ((await realOf(s.path)) === base) return s.project;
	const name = path.basename(base);
	const known = (await dirNames(workplace)).filter(n => name.startsWith(`${n}-stage-`));
	return known.sort((a, b) => b.length - a.length)[0];
}

async function projectNameOf(dir: string, access: ProjectAccess | undefined, wp: string | undefined, st: string | undefined): Promise<string | undefined> {
	if (wp !== undefined && path.dirname(dir) === wp) return path.basename(dir);
	if (wp !== undefined && st !== undefined && path.dirname(dir) === st) return stageProject(dir, access, wp);
	return undefined;
}

async function makeBase(dir: string, scope: RulesScope, access: ProjectAccess | undefined, wp: string | undefined, st: string | undefined): Promise<Base> {
	const name = await projectNameOf(dir, access, wp, st);
	const projectFile = name === undefined ? undefined : scope.rulesFile?.(name);
	return {dir, ...(projectFile !== undefined && {projectFile})};
}

async function roots(scope: RulesScope): Promise<{access?: ProjectAccess; projectDir?: string; wp?: string; st?: string}> {
	const access = await scope.projects?.();
	const [workplace, stage] = access?.roots ?? [];
	const projectDir = scope.roots[0] === undefined ? undefined : await realOf(scope.roots[0]);
	return {
		...(access && {access}),
		...(projectDir !== undefined && {projectDir}),
		...(workplace !== undefined && {wp: await realOf(workplace)}),
		...(stage !== undefined && {st: await realOf(stage)}),
	};
}

async function baseFor(real: string, scope: RulesScope): Promise<Base | undefined> {
	const {access, projectDir, wp, st} = await roots(scope);
	const found: string[] = [];
	if (projectDir !== undefined && within(real, projectDir)) found.push(projectDir);
	for (const top of [wp, st]) {
		if (top === undefined || real === top || !within(real, top)) continue;
		found.push(path.join(top, path.relative(top, real).split(path.sep)[0] as string));
	}
	const dir = found.sort((a, b) => b.length - a.length)[0];
	return dir === undefined ? undefined : makeBase(dir, scope, access, wp, st);
}

async function allBases(scope: RulesScope): Promise<Base[]> {
	const {access, projectDir, wp, st} = await roots(scope);
	const dirs = new Set<string>(projectDir === undefined ? [] : [projectDir]);
	for (const top of [wp, st]) if (top !== undefined) for (const n of await dirNames(top)) dirs.add(path.join(top, n));
	return Promise.all([...dirs].map(d => makeBase(d, scope, access, wp, st)));
}

export type RulesVerdict = {
	read: Level;
	write: Level;
	section?: Section;
	label?: string;
	kind?: 'rules' | 'malformed' | 'rules-file';
	malformed?: Problem;
};

const FREE: RulesVerdict = {read: 'free', write: 'free'};

const projectLabel = (file: string): string => `the project's rules (${path.basename(file, RULES_FILE)})`;

async function rulesDirs(scope: RulesScope): Promise<string[]> {
	const sample = scope.rulesFile?.('a');
	if (sample === undefined) return [];
	const dir = path.dirname(sample);
	return [dir, await realOf(dir)];
}

export async function rulesVerdict(real: string, scope: RulesScope, isDirHint?: boolean): Promise<RulesVerdict> {
	const base = await baseFor(real, scope);
	const found: Array<{section: Section; label: string; kind: 'rules' | 'malformed'; malformed?: Problem}> = [];
	let isDir = isDirHint;
	if (base !== undefined && real !== base.dir) {
		isDir ??= await stat(real).then(s => s.isDirectory(), () => false);
		const chain: Array<{folder: string; file: string; label: string}> = [];
		const rel = path.relative(base.dir, path.dirname(real));
		let folder = base.dir;
		chain.push({folder, file: path.join(folder, RULES_FILE), label: path.join(folder, RULES_FILE)});
		for (const seg of rel === '' ? [] : rel.split(path.sep)) {
			folder = path.join(folder, seg);
			chain.push({folder, file: path.join(folder, RULES_FILE), label: path.join(folder, RULES_FILE)});
		}
		if (base.projectFile !== undefined) chain.push({folder: base.dir, file: base.projectFile, label: projectLabel(base.projectFile)});
		for (const src of chain) {
			const {loaded} = await loadRules(src.file);
			if (loaded.kind === 'none') continue;
			if (loaded.kind === 'bad') {
				if (real === src.file) continue;
				found.push({
					section: 'deny read',
					label: src.label,
					kind: 'malformed',
					malformed: {file: src.label, problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})},
				});
				continue;
			}
			const segs = path.relative(src.folder, real).split(path.sep);
			for (const section of SECTIONS) {
				if (decide(loaded.sections[section], segs, isDir)) found.push({section, label: src.label, kind: 'rules'});
			}
		}
	}
	const pick = (s: Section) => found.find(f => f.section === s);
	const denyRead = pick('deny read');
	const denyWrite = pick('deny write');
	const askRead = pick('ask read');
	const askWrite = pick('ask write');
	const decider = denyRead ?? denyWrite ?? askRead ?? askWrite;
	const verdict: RulesVerdict = {
		read: denyRead ? 'deny' : askRead ? 'ask' : 'free',
		write: denyRead || denyWrite ? 'deny' : askWrite ? 'ask' : 'free',
		...(decider && {section: decider.section, label: decider.label, kind: decider.kind}),
		...(denyRead?.malformed && {malformed: denyRead.malformed}),
	};
	if (verdict.write !== 'deny') {
		const builtIn =
			path.basename(real) === RULES_FILE || (await rulesDirs(scope)).some(d => within(real, d));
		if (builtIn) return {...verdict, write: 'deny', section: 'deny write', label: RULES_FILE, kind: 'rules-file'};
	}
	return decider === undefined && verdict.write === 'free' ? FREE : verdict;
}

export type Expansion = {
	denyRead: string[];
	askRead: string[];
	denyWrite: string[];
	askWrite: string[];
	rulesFiles: string[];
	problems: Problem[];
	truncated: boolean;
};

type Src = {folder: string; file: string; label: string; sections: Sections};
type State = {src: Src; segs: string[]; last: number[]};
type Acc = {count: number; max: number; truncated: boolean; problems: Problem[]; rulesFiles: string[]; keys: Map<string, string>};
type Result = {paths: string[][]; full: boolean[]; closed?: true};

const hasLaterNeg = (lines: Line[], last: number, segs: string[]): boolean =>
	lines.some((l, i) => {
		if (!l.neg || i <= last) return false;
		if (!l.anchored) return true;
		for (let k = 0; k < Math.min(l.prefix.length, segs.length); k++) if (l.prefix[k] !== segs[k]) return false;
		return true;
	});

async function enter(dir: string, states: State[], shallow: boolean, acc: Acc): Promise<{states: State[]; closed: boolean}> {
	if (shallow) return {states, closed: false};
	const file = path.join(dir, RULES_FILE);
	const {key, loaded} = await loadRules(file);
	if (loaded.kind === 'none') return {states, closed: false};
	acc.keys.set(file, key);
	acc.rulesFiles.push(file);
	if (loaded.kind === 'bad') {
		acc.problems.push({file, problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})});
		return {states, closed: true};
	}
	const src: Src = {folder: dir, file, label: file, sections: loaded.sections};
	return {states: [...states, {src, segs: [], last: [-1, -1, -1, -1]}], closed: false};
}

async function visit(dir: string, parent: State[], shallow: boolean, acc: Acc): Promise<Result> {
	const {states, closed} = await enter(dir, parent, shallow, acc);
	if (closed) return {paths: [[dir], [], [], []], full: [true, false, false, false], closed: true};
	let names: Array<{name: string; dir: boolean}> = [];
	try {
		names = (await readdir(dir, {withFileTypes: true})).map(e => ({name: e.name, dir: e.isDirectory()}));
	} catch {
		return {paths: [[], [], [], []], full: [true, true, true, true]};
	}
	const out: Result = {paths: [[], [], [], []], full: [true, true, true, true]};
	for (const {name, dir: isDir} of names) {
		if (name === SKIPPED_DIR) continue;
		if (acc.count >= acc.max) {
			acc.truncated = true;
			out.full = [false, false, false, false];
			break;
		}
		acc.count++;
		const entry = path.join(dir, name);
		const next: State[] = states.map(st => {
			const segs = [...st.segs, name];
			const last = st.last.slice();
			SECTIONS.forEach((section, s) => {
				st.src.sections[section].forEach((line, i) => {
					if (lineMatchesEntry(line, segs, isDir)) last[s] = i;
				});
			});
			return {src: st.src, segs, last};
		});
		const inS = [0, 1, 2, 3].map(s =>
			next.some(st => {
				const lines = st.src.sections[SECTIONS[s] as Section];
				const l = lines[st.last[s] as number];
				return l !== undefined && !l.neg;
			}),
		);
		const opaque = name === OPAQUE_DIR && states.every(st => st.segs.length === 0);
		const whole = [0, 1, 2, 3].map(s => {
			if (!inS[s]) return false;
			if (opaque) return true;
			return !next.some(st => {
				const lines = st.src.sections[SECTIONS[s] as Section];
				const l = lines[st.last[s] as number];
				return l !== undefined && !l.neg && hasLaterNeg(lines, st.last[s] as number, st.segs);
			});
		});
		if (!isDir) {
			for (let s = 0; s < 4; s++) {
				if (inS[s]) out.paths[s]!.push(entry);
				else out.full[s] = false;
			}
			continue;
		}
		let sub: Result | undefined;
		if (!opaque && !shallow && whole.some(w => !w)) sub = await visit(entry, next, name === '.git', acc);
		for (let s = 0; s < 4; s++) {
			if (whole[s]) out.paths[s]!.push(entry);
			else if (sub === undefined) {
				if (inS[s]) out.paths[s]!.push(entry);
				else out.full[s] = false;
			} else if (inS[s] && sub.full[s]) out.paths[s]!.push(entry);
			else {
				out.paths[s]!.push(...sub.paths[s]!);
				out.full[s] = false;
			}
		}
	}
	return out;
}

type Cached = {at: number; value: Expansion; keys: Array<[string, string]>};
const expansions = new Map<string, Cached>();

export type ExpandOptions = {maxEntries?: number; ttlMs?: number; now?: () => number};

export async function expandRules(scope: RulesScope, opts: ExpandOptions = {}): Promise<Expansion> {
	const now = opts.now ?? Date.now;
	const bases = await allBases(scope);
	const cacheKey = JSON.stringify(bases.map(b => [b.dir, b.projectFile ?? '']));
	const hit = expansions.get(cacheKey);
	if (hit && now() - hit.at < (opts.ttlMs ?? EXPAND_TTL_MS)) {
		let same = true;
		for (const [file, key] of hit.keys) if ((await loadRules(file)).key !== key) same = false;
		if (same) return hit.value;
	}
	const acc: Acc = {count: 0, max: opts.maxEntries ?? EXPAND_MAX_ENTRIES, truncated: false, problems: [], rulesFiles: [], keys: new Map()};
	const lists: string[][] = [[], [], [], []];
	for (const base of bases) {
		const states: State[] = [];
		if (base.projectFile !== undefined) {
			const {key, loaded} = await loadRules(base.projectFile);
			acc.keys.set(base.projectFile, key);
			if (loaded.kind === 'bad') {
				acc.problems.push({file: projectLabel(base.projectFile), problem: loaded.problem, ...(loaded.line !== undefined && {line: loaded.line})});
				lists[0]!.push(base.dir);
				continue;
			}
			if (loaded.kind === 'ok') {
				states.push({src: {folder: base.dir, file: base.projectFile, label: projectLabel(base.projectFile), sections: loaded.sections}, segs: [], last: [-1, -1, -1, -1]});
			}
		}
		const result = await visit(base.dir, states, false, acc);
		for (let s = 0; s < 4; s++) lists[s]!.push(...result.paths[s]!);
	}
	const unique = (list: string[]): string[] => [...new Set(list)];
	const value: Expansion = {
		denyRead: unique(lists[0]!),
		askRead: unique(lists[1]!),
		denyWrite: unique(lists[2]!),
		askWrite: unique(lists[3]!),
		rulesFiles: unique(acc.rulesFiles),
		problems: acc.problems,
		truncated: acc.truncated,
	};
	expansions.set(cacheKey, {at: now(), value, keys: [...acc.keys]});
	return value;
}

export const entriesInside = (list: string[], dir: string): string[] => list.filter(p => within(p, dir));

export function resetRulesCaches(): void {
	parsed.clear();
	expansions.clear();
}
