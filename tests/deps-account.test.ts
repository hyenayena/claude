import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {loadAccountSecretPaths} from '../src/deps/account.js';
import {accountShellDenied, buildChatSettings, buildScope} from '../src/policy.js';

const installed = existsSync(fileURLToPath(new URL('../../account/yena.json', import.meta.url)));

test('the account module tells where its secrets are', {skip: !installed && 'account module not installed'}, async () => {
	const got = await loadAccountSecretPaths('/data/claude');
	assert.deepEqual(got, {dataDir: '/data/account', secretDirs: ['/data/account/secrets', '/data/account/keys']});
});

const secrets = {dataDir: '/d/account', secretDirs: ['/d/account/secrets', '/d/account/keys']};
const paths = {
	projectDir: '/app',
	mdDir: '/d/claude/md',
	configDir: '/d/claude/config',
	stateFile: '/d/claude/state.json',
	credentialsFile: '/d/claude/credentials.json',
	accountSecrets: secrets,
};

test('accountShellDenied names the data dir and the secret dir tails', () => {
	assert.deepEqual(accountShellDenied(secrets), ['/d/account', 'account/secrets', 'account/keys']);
	assert.deepEqual(accountShellDenied(undefined), []);
});

test('the account secret dirs are denied in the scope and the chat settings', () => {
	const scope = buildScope(paths, '/home');
	assert.ok(scope.denied.includes('/d/account/secrets') && scope.denied.includes('/d/account/keys'));
	assert.deepEqual(scope.shellDenied, ['/d/account', 'account/secrets', 'account/keys']);
	const deny = buildChatSettings(paths).permissions.deny;
	for (const r of ['Read(//d/account/secrets/**)', 'Read(//d/account/keys/**)', 'Edit(//d/account/secrets/**)', 'Edit(//d/account/keys/**)']) {
		assert.ok(deny.includes(r), r);
	}
	const {accountSecrets: _, ...without} = paths;
	assert.equal(buildScope(without, '/home').shellDenied, undefined);
});
