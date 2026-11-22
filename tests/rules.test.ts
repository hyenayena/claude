import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, beforeEach, describe, it} from 'node:test';
import type {ProjectAccess} from '../src/deps/project.js';
import {entriesInside, expandRules, loadRules, parseRules, resetRulesCaches, rulesVerdict, type RulesScope} from '../src/rules.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-rules-')));
after(() => rmSync(tmp, {recursive: true, force: true}));
beforeEach(() => resetRulesCaches());

const workplace = path.join(tmp, 'workplace');
const stage = path.join(tmp, 'stage');
const ruleData = path.join(tmp, 'data', 'project', 'rules');
const app = path.join(workplace, 'app');
mkdirSync(app, {recursive: true});
mkdirSync(stage, {recursive: true});
mkdirSync(ruleData, {recursive: true});

let stages: Array<{path: string; project: string}> | undefined;
const rulesFile = (name: string): string | undefined => (/^[a-z0-9-]+$/.test(name) ? path.join(ruleData, `${name}.yenarules`) : undefined);
const access = (): ProjectAccess => ({roots: [workplace, stage], docs: path.join(tmp, 'docs'), managed: [workplace, stage], writable: [], ...(stages && {stages})});
const scope: RulesScope = {roots: [app], projects: async () => access(), rulesFile};

const put = (file: string, text: string): string => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, text);
	return file;
};
const rulesAt = (dir: string, text: string): string => put(path.join(dir, '.yenarules'), text);
const verdict = (rel: string, isDir?: boolean, from = app, s: RulesScope = scope) => rulesVerdict(path.join(from, rel), s, isDir);
const levels = async (rel: string, isDir?: boolean, from = app) => {
	const v = await verdict(rel, isDir, from);
	return `${v.read}/${v.write}`;
};

describe('parseRules', () => {
	const bad = (text: string, problem: RegExp, line?: number) => {
		const r = parseRules(text);
		assert.equal(r.ok, false, text);
		if (!r.ok) {
			assert.match(r.problem, problem);
			assert.equal(r.line, line);
		}
	};

	it('accepts the four sections, comments, blank lines, trailing spaces and CRLF', () => {
		const r = parseRules('# c\n\n[deny read]  \r\n.env*  \r\n[ask read]\n[deny write]\n/x\n[ask write]\n**/.git/config\n');
		assert.ok(r.ok);
		if (r.ok) assert.deepEqual(Object.values(r.sections).map(l => l.length), [1, 0, 1, 1]);
	});

	it('rejects an unknown header, a pattern before a header, an empty pattern and NUL, with the line', () => {
		bad('[deny  read]\n', /unknown section/, 1);
		bad('[Deny read]\n', /unknown section/, 1);
		bad('# c\nfoo\n[deny read]\n', /before any section/, 2);
		bad('[deny read]\n!\n', /empty/, 2);
		bad('[deny read]\n/\n', /empty/, 2);
		bad('[deny read]\na\0b\n', /NUL/, 2);
	});

	it('rejects "." and ".." segments, an unclosed "[", "**" inside a segment and a trailing backslash', () => {
		bad('[deny read]\n../x\n', /not allowed/, 2);
		bad('[deny read]\na/./b\n', /not allowed/, 2);
		bad('[deny read]\n[abc\n', /closing/, 2);
		bad('[deny read]\na**b\n', /whole path segment/, 2);
		bad('[deny read]\nabc\\\n', /backslash/, 2);
	});

	it('rejects more than 2000 lines', () => {
		bad(`[deny read]\n${'a\n'.repeat(2001)}`, /more than 2000 lines/);
		assert.ok(parseRules(`[deny read]\n${'a\n'.repeat(1999)}`).ok);
	});
});

