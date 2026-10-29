import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
	LOGIN_USAGE,
	parseLoginArgs,
	parseLoginStatus,
	probeLogin,
	runLogout,
} from '../src/claude-login.js';
import {cliEnv, resolvePaths} from '../src/config.js';

const j = (o: unknown) => JSON.stringify(o);
const base = {projectsDirectory: '/p', configDirectory: '/c', apiProvider: 'firstParty', analyticsDisabled: false};

test('parseLoginStatus: logged out', () => {
	assert.deepEqual(parseLoginStatus(j({loggedIn: false, authMethod: 'none', ...base})), {loggedIn: false});
});

test('parseLoginStatus: claude.ai keeps valid subscriptionType and email, drops org', () => {
	const s = parseLoginStatus(
		j({loggedIn: true, authMethod: 'claude.ai', email: 'a.b+c@example.com', orgId: 'o', orgName: 'Org', subscriptionType: 'max', ...base}),
	);
	assert.deepEqual(s, {loggedIn: true, method: 'claude.ai', subscriptionType: 'max', email: 'a.b+c@example.com'});
});

test('parseLoginStatus: invalid email and subscriptionType are dropped', () => {
	for (const email of ['x', '-a@b.co', 'a@b', 'a b@c.de', 'a@b.co\u001b[31m', 'a'.repeat(250) + '@b.co']) {
		const s = parseLoginStatus(j({loggedIn: true, authMethod: 'claude.ai', email, subscriptionType: 'bad type!'}));
		assert.deepEqual(s, {loggedIn: true, method: 'claude.ai'}, email);
	}
	assert.equal(parseLoginStatus(j({loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'x'.repeat(33)}))?.subscriptionType, undefined);
});

