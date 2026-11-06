import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createChatEngine} from '../../src/chat/engine.js';
import {cliTmpOf} from '../../src/chat/shell-tmp.js';
import {storeSecret, type CredentialOpts} from '../../src/credentials.js';
import {procStart} from '../../src/sessions/proc.js';
import type {ChatQueryFn} from '../../src/types.js';
import {hostVault} from '../../src/vault.js';
import {fakeCredentials} from '../helpers/fake-credentials.js';
import {makeFakeLog} from '../helpers/fake-log.js';

const KEY = 'sk-ant-api03-AAAAVALUE0123456789abcdef';

const start = async (seedParent?: (parent: string) => void) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-engine-scratch-')));
	const dataDir = join(root, 'data', 'claude');
	const moduleDir = join(root, 'proj', 'modules', 'claude');
	await mkdir(moduleDir, {recursive: true});
	const shell = join(root, 'shell');
	mkdirSync(shell, {mode: 0o700});
	const parent = join(cliTmpOf(shell, process.getuid?.() ?? 0), 'scratch');
	mkdirSync(parent, {recursive: true, mode: 0o700});
	seedParent?.(parent);
	const log = makeFakeLog();
	const vault = hostVault(fakeCredentials(), log);
	const opts: CredentialOpts = {env: {}, dataDir, vault, log};
	await storeSecret(opts, KEY, 'a');
	const query: ChatQueryFn = () => {
		throw new Error('no query expected');
	};
	const engine = await createChatEngine(
		{fresh: true},
		{
			dataDir,
			moduleDir,
			env: {},
			log,
			vault,
			loadChatQuery: async () => query,
			store: {read: async () => ({})},
			isMissingModule: () => false,
			shellTmp: () => shell,
			sandboxProblem: () => 'unavailable',
			idleCloseMs: 60_000,
		},
		{stateUpdate: async () => undefined, warn: () => undefined},
	);
	return {engine, parent};
};

const seed = (parent: string, id: string, owner: object) => {
	mkdirSync(join(parent, id), {mode: 0o700});
	writeFileSync(join(parent, `${id}.owner`), JSON.stringify({v: 1, ...owner}));
};
const dirs = (parent: string) => readdirSync(parent).filter(n => !n.endsWith('.owner')).sort();

test('the engine creates a scratch folder and removes it on close', async () => {
	const {engine, parent} = await start();
	const [id] = dirs(parent);
	assert.ok(id && /^[0-9a-f]{8}$/.test(id));
	assert.ok(existsSync(join(parent, `${id}.owner`)));
	engine.close();
	assert.deepEqual(readdirSync(parent), []);
});

test('the engine sweeps stale scratch folders at start and keeps a live one', async () => {
	const {engine, parent} = await start(p => {
		seed(p, '00000001', {pid: 999999, procStart: '1'});
		seed(p, '00000002', {pid: process.pid, procStart: '1'});
		seed(p, '00000003', {pid: process.pid, procStart: procStart(process.pid)});
	});
	const left = dirs(parent);
	assert.ok(!left.includes('00000001'));
	if (procStart(process.pid) !== undefined) assert.ok(!left.includes('00000002'));
	assert.ok(left.includes('00000003'));
	engine.close();
	assert.ok(dirs(parent).includes('00000003'));
});