describe('loadRules', () => {
	it('flags a symlink, a folder, a big file, invalid UTF-8 and an unreadable file as malformed, a missing one as none', async () => {
		const dir = path.join(tmp, 'load');
		mkdirSync(dir, {recursive: true});
		assert.equal((await loadRules(path.join(dir, 'none'))).loaded.kind, 'none');
		put(path.join(dir, 'real'), '[deny read]\nx\n');
		symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
		mkdirSync(path.join(dir, 'folder'));
		put(path.join(dir, 'big'), `[deny read]\n${'#'.repeat(70_000)}\n`);
		writeFileSync(path.join(dir, 'utf8'), Buffer.from([0x5b, 0xff, 0xfe]));
		const kinds = async (n: string) => (await loadRules(path.join(dir, n))).loaded;
		assert.equal((await kinds('real')).kind, 'ok');
		for (const n of ['link', 'folder', 'big', 'utf8']) assert.equal((await kinds(n)).kind, 'bad', n);
		assert.match(String((await kinds('big') as {problem: string}).problem), /larger than/);
		assert.match(String((await kinds('utf8') as {problem: string}).problem), /UTF-8/);
		if (process.getuid?.() !== 0) {
			chmodSync(path.join(dir, 'real'), 0o000);
			assert.equal((await kinds('real')).kind, 'bad');
			chmodSync(path.join(dir, 'real'), 0o600);
		}
	});

	it('re-reads a file when its stat key changes and keeps the cached parse otherwise', async () => {
		const file = put(path.join(tmp, 'load2', '.yenarules'), '[deny read]\na\n');
		const first = await loadRules(file);
		assert.equal((await loadRules(file)).loaded, first.loaded);
		writeFileSync(file, '[deny read]\nab\n');
		const next = await loadRules(file);
		assert.notEqual(next.key, first.key);
		assert.notEqual(next.loaded, first.loaded);
	});
});

describe('glob forms', () => {
	it('an unanchored name matches at any depth, a leading or inner slash anchors to the rules folder', async () => {
		rulesAt(app, '[deny read]\nsecret.txt\n/top.txt\nsub/inner.txt\n');
		assert.equal(await levels('secret.txt'), 'deny/deny');
		assert.equal(await levels('a/b/secret.txt'), 'deny/deny');
		assert.equal(await levels('top.txt'), 'deny/deny');
		assert.equal(await levels('a/top.txt'), 'free/free');
		assert.equal(await levels('sub/inner.txt'), 'deny/deny');
		assert.equal(await levels('x/sub/inner.txt'), 'free/free');
	});

	it('"*" matches dotfiles but not a slash, "?" and a class match one character', async () => {
		rulesAt(app, '[deny read]\n*.key\n/d/*\n?.x\n[ab].y\n[!ab].z\n');
		assert.equal(await levels('.hidden.key'), 'deny/deny');
		assert.equal(await levels('d/.dot'), 'deny/deny');
		assert.equal(await levels('d/sub/file'), 'deny/deny', 'inside a matched folder');
		assert.equal(await levels('a.x'), 'deny/deny');
		assert.equal(await levels('ab.x'), 'free/free');
		assert.equal(await levels('a.y'), 'deny/deny');
		assert.equal(await levels('c.y'), 'free/free');
		assert.equal(await levels('c.z'), 'deny/deny');
		assert.equal(await levels('a.z'), 'free/free');
	});

	it('"**/", "/**" and "/**/" match folders at any depth', async () => {
		rulesAt(app, '[deny write]\n**/gen/out\n/lib/**\n/a/**/z.txt\n');
		assert.equal(await levels('gen/out/f'), 'free/deny');
		assert.equal(await levels('x/y/gen/out'), 'free/deny');
		assert.equal(await levels('lib/a/b'), 'free/deny');
		assert.equal(await levels('lib'), 'free/free');
		for (const rel of ['a/z.txt', 'a/b/z.txt', 'a/b/c/z.txt']) assert.equal(await levels(rel), 'free/deny', rel);
		assert.equal(await levels('b/z.txt'), 'free/free');
	});

	it('a trailing slash matches folders only, and everything inside them', async () => {
		rulesAt(app, '[deny read]\nsecrets/\n');
		put(path.join(app, 'secrets', 'k'), 'x');
		put(path.join(app, 'other', 'secrets'), 'a file, not a folder');
		assert.equal(await levels('secrets', true), 'deny/deny');
		assert.equal(await levels('secrets/k'), 'deny/deny');
		assert.equal(await levels('secrets/deep/k'), 'deny/deny');
		assert.equal(await levels('other/secrets'), 'free/free');
		assert.equal(await levels('other/secrets', false), 'free/free');
	});

	it('escapes keep "#" and "!" literal; patterns are case-sensitive', async () => {
		rulesAt(app, '[deny read]\n\\#notes\n\\!bang\nCaps.txt\n');
		assert.equal(await levels('#notes'), 'deny/deny');
		assert.equal(await levels('!bang'), 'deny/deny');
		assert.equal(await levels('caps.txt'), 'free/free');
		assert.equal(await levels('Caps.txt'), 'deny/deny');
	});
});

