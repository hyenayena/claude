import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {buildAutoMode} from '../../src/chat/auto-mode.js';

const full = {hub: '/data/md', configDir: '/data/claude/config', scratch: '/tmp/s/scratch/aaaaaaaa', workplace: '/workplace', stage: '/stage', accountDir: '/data/account'};

describe('buildAutoMode', () => {
	it('keeps the defaults first in both lists', () => {
		const a = buildAutoMode(full);
		assert.equal(a.environment[0], '$defaults');
		assert.equal(a.allow[0], '$defaults');
		assert.equal(a.environment.length, 7);
		assert.equal(a.allow.length, 2);
	});

	it('names the trusted locations, the secrets and the rules', () => {
		const text = buildAutoMode(full).environment.join('\n');
		assert.match(text, /projects under \/workplace\/<name> once the user isolated them/);
		assert.match(text, /stage copies under \/stage/);
		assert.match(text, /the md hub \/data\/md/);
		assert.match(text, /scratch folder \/tmp\/s\/scratch\/aaaaaaaa/);
		assert.match(text, /\/data\/account \(encrypted, owned by yena's account module\) and Claude Code's config \/data\/claude\/config/);
		assert.match(text, /\.yenarules files and the project rules kept by yena/);
		assert.match(text, /github\.com\/hyenayena/);
	});

	it('lists no isolated project: the text is static', () => {
		const text = JSON.stringify(buildAutoMode(full));
		assert.ok(!/isolated: |"web"|"api"/.test(text));
		assert.deepEqual(buildAutoMode(full), buildAutoMode({...full}));
	});

	it('the local operations entry covers the project scope and excludes rules, rules files and discarding work', () => {
		const allow = buildAutoMode(full).allow[1] as string;
		assert.match(allow, /^Local Operations in yena: the isolated projects under \/workplace, their stages under \/stage, the md hub \/data\/md and the scratch folder/);
		assert.match(allow, /This does not cover paths under any deny or ask rule, the rules files themselves, discarding uncommitted work/);
	});

	it('omits a path part when its path is absent', () => {
		const a = buildAutoMode({hub: '/data/md', configDir: '/c'});
		const text = JSON.stringify(a);
		for (const word of ['scratch', 'stage copies', '/workplace', 'account module']) assert.ok(!text.includes(word), word);
		assert.match(a.environment[3] as string, /^Trusted local working locations: the md hub \/data\/md \(/);
		assert.match(a.environment[5] as string, /^Secrets management: credentials live in Claude Code's config \/c \(/);
	});
});
