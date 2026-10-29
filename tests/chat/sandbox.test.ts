import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'node:test';
import {
	buildSandbox,
	createSandboxSync,
	missingSandboxTools,
	SANDBOX_DOMAINS,
	sandboxProblem,
	sandboxStarts,
	type SandboxSettings,
} from '../../src/chat/sandbox.js';

const paths = {
	projectDir: '/app',
	mdDir: '/data/claude/md',
	hubDir: '/data/md',
	configDir: '/data/claude/config',
	stateFile: '/data/claude/state.json',
	credentialsFile: '/data/claude/credentials.json',
	accountSecrets: {dataDir: '/data/account', secretDirs: ['/data/account/secrets', '/data/account/keys']},
	projects: {dataDir: '/data/project', read: async () => undefined, readSync: () => undefined},
	hostState: '/data/host',
};

const tree: Record<string, string[]> = {
	'/workplace': ['yena', 'shop', 'notes.txt'],
	'/stage': ['yena-1', 'shop-1'],
	'/data/md/projects': ['yena', 'shop'],
	'/data/claude/config': ['plans', 'projects', 'settings.json', 'agents'],
};
const list = (dir: string) => tree[dir] ?? [];

const access = (writable: string[]) => ({
	roots: ['/workplace', '/stage'],
	docs: '/data/md/projects',
	managed: ['/workplace', '/stage', '/data/md/projects'],
	writable,
});

test('the sandbox denies writes to every project that is not isolated, and nothing above an isolated one', () => {
	const box = buildSandbox(paths, access(['/workplace/yena', '/data/md/projects/yena', '/stage/yena-1']), list, '/root');
	const deny = box.filesystem.denyWrite;
	for (const p of ['/workplace/shop', '/workplace/notes.txt', '/stage/shop-1', '/data/md/projects/shop']) assert.ok(deny.includes(p), p);
	for (const p of ['/workplace', '/workplace/yena', '/stage/yena-1', '/data/md/projects', '/data/md/projects/yena']) {
		assert.ok(!deny.includes(p), `${p} must stay writable`);
	}
});

test('with nothing isolated every project is read-only for Bash', () => {
	const deny = buildSandbox(paths, access([]), list, '/root').filesystem.denyWrite;
	for (const p of ['/workplace/yena', '/workplace/shop', '/stage/yena-1', '/data/md/projects/yena']) assert.ok(deny.includes(p), p);
});

test('a writable folder deeper inside a managed dir splits its parent instead of denying it', () => {
	const nested = (dir: string) => ({'/workplace': ['group'], '/workplace/group': ['a', 'b']})[dir] ?? [];
	const deny = buildSandbox(paths, {...access(['/workplace/group/a']), managed: ['/workplace']}, nested, '/root').filesystem.denyWrite;
	assert.ok(deny.includes('/workplace/group/b'));
	assert.ok(!deny.includes('/workplace/group'));
	assert.ok(!deny.includes('/workplace/group/a'));
});

test('the Claude config dir is read-only for Bash except plans, and the hub instructions are protected', () => {
	const deny = buildSandbox(paths, undefined, list, '/root').filesystem.denyWrite;
	for (const p of ['/data/claude/config/projects', '/data/claude/config/settings.json', '/data/claude/config/agents']) assert.ok(deny.includes(p), p);
	assert.ok(!deny.includes('/data/claude/config/plans'));
	assert.ok(!deny.includes('/data/claude/config'));
	assert.ok(deny.includes('/data/md/CLAUDE.md'));
	assert.ok(deny.includes('/data/md/SOUL.md'));
});

test('the sandbox hides the secrets from Bash', () => {
	const read = buildSandbox(paths, undefined, list, '/root').filesystem.denyRead;
	for (const p of [
		'/proc',
		paths.credentialsFile,
		'/data/claude/accounts.json',
		'/data/claude/accounts',
		paths.stateFile,
		'/data/claude/config/.credentials.json',
		'/data/claude/config/.claude.json',
		'/data/claude/config/backups',
		'/data/claude/config/history.jsonl',
		'/data/claude/config/projects',
		'/data/account/secrets',
		'/data/account/keys',
		'/data/project',
		'/data/host',
		'/app/.yena',
		path.join('/root', '.ssh'),
	]) {
		assert.ok(read.includes(p), p);
	}
});