describe('sections and negation', () => {
	it('deny read implies deny write, ask read does not imply a write verdict, deny write beats ask write', async () => {
		rulesAt(app, '[deny read]\nr1\n[ask read]\nr2\n[deny write]\nw1\nboth\n[ask write]\nw2\nboth\n');
		assert.equal(await levels('r1'), 'deny/deny');
		assert.equal(await levels('r2'), 'ask/free');
		assert.equal(await levels('w1'), 'free/deny');
		assert.equal(await levels('w2'), 'free/ask');
		assert.equal(await levels('both'), 'free/deny');
	});

	it('a "!" line re-includes a file under a matched folder inside its own section', async () => {
		rulesAt(app, '[deny write]\nscripts/\n!scripts/x.sh\n[ask write]\nscripts/x.sh\n');
		assert.equal(await levels('scripts/x.sh'), 'free/ask');
		assert.equal(await levels('scripts/y.sh'), 'free/deny');
		assert.equal(await levels('scripts/new.sh'), 'free/deny');
	});

	it('env templates and public keys stay readable under the secrets block', async () => {
		rulesAt(app, '[deny read]\n.env*\n!.env.example\nid_rsa*\n!*.pub\n');
		assert.equal(await levels('.env'), 'deny/deny');
		assert.equal(await levels('sub/.env.local'), 'deny/deny');
		assert.equal(await levels('.env.example'), 'free/free');
		assert.equal(await levels('id_rsa'), 'deny/deny');
		assert.equal(await levels('id_rsa.pub'), 'free/free');
	});

	it('a "!" in another section or another file lifts nothing', async () => {
		rulesAt(app, '[deny read]\nsecrets/\n[ask read]\n!secrets/k\n');
		put(path.join(app, 'sub', 'secrets', 'k'), 'x');
		rulesAt(path.join(app, 'sub'), '[deny read]\n!secrets/k\n');
		assert.equal(await levels('secrets/k'), 'deny/deny');
		assert.equal(await levels('sub/secrets/k'), 'deny/deny', 'the outer file still denies it');
	});

	it('the last matching line decides', async () => {
		rulesAt(app, '[deny read]\n*.log\n!keep.log\n*.log\n');
		assert.equal(await levels('keep.log'), 'deny/deny');
	});
});

describe('sources', () => {
	it('nested files and the project file all apply (a union)', async () => {
		rulesAt(app, '[deny read]\nouter\n');
		rulesAt(path.join(app, 'pkg'), '[deny write]\ninner\n');
		put(rulesFile('app') as string, '[ask read]\nfrom-project\n');
		assert.equal(await levels('outer'), 'deny/deny');
		assert.equal(await levels('pkg/inner'), 'free/deny');
		assert.equal(await levels('inner'), 'free/free', 'a nested file covers its own folder only');
		assert.equal(await levels('from-project'), 'ask/free');
		assert.equal(await levels('pkg/from-project'), 'ask/free');
	});

	it('the project file applies to a stage: from the state list and from the name prefix', async () => {
		put(rulesFile('app') as string, '[deny read]\nsecret\n');
		const listed = path.join(stage, 'app-stage-ab12cd34-1');
		const byName = path.join(stage, 'app-stage-ab12cd34-2');
		mkdirSync(listed, {recursive: true});
		mkdirSync(byName, {recursive: true});
		stages = [{path: listed, project: 'app'}];
		assert.equal(await levels('secret', undefined, listed), 'deny/deny');
		stages = [];
		assert.equal(await levels('secret', undefined, byName), 'deny/deny');
		assert.equal(await levels('secret', undefined, path.join(stage, 'other-stage-ab12cd34-1')), 'free/free');
		stages = undefined;
	});

	it('a reader without rulesFile gives in-repo rules only', async () => {
		put(rulesFile('app') as string, '[deny read]\nfrom-project\n');
		rulesAt(app, '[deny read]\nin-repo\n');
		const plain: RulesScope = {roots: [app], projects: async () => access()};
		assert.equal((await verdict('from-project', undefined, app, plain)).read, 'free');
		assert.equal((await verdict('in-repo', undefined, app, plain)).read, 'deny');
	});

	it('a path outside every base is free', async () => {
		rulesAt(app, '[deny read]\n*\n');
		const outside = path.join(tmp, 'elsewhere', 'x');
		assert.equal((await rulesVerdict(outside, scope)).read, 'free');
		assert.equal((await rulesVerdict(path.join(workplace, 'other', 'x'), scope)).read, 'free');
	});

	it('a rules change applies on the next call', async () => {
		const file = rulesAt(app, '[deny read]\nx.txt\n');
		assert.equal(await levels('x.txt'), 'deny/deny');
		writeFileSync(file, '[deny read]\nyy.txt\n');
		assert.equal(await levels('x.txt'), 'free/free');
		assert.equal(await levels('yy.txt'), 'deny/deny');
		rmSync(file);
		assert.equal(await levels('yy.txt'), 'free/free');
	});

	it('a symlinked target is judged at its real location', async () => {
		rulesAt(app, '[deny read]\nreal-secret\n');
		put(path.join(app, 'real-secret'), 'x');
		symlinkSync(path.join(app, 'real-secret'), path.join(app, 'innocent-link'));
		assert.equal(await levels('innocent-link'), 'free/free', 'the verdict itself takes a resolved path');
		assert.equal(await levels('real-secret'), 'deny/deny');
	});
});

