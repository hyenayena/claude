import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {analyzeBash, bashRulesVerdict} from '../src/chat/bash-paths.js';
import {type RulesIndexReader, rulesLists, rulesVerdict} from '../src/deps/rules.js';

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-rules-index-')));
after(() => rmSync(tmp, {recursive: true, force: true}));

const put = (file: string, text = 'x') => {
	mkdirSync(path.dirname(file), {recursive: true});
	writeFileSync(file, text);
};

const lists = (denyRead: string[]) => ({denyRead, askRead: [], denyWrite: [], askWrite: [], denyExport: denyRead, rulesFiles: [], problems: [], truncated: false, builtAt: 0, persisted: true});
const fakeIndex = (denyRead: string[]): RulesIndexReader => ({
	get: async () => lists(denyRead),
	layout: async () => undefined,
	setLayoutSource() {},
	setProjects() {},
});

describe('rules from the index', () => {
	it('rulesLists reads the index when the scope has one and expands live otherwise', async () => {
		const proj = path.join(tmp, 'proj');
		put(path.join(proj, '.yenarules'), '[deny read]\nlive.txt\n');
		put(path.join(proj, 'live.txt'));
		assert.deepEqual((await rulesLists({roots: [proj]})).denyRead, [path.join(proj, 'live.txt')]);
		const indexed = await rulesLists({roots: [proj], index: fakeIndex(['/from/index'])});
		assert.deepEqual(indexed.denyRead, ['/from/index']);
	});

	it('a Bash command that touches a folder holding an indexed deny path is refused', async () => {
		const proj = path.join(tmp, 'bashproj');
		put(path.join(proj, 'sub', 'secret'));
		const scope = {roots: [proj], index: fakeIndex([path.join(proj, 'sub', 'secret')])};
		assert.equal((await bashRulesVerdict(analyzeBash('tar -czf a.tgz sub', proj), scope)).decision, 'deny');
		assert.equal((await bashRulesVerdict(analyzeBash('cat sub/other', proj), scope)).decision, 'allow');
	});

	it('an "@" deny read line of a module root closes a path of its data folder for the file tools', async () => {
		const code = path.join(tmp, 'modules', 'm');
		const data = path.join(tmp, 'data', 'm');
		put(path.join(code, 'yena.json'), '{}');
		put(path.join(code, '.yenarules'), '[deny read]\n@private/\n');
		put(path.join(data, 'private', 'k'));
		put(path.join(data, 'public', 'k'));
		const scope = {roots: [path.join(tmp, 'elsewhere')], modules: async () => [{name: 'm', codeDir: code, dataDir: data}]};
		assert.equal((await rulesVerdict(path.join(data, 'private', 'k'), scope)).read, 'deny');
		assert.equal((await rulesVerdict(path.join(data, 'public', 'k'), scope)).read, 'free');
	});
});
