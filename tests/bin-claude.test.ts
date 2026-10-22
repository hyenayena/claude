import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {resolvePaths} from '../src/config.js';

const script = readFileSync(path.join(resolvePaths('/data/claude').moduleDir, 'bin', 'claude'), 'utf8');

describe('bin/claude auth handling', () => {
	it('has no legacy token handling', () => {
		assert.ok(!script.includes('.token'));
		assert.ok(!script.includes('TOKEN_FILE'));
		assert.ok(!/CLAUDE_CODE_OAUTH_TOKEN=/.test(script));
		assert.ok(!/export\s+CLAUDE_CODE_OAUTH_TOKEN/.test(script));
	});
});