describe('built in protection and malformed files', () => {
	it('any .yenarules is deny write, existing or new, at any depth, and stays readable', async () => {
		assert.equal(await levels('.yenarules'), 'free/deny');
		assert.equal(await levels('a/b/c/.yenarules'), 'free/deny');
		const v = await verdict('.yenarules');
		assert.equal(v.kind, 'rules-file');
		assert.equal((await rulesVerdict(path.join(tmp, 'elsewhere', '.yenarules'), scope)).write, 'deny');
	});

	it('anything in the project rules folder is deny write, even outside every root', async () => {
		const v = await rulesVerdict(path.join(ruleData, 'app.yenarules'), scope);
		assert.equal(v.write, 'deny');
		assert.equal((await rulesVerdict(path.join(ruleData, 'anything'), scope)).write, 'deny');
	});

	it('a malformed file closes everything under its folder, keeps itself readable and names the problem', async () => {
		const file = rulesAt(path.join(app, 'broken'), '[deny read]\nfine\n[oops]\n');
		const inside = await verdict('broken/anything.txt');
		assert.equal(inside.read, 'deny');
		assert.equal(inside.write, 'deny');
		assert.equal(inside.kind, 'malformed');
		assert.equal(inside.malformed?.line, 3);
		assert.equal(inside.malformed?.file, file);
		assert.equal(await levels('broken/.yenarules'), 'free/deny');
		assert.equal(await levels('outside.txt'), 'free/free');
	});

	it('a symlinked .yenarules is malformed and is not followed', async () => {
		put(path.join(app, 'real-rules'), '[deny read]\nnothing\n');
		const dir = path.join(app, 'linked');
		mkdirSync(dir, {recursive: true});
		symlinkSync(path.join(app, 'real-rules'), path.join(dir, '.yenarules'));
		const v = await verdict('linked/file.txt');
		assert.equal(v.read, 'deny');
		assert.match(v.malformed?.problem ?? '', /not a regular file/);
	});

	it('a malformed project file closes the project', async () => {
		put(rulesFile('app') as string, 'not a header\n');
		const v = await verdict('anything');
		assert.equal(v.read, 'deny');
		assert.match(v.malformed?.file ?? '', /project's rules \(app\)/);
	});
});

describe('expandRules', () => {
	const fresh = (name: string): string => {
		const dir = path.join(tmp, `wp-${name}`, name);
		mkdirSync(dir, {recursive: true});
		return dir;
	};
	const scopeOf = (dir: string): RulesScope => ({roots: [dir], projects: async () => ({roots: [path.dirname(dir), stage], docs: '', managed: [], writable: []}), rulesFile});

	it('lists concrete paths per section, emitting the topmost folder that is wholly in', async () => {
		const dir = fresh('exp1');
		rulesAt(dir, '[deny read]\n.env*\nsecrets/\n[ask read]\nnotes.md\n[deny write]\n/scripts/\n[ask write]\n**/.git/config\n');
		for (const f of ['.env', '.env.local', 'secrets/a', 'secrets/deep/b', 'notes.md', 'scripts/x.sh', '.git/config', '.git/HEAD', 'src/a.ts']) put(path.join(dir, f), 'x');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.denyRead.sort(), [path.join(dir, '.env'), path.join(dir, '.env.local'), path.join(dir, 'secrets')].sort());
		assert.deepEqual(e.askRead, [path.join(dir, 'notes.md')]);
		assert.deepEqual(e.denyWrite, [path.join(dir, 'scripts')]);
		assert.deepEqual(e.askWrite, [path.join(dir, '.git', 'config')]);
		assert.deepEqual(e.rulesFiles, [path.join(dir, '.yenarules')]);
		assert.equal(e.truncated, false);
		assert.deepEqual(e.problems, []);
	});

	it('splits a folder around a negation instead of emitting it whole', async () => {
		const dir = fresh('exp2');
		rulesAt(dir, '[deny write]\nscripts/\n!scripts/x.sh\n');
		for (const f of ['scripts/x.sh', 'scripts/y.sh', 'scripts/sub/z.sh']) put(path.join(dir, f), 'x');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.denyWrite.sort(), [path.join(dir, 'scripts', 'sub'), path.join(dir, 'scripts', 'y.sh')].sort());
	});

	it('still emits a folder whole when a negation matches nothing under it', async () => {
		const dir = fresh('exp3');
		rulesAt(dir, '[deny read]\n.hyena/\n.env*\n!.env.example\n');
		put(path.join(dir, '.hyena', 'a', 'b'), 'x');
		put(path.join(dir, '.env.example'), 'x');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.denyRead, [path.join(dir, '.hyena')]);
	});

	it('skips node_modules, goes one level into .git, and never descends into .yena', async () => {
		const dir = fresh('exp4');
		rulesAt(dir, '[deny read]\n.env\n[deny write]\n**/.git/hooks/\n.yena/\n');
		for (const f of ['node_modules/p/.env', '.git/hooks/pre', '.git/objects/ab/cd', '.yena/a/.env', 'src/.env']) put(path.join(dir, f), 'x');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.denyRead, [path.join(dir, 'src', '.env')]);
		assert.deepEqual(e.denyWrite.sort(), [path.join(dir, '.git', 'hooks'), path.join(dir, '.yena')].sort());
	});

	it('a malformed file puts its whole folder into deny read and reports the problem', async () => {
		const dir = fresh('exp5');
		rulesAt(path.join(dir, 'bad'), '[nope]\n');
		put(path.join(dir, 'bad', 'f'), 'x');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.denyRead, [path.join(dir, 'bad')]);
		assert.equal(e.problems.length, 1);
		assert.equal(e.problems[0]?.line, 1);
	});

	it('the project file counts, and does not need a file in the repo', async () => {
		const dir = fresh('exp6');
		put(path.join(dir, 'a.txt'), 'x');
		put(rulesFile('exp6') as string, '[ask write]\na.txt\n');
		const e = await expandRules(scopeOf(dir));
		assert.deepEqual(e.askWrite, [path.join(dir, 'a.txt')]);
	});

	it('stops at the cap and says so', async () => {
		const dir = fresh('exp7');
		rulesAt(dir, '[deny read]\n*.k\n');
		for (let i = 0; i < 30; i++) put(path.join(dir, `f${i}.k`), 'x');
		const e = await expandRules(scopeOf(dir), {maxEntries: 10});
		assert.equal(e.truncated, true);
		assert.ok(e.denyRead.length < 30);
	});

	it('caches for the TTL and re-reads when a source file changes', async () => {
		const dir = fresh('exp8');
		const file = rulesAt(dir, '[deny read]\na\n');
		put(path.join(dir, 'a'), 'x');
		put(path.join(dir, 'b'), 'x');
		let t = 0;
		const opts = {now: () => t, ttlMs: 1000};
		assert.deepEqual((await expandRules(scopeOf(dir), opts)).denyRead, [path.join(dir, 'a')]);
		put(path.join(dir, 'c'), 'x');
		rulesAt(dir, '[deny read]\na\nc\n');
		assert.deepEqual((await expandRules(scopeOf(dir), opts)).denyRead.sort(), [path.join(dir, 'a'), path.join(dir, 'c')], 'a changed source invalidates');
		rmSync(path.join(dir, 'a'));
		t = 500;
		assert.equal((await expandRules(scopeOf(dir), opts)).denyRead.length, 2, 'within the TTL the listing is reused');
		t = 2000;
		assert.deepEqual((await expandRules(scopeOf(dir), opts)).denyRead, [path.join(dir, 'c')]);
		assert.ok(file);
	});

	it('entriesInside finds the entries under a folder', () => {
		assert.deepEqual(entriesInside(['/a/b/c', '/a/bc', '/a/b'], '/a/b'), ['/a/b/c', '/a/b']);
	});
});
