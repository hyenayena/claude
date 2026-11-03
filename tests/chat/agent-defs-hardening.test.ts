import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {buildAgentDefinitions, peekAgentFile, readAgentFile} from '../../src/chat/agent-defs.js';
import {DEFAULT_TIERS} from '../../src/chat/tiers.js';
import {CACHE_TTL_MS, decideMain, SMALL_CONTEXT} from '../../src/chat/router.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const root = mkdtempSync(path.join(tmpdir(), 'agent-defs-hard-'));
after(() => rmSync(root, {recursive: true, force: true}));
let n = 0;
const dir = () => {
	const d = path.join(root, `case-${++n}`);
	mkdirSync(d, {recursive: true});
	return d;
};
const write = (d: string, file: string, text: string) => {
	writeFileSync(path.join(d, file), text);
	return path.join(d, file);
};
const head = (extra: string) => `---\nname: x\ndescription: d\nmodel: max\n${extra}\n---\nbody\n`;

test('privileged keys never reach a definition in any casing, dash or underscore variant', async () => {
	const d = dir();
	const keys = [
		'permissionMode: bypassPermissions',
		'PermissionMode: bypassPermissions',
		'permission-mode: bypassPermissions',
		'PERMISSION_MODE: bypassPermissions',
		'allowed-tools: Bash',
		'allowedTools: Bash',
		'Allowed_Tools: Bash',
		'ALLOWED-TOOLS: Bash',
		'mcpServers: x',
		'mcp-servers: x',
		'MCP_SERVERS: x',
		'Hooks: x',
		'initialPrompt: x',
		'isolation: worktree',
		'permissionMode : bypassPermissions',
		'"permissionMode": bypassPermissions',
		'\tpermissionMode: bypassPermissions',
		' permissionMode: bypassPermissions',
	];
	keys.forEach((k, i) => write(d, `a${i}.md`, head(k)));
	const defs = await buildAgentDefinitions({dirs: [d], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(Object.keys(defs), []);
	for (let i = 0; i < keys.length; i++) assert.ok('skip' in (await readAgentFile(path.join(d, `a${i}.md`))), keys[i]);
});

test('a privileged key hidden after a duplicate or inside CRLF or BOM frontmatter still skips the file', async () => {
	const d = dir();
	const crlf = write(d, 'crlf.md', head('permissionMode: acceptEdits').replace(/\n/g, '\r\n'));
	const bom = write(d, 'bom.md', `﻿${head('hooks: x')}`);
	const dup = write(d, 'dup.md', head('tools: Read\nmodel: haiku\nmcpServers: y'));
	for (const f of [crlf, bom, dup]) assert.deepEqual(await readAgentFile(f), {skip: 'key'}, f);
});

test('symlinked files and folders named like agents are never followed', async () => {
	const d = dir();
	const outside = dir();
	const target = write(outside, 'real.md', head(''));
	symlinkSync(target, path.join(d, 'link.md'));
	mkdirSync(path.join(d, 'folder.md'));
	write(path.join(d, 'folder.md'), 'inner.md', head(''));
	assert.ok('skip' in (await readAgentFile(path.join(d, 'link.md'))));
	assert.ok('skip' in (await readAgentFile(path.join(d, 'folder.md'))));
	assert.equal(await peekAgentFile(path.join(d, 'link.md')), undefined);
	assert.equal(await peekAgentFile(path.join(d, 'folder.md')), undefined);
	const defs = await buildAgentDefinitions({dirs: [d], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(Object.keys(defs), []);
});

test('a missing or empty folder gives no definitions and no error', async () => {
	const d = dir();
	const defs = await buildAgentDefinitions({dirs: [path.join(d, 'nope'), d], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(defs, {});
});

test('a hostile name or description cannot smuggle a definition: bad names skip the file', async () => {
	const d = dir();
	for (const name of ['../x', 'a b', 'x;y', '']) write(d, `n${name.length}.md`, `---\nname: ${name}\ndescription: d\nmodel: max\n---\nb\n`);
	const defs = await buildAgentDefinitions({dirs: [d], map: DEFAULT_TIERS, log: makeFakeLog()});
	assert.deepEqual(Object.keys(defs).filter(k => k.includes('/') || k.includes(' ') || k.includes(';')), []);
});

test('peek is lenient: a file the strict reader skips still yields its name and model', async () => {
	const d = dir();
	const f = write(d, 'p.md', head('permissionMode: plan\nmodel: opus'));
	assert.deepEqual(await readAgentFile(f), {skip: 'key'});
	const peek = await peekAgentFile(f);
	assert.equal(peek?.name, 'x');
	assert.equal(peek?.model, 'opus');
});

test('decideMain boundaries: exactly the TTL and exactly the small context are still warm', () => {
	const base = {prev: 'strong', rated: 'light', now: 1_000_000} as const;
	const warm = {sessionKnown: true, lastMainAt: base.now - CACHE_TTL_MS, lastContext: SMALL_CONTEXT};
	assert.deepEqual(decideMain({...base, cache: warm}), {tier: 'strong', held: true});
	assert.equal(decideMain({...base, cache: {...warm, lastMainAt: warm.lastMainAt - 1}}).tier, 'light');
	assert.equal(decideMain({...base, cache: {...warm, lastContext: SMALL_CONTEXT - 1}}).tier, 'light');
	assert.equal(decideMain({...base, cache: {sessionKnown: true, lastMainAt: base.now}}).tier, 'light', 'unknown context counts as cold');
	assert.equal(decideMain({...base, cache: {sessionKnown: true, lastContext: SMALL_CONTEXT}}).tier, 'light', 'unknown last turn counts as cold');
});