test('parseLoginStatus: managed key is console, other api keys are not a login', () => {
	assert.deepEqual(parseLoginStatus(j({loggedIn: true, authMethod: 'api_key', apiKeySource: '/login managed key'})), {
		loggedIn: true,
		method: 'console',
	});
	assert.deepEqual(parseLoginStatus(j({loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY'})), {loggedIn: false});
	assert.deepEqual(parseLoginStatus(j({loggedIn: true, authMethod: 'api_key', apiKeySource: 'apiKeyHelper'})), {loggedIn: false});
	assert.deepEqual(parseLoginStatus(j({loggedIn: true, authMethod: 'oauth_token'})), {loggedIn: false});
	assert.deepEqual(parseLoginStatus(j({loggedIn: true})), {loggedIn: false});
});

test('parseLoginStatus: garbage, oversize and non-boolean loggedIn give undefined', () => {
	for (const s of ['', 'nope', '[]', 'null', '5', j({loggedIn: 'true'}), j({authMethod: 'claude.ai'})]) {
		assert.equal(parseLoginStatus(s), undefined, s);
	}
	assert.equal(parseLoginStatus(j({loggedIn: false, pad: 'x'.repeat(70 * 1024)})), undefined);
});

test('parseLoginArgs: valid combinations', () => {
	assert.deepEqual(parseLoginArgs([]), {cliArgs: [], meta: {console: false, sso: false, email: false}});
	assert.deepEqual(parseLoginArgs(['--console']).cliArgs, ['--console']);
	assert.deepEqual(parseLoginArgs(['--claudeai', '--sso', '--email', 'a@b.co']), {
		cliArgs: ['--claudeai', '--sso', '--email', 'a@b.co'],
		meta: {console: false, sso: true, email: true},
	});
	assert.deepEqual(parseLoginArgs(['--email', 'a@b.co', '--console']), {
		cliArgs: ['--email', 'a@b.co', '--console'],
		meta: {console: true, sso: false, email: true},
	});
});

test('parseLoginArgs: rejects duplicates, exclusive and mixed flags', () => {
	for (const args of [
		['--sso', '--sso'],
		['--console', '--console'],
		['--console', '--claudeai'],
		['--email', 'a@b.co', '--email', 'c@d.co'],
		['--token'],
		['--sso', '--token'],
	]) {
		assert.throws(() => parseLoginArgs(args), /Usage|Use only|twice|Unknown option/, args.join(' '));
	}
});

test('parseLoginArgs: --email forms', () => {
	assert.throws(() => parseLoginArgs(['--email']), /needs an address/);
	assert.throws(() => parseLoginArgs(['--email', 'nope']), /Invalid email/);
	assert.throws(() => parseLoginArgs(['--email', '--sso']), /Invalid email/);
	assert.throws(() => parseLoginArgs(['--email', '-x@b.co']), /Invalid email/);
	assert.throws(() => parseLoginArgs(['--email=a@b.co']), /Unknown option/);
});

test('parseLoginArgs: unknown option is scrubbed, clipped and carries the usage', () => {
	assert.throws(() => parseLoginArgs(['--evil\u001b]0;x\u0007' + 'y'.repeat(100)]), (e: Error) => {
		assert.ok(!/[\u0000-\u001f\u007f]/.test(e.message.replace(LOGIN_USAGE, '')));
		assert.ok(e.message.endsWith(LOGIN_USAGE));
		assert.ok(e.message.length < 64 + 20 + LOGIN_USAGE.length + 5);
		return true;
	});
});

const fakeBin = async (body: string): Promise<{bin: string; dir: string}> => {
	const dir = await mkdtemp(join(tmpdir(), 'claude-login-'));
	const bin = join(dir, 'fake-claude');
	await writeFile(bin, `#!/bin/sh\n${body}\n`);
	await chmod(bin, 0o755);
	return {bin, dir};
};

const recordEnv = (dir: string) =>
	`env | cut -d= -f1 | sort > "${dir}/names"\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${dir}/cfg"`;

test('probeLogin passes a scrubbed env and parses JSON whatever the exit code', async () => {
	const {bin, dir} = await fakeBin(`${recordEnv('$(dirname "$0")')}\necho '{"loggedIn":false,"authMethod":"none"}'\nexit 1`);
	const paths = resolvePaths(dir, '/m');
	const env = cliEnv(
		{PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_AUTH_TOKEN: 'a'},
		paths,
	);
	assert.deepEqual(await probeLogin({bin, env}), {loggedIn: false});
	const names = (await readFile(join(dir, 'names'), 'utf8')).split('\n');
	assert.ok(names.includes('CLAUDE_CONFIG_DIR'));
	assert.ok(names.includes('DISABLE_AUTOUPDATER'));
	for (const n of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN']) assert.ok(!names.includes(n), n);
	assert.equal(await readFile(join(dir, 'cfg'), 'utf8'), paths.configDir);
	assert.equal(await readFile(join(dir, 'args'), 'utf8'), 'auth\nstatus\n--json\n');
});

test('probeLogin: logged-in JSON, non-JSON, missing binary', async () => {
	const ok = await fakeBin(`echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'`);
	assert.deepEqual(await probeLogin({bin: ok.bin, env: {}}), {loggedIn: true, method: 'claude.ai', subscriptionType: 'pro'});
	const bad = await fakeBin(`echo 'not json'`);
	assert.equal(await probeLogin({bin: bad.bin, env: {}}), undefined);
	assert.equal(await probeLogin({bin: join(bad.dir, 'missing'), env: {}}), undefined);
});

test('probeLogin: output over the 64 KiB cap is not parsed as a login', async () => {
	const {bin} = await fakeBin(`printf '{"loggedIn":true,"authMethod":"claude.ai","pad":"'; head -c 200000 /dev/zero | tr '\\0' a; printf '"}'`);
	assert.equal(await probeLogin({bin, env: {PATH: process.env.PATH}}), undefined);
});

test('probeLogin: a hanging binary is killed on timeout', async () => {
	const {bin} = await fakeBin('sleep 30');
	const t = Date.now();
	assert.equal(await probeLogin({bin, env: {PATH: process.env.PATH}, timeoutMs: 200}), undefined);
	assert.ok(Date.now() - t < 5000);
});

test('runLogout runs "auth logout" and reports the exit status', async () => {
	const okBin = await fakeBin(`${recordEnv('$(dirname "$0")')}\necho secret-output\nexit 0`);
	assert.equal(await runLogout({bin: okBin.bin, env: {PATH: process.env.PATH}}), true);
	assert.equal(await readFile(join(okBin.dir, 'args'), 'utf8'), 'auth\nlogout\n');
	const failBin = await fakeBin('exit 1');
	assert.equal(await runLogout({bin: failBin.bin, env: {}}), false);
	assert.equal(await runLogout({bin: join(failBin.dir, 'missing'), env: {}}), false);
	const hang = await fakeBin('sleep 30');
	assert.equal(await runLogout({bin: hang.bin, env: {PATH: process.env.PATH}, timeoutMs: 200}), false);
});