test('the sandbox cannot be skipped and keeps the prompts', () => {
	const box = buildSandbox(paths, undefined, list, '/root');
	assert.equal(box.enabled, true);
	assert.equal(box.allowUnsandboxedCommands, false);
	assert.equal(box.autoAllowBashIfSandboxed, false);
	assert.deepEqual(box.network.allowedDomains, SANDBOX_DOMAINS);
});

test('the sync applies a sandbox only when isolation changed it, and tries again after a failure', async () => {
	let current = 'a';
	const applied: string[] = [];
	let fail = false;
	const make = (tag: string) => ({filesystem: {denyWrite: [tag]}}) as unknown as SandboxSettings;
	const sync = createSandboxSync(
		async () => make(current),
		async s => {
			if (fail) throw new Error('rejected');
			applied.push(s.filesystem.denyWrite[0] as string);
		},
	);
	sync.spawned(make('a'));
	await sync.refresh();
	assert.deepEqual(applied, []);
	current = 'b';
	await sync.refresh();
	assert.deepEqual(applied, ['b']);
	current = 'c';
	fail = true;
	await assert.rejects(sync.refresh());
	fail = false;
	await sync.refresh();
	assert.deepEqual(applied, ['b', 'c']);
});

test('missing sandbox tools are named', () => {
	const has = (set: string[]) => (file: string) => set.includes(file);
	assert.deepEqual(missingSandboxTools('/usr/bin:/bin', has(['/usr/bin/bwrap', '/usr/bin/socat'])), []);
	assert.deepEqual(missingSandboxTools('/usr/bin', has(['/usr/bin/socat'])), ['bwrap']);
	assert.deepEqual(missingSandboxTools(undefined, has([])), ['bwrap', 'socat']);
});

test('a sandbox that is installed but cannot start is a problem too, so Bash is not left failing', () => {
	const all = () => true;
	assert.equal(sandboxProblem('/usr/bin', () => true, all), undefined);
	assert.match(sandboxProblem('/usr/bin', () => false, all) ?? '', /cannot create its namespaces/);
	let probed = false;
	const problem = sandboxProblem('/usr/bin', () => (probed = true), () => false);
	assert.match(problem ?? '', /bwrap, socat not installed/);
	assert.equal(probed, false, 'no probe without the tools');
});

test('the start probe runs bubblewrap with new namespaces and reports its exit', () => {
	let seen: string[] = [];
	assert.equal(
		sandboxStarts((cmd, args) => {
			seen = [cmd, ...args];
			return {status: 0};
		}),
		true,
	);
	assert.equal(seen[0], 'bwrap');
	assert.ok(seen.includes('--unshare-user'));
	assert.equal(sandboxStarts(() => ({status: 1})), false);
	assert.equal(
		sandboxStarts(() => {
			throw new Error('ENOENT');
		}),
		false,
	);
});

test('unix sockets are open only with the account agents, and the chat sockets stay hidden', () => {
	const box = buildSandbox(paths, undefined, list, '/root', {socketDirs: ['/tmp/yena-claude-0/session']});
	assert.equal(box.network.allowAllUnixSockets, true);
	assert.ok(box.filesystem.denyRead.includes('/tmp/yena-claude-0/session'));
	const {accountSecrets: _, ...withoutAccounts} = paths;
	assert.equal(buildSandbox(withoutAccounts, undefined, list, '/root').network.allowAllUnixSockets, undefined);
});

test('a start without project denies is wider than any access, so isolation can only narrow it', () => {
	const real = access(['/workplace/yena']);
	const start = buildSandbox(paths, {...real, managed: []}, list, '/root').filesystem.denyWrite;
	assert.ok(!start.some(p => p.startsWith('/workplace') || p.startsWith('/stage') || p.startsWith('/data/md/projects')));
	const narrowed = buildSandbox(paths, real, list, '/root').filesystem.denyWrite;
	for (const p of start) assert.ok(narrowed.includes(p), p);
});
