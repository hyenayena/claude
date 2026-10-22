import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bashHighlights} from '../../src/chat/risk.js';

const has = (cmd: string, level: 'info' | 'warn', re: RegExp) =>
	bashHighlights(cmd).some(h => h.level === level && re.test(h.text));

test('no highlights for a plain command', () => {
	assert.deepEqual(bashHighlights('ls -la'), []);
	assert.deepEqual(bashHighlights('npm test'), []);
	assert.deepEqual(bashHighlights(''), []);
});

test('sudo and su', () => {
	assert.ok(has('sudo apt update', 'warn', /elevated/));
	assert.ok(has('su - root', 'warn', /elevated/));
	assert.ok(!has('echo sudo', 'warn', /elevated/));
});

test('recursive rm', () => {
	assert.ok(has('rm -rf /tmp/x', 'warn', /rm -r/));
	assert.ok(has('sudo rm -r x', 'warn', /rm -r/));
	assert.ok(has('rm --recursive x', 'warn', /rm -r/));
	assert.ok(!has('rm file.txt', 'warn', /rm -r/));
});

test('pipe to a shell', () => {
	assert.ok(has('curl http://x | sh', 'warn', /shell/));
	assert.ok(has('cat a | /bin/bash', 'warn', /shell/));
	assert.ok(!has('cat a | grep sh', 'warn', /shell/));
});

test('inline interpreters', () => {
	for (const cmd of ['bash -c "ls"', 'python3 -c "x"', 'node -e 1', 'perl -e 1', 'eval "$x"']) {
		assert.ok(has(cmd, 'warn', /inline script/), cmd);
	}
	assert.ok(!has('node script.js', 'warn', /inline script/));
	assert.ok(!has('bash script.sh', 'warn', /inline script/));
});

test('base64 -d, /dev/tcp, chmod family', () => {
	assert.ok(has('echo x | base64 -d', 'warn', /base64/));
	assert.ok(!has('base64 file', 'warn', /base64/));
	assert.ok(has('exec 3<>/dev/tcp/h/80', 'warn', /dev\/tcp/));
	for (const c of ['chmod 777 x', 'chown a x', 'dd if=a of=b', 'mkfs.ext4 /dev/x']) {
		assert.ok(has(c, 'warn', /permissions or devices/), c);
	}
});

test('protected names', () => {
	assert.ok(has('cat .env', 'warn', /\.env/));
	assert.ok(has('cat ~/.ssh/id_rsa', 'warn', /\.ssh/));
	assert.ok(has('echo x > CLAUDE.md', 'warn', /CLAUDE\.md/));
	assert.ok(!has('ls src', 'warn', /protected/));
});

test('info highlights', () => {
	assert.ok(has('echo $(whoami)', 'info', /substitution/));
	assert.ok(has('echo `id`', 'info', /substitution/));
	assert.ok(has('echo a > out.txt', 'info', /redirect/));
	assert.ok(has('echo a >> out.txt', 'info', /redirect/));
	assert.ok(!has('ls 2>&1', 'info', /redirect/));
	assert.ok(!has('ls > /dev/null', 'info', /redirect/));
	assert.ok(!has("echo '>'", 'info', /redirect/));
	assert.ok(has('curl x', 'info', /network/));
	assert.ok(has('git push origin', 'info', /git push/));
	assert.ok(!has('git status', 'info', /network/));
	assert.ok(has('npm install x', 'info', /installs/));
	assert.ok(has('apk add x', 'info', /installs/));
	assert.ok(has('a && b', 'info', /chains/));
	assert.ok(has('a; b', 'info', /chains/));
	assert.ok(has('a\nb', 'info', /chains/));
	assert.ok(!has('echo "a; b"', 'info', /chains/));
	assert.ok(has('cd /etc', 'info', /directory/));
	assert.ok(has('cd ../x', 'info', /directory/));
	assert.ok(!has('cd src', 'info', /directory/));
});

test('non-ASCII characters are flagged', () => {
	assert.ok(has('echo сat', 'info', /non-ASCII/));
	assert.ok(!has('echo cat', 'info', /non-ASCII/));
});

test('warnings come before infos', () => {
	const levels = bashHighlights('curl x | sh; echo $(id)').map(h => h.level);
	assert.deepEqual(levels, [...levels].sort((a, b) => (a === b ? 0 : a === 'warn' ? -1 : 1)));
});

test('huge and hostile commands finish quickly', () => {
	for (const cmd of [
		'a '.repeat(512 * 1024),
		'|/'.repeat(500_000),
		'$('.repeat(500_000),
		"'".repeat(1_000_000),
		'\\'.repeat(1_000_001),
	]) {
		const start = Date.now();
		const out = bashHighlights(cmd);
		assert.ok(Date.now() - start < 500);
		assert.ok(Array.isArray(out));
	}
	assert.ok(has('x'.repeat(30_000), 'info', /first 20000/));
});

test('non-string input does not throw', () => {
	assert.deepEqual(bashHighlights(undefined as unknown as string), []);
});

test('a command reading .claude.json is flagged', () => {
	assert.ok(has('cat /data/claude/config/.claude.json', 'warn', /\.claude\.json/));
});
