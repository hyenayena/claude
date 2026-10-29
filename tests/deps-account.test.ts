import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {loadAccountSecretPaths} from '../src/deps/account.js';
import {accountShellDenied, buildChatSettings, buildScope} from '../src/policy.js';

const installed = existsSync(fileURLToPath(new URL('../../account/yena.json', import.meta.url)));

test('the account module tells which of its paths are denied: all but ssh_config', {skip: !installed && 'account module not installed'}, async () => {
	const got = await loadAccountSecretPaths('/data/claude');
	assert.equal(got?.dataDir, '/data/account');
	for (const p of ['/data/account/secrets', '/data/account/keys']) assert.ok(got!.secretDirs.includes(p), p);
	assert.ok(!got!.secretDirs.some(p => p.endsWith('ssh_config') || p === '/data/account'));
});

const secrets = {dataDir: '/d/account', secretDirs: ['/d/account/secrets', '/d/account/keys', '/d/account/vault', '/d/account/grants.json']};
const paths = {
	projectDir: '/app',
	mdDir: '/d/claude/md',
	configDir: '/d/claude/config',
	stateFile: '/d/claude/state.json',
	credentialsFile: '/d/claude/credentials.json',
	accountSecrets: secrets,
};

test('accountShellDenied names the data dir and the tails of the denied paths', () => {
	assert.deepEqual(accountShellDenied(secrets), ['/d/account', 'account/secrets', 'account/keys', 'account/vault', 'account/grants.json']);
	assert.deepEqual(accountShellDenied(undefined), []);
});

test('the denied account paths are in the scope and the chat settings, as files and as folders', () => {
	const scope = buildScope(paths, '/home');
	for (const p of secrets.secretDirs) assert.ok(scope.denied.includes(p), p);
	const deny = buildChatSettings(paths).permissions.deny;
	for (const p of secrets.secretDirs) {
		for (const r of [`Read(/${p})`, `Read(/${p}/**)`, `Edit(/${p})`, `Edit(/${p}/**)`]) assert.ok(deny.includes(r), r);
	}
	const {accountSecrets: _, ...without} = paths;
	assert.equal(buildScope(without, '/home').shellDenied, undefined);
});
