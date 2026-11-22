import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {analyzeBash, bashRulesVerdict} from '../../src/chat/bash-paths.js';
import {resetRulesCaches, type RulesScope} from '../../src/rules.js';

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-bypass-')));
after(() => rmSync(root, {recursive: true, force: true}));
const wp = path.join(root, 'wp');
const proj = path.join(wp, 'proj');
const put = (rel: string, text = 'x') => {
	mkdirSync(path.dirname(path.join(proj, rel)), {recursive: true});
	writeFileSync(path.join(proj, rel), text);
};
put('.yenarules', '[deny read]\n.env*\nsecrets/\n');
for (const f of ['.env', 'secrets/x', 'README.md', 'src/a.ts']) put(f);
const scope: RulesScope = {roots: [proj], projects: async () => ({roots: [wp, path.join(root, 'stage')], docs: '', managed: [], writable: []})};
const run = async (command: string) => {
	resetRulesCaches();
	return (await bashRulesVerdict(analyzeBash(command, proj), scope)).decision;
};

describe('git object paths and pathspecs', () => {
	it('deny a read of a deny-read file through a revision path or a pathspec', async () => {
		for (const c of ['git show HEAD:.env', 'git cat-file -p HEAD:.env', 'git show :0:.env', 'git show :.env', 'git grep x -- .env', 'git log -p -- secrets/', 'git archive HEAD .env', 'git show main:secrets/x', 'git diff HEAD -- .env', 'git rev-parse HEAD:.env', 'git blame -- .env']) {
			assert.equal(await run(c), 'deny', c);
		}
	});

	it('allow what names nothing closed: other paths, and git commands without pathspecs', async () => {
		for (const c of ['git show HEAD:README.md', 'git diff', 'git log -p', 'git add .', 'git status', 'git grep x -- src', 'git show HEAD', 'git clone https://example.com/a.git']) {
			assert.equal(await run(c), 'allow', c);
		}
	});

	it('read of .yenarules is allowed, a write to it is denied by name', async () => {
		assert.equal(await run('cat .yenarules'), 'allow');
		for (const c of ['echo x > .yenarules', 'rm .yenarules', 'cd src && rm ../.yenarules', 'tee sub/.yenarules']) assert.equal(await run(c), 'deny', c);
	});
});
