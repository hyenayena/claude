import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('the manifest declares only API keys: subscription logins and tokens are never stored (TASK-26)', () => {
	const manifest = JSON.parse(readFileSync(new URL('../yena.json', import.meta.url), 'utf8')) as {credentials?: Record<string, string>};
	assert.deepEqual(manifest.credentials, {'anthropic-key': 'write'});
});
