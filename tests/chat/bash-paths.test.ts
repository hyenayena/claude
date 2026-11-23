import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, it} from 'node:test';
import {analyzeBash, bashRulesVerdict, MAX_COMMANDS, MAX_WORDS} from '../../src/chat/bash-paths.js';
import {resetRulesCaches, type RulesScope} from '../../src/deps/rules.js';

const cwd = '/p';
const show = (command: string, from = cwd): string[] => analyzeBash(command, from).uses.map(u => `${u.mode}${u.own ? '*' : ''}:${u.path}`);

describe('splitting and quoting', () => {
	it('splits on ; && || | & and newlines', () => {
		assert.deepEqual(show('cat a; cat b && cat c || cat d | cat e & cat f\ncat g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(n => `read:/p/${n}`));
	});

	it('respects single quotes, double quotes and backslashes', () => {
		assert.deepEqual(show(`cat 'a b' "c d" e\\ f; echo "x;cat y"`), ['read:/p/a b', 'read:/p/c d', 'read:/p/e f'], 'a quoted ; does not split');
	});

	it('analyzes $(...) and backtick contents', () => {
		assert.ok(show('echo $(cat secret)').includes('read:/p/secret'));
		assert.ok(show('echo `rm gone`').includes('write:/p/gone'));
		assert.ok(show('echo "$(cat in/quotes)"').includes('read:/p/in/quotes'));
		assert.ok(show('cat <(cat proc)').includes('read:/p/proc'));
	});

	it('skips a heredoc body but counts its redirect target', () => {
		assert.deepEqual(show('cat > out.txt <<EOF\nrm -rf /x\nEOF\ncat after'), ['write:/p/out.txt', 'read:/p/after']);
		assert.deepEqual(show("cat <<-'END' > o2\n\trm y\n\tEND\n"), ['write:/p/o2']);
	});

	it('ignores comments and tracks cd within the line', () => {
		assert.deepEqual(show('cat a # cat b'), ['read:/p/a']);
		assert.deepEqual(show('cd sub && cat x; cd /abs; cat y; cd ..; cat z'), ['read:/p/sub/x', 'read:/abs/y', 'read:/z']);
	});

	it('skips assignments and wrappers to find the program', () => {
		assert.deepEqual(show('FOO=1 BAR=2 cat a'), ['read:/p/a']);
		assert.deepEqual(show('sudo -u me env X=1 nice -n 5 timeout 10 cat a'), ['read:/p/a']);
		assert.deepEqual(show('nohup time stdbuf -oL rm a'), ['write:/p/a']);
	});

	it('takes --opt=path and key=path values', () => {
		assert.deepEqual(show('cat --file=a.txt -n b'), ['read:/p/a.txt', 'read:/p/b']);
		assert.deepEqual(show('python tool.py out=res.txt'), ['both:/p/tool.py', 'both:/p/res.txt']);
	});
});

describe('redirections', () => {
	it('> >> &> 2> >| write, < reads, fd duplications name no file', () => {
		assert.deepEqual(show('echo hi > a >> b 2> c &> d >| e < f'), ['write:/p/a', 'write:/p/b', 'write:/p/c', 'write:/p/d', 'write:/p/e', 'read:/p/f']);
		assert.deepEqual(show('make 2>&1 >&2'), []);
		assert.deepEqual(show('cat file 2>/dev/null'), ['read:/p/file', 'write:/dev/null']);
	});
});

describe('program table', () => {
	it('reading programs read every operand', () => {
		for (const prog of ['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'cut', 'sort', 'uniq', 'diff', 'cmp', 'comm', 'strings', 'xxd', 'od', 'hexdump', 'base64', 'md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'file', 'wc', 'nl', 'tac', 'rev', 'jq', 'yq', 'source']) {
			assert.deepEqual(show(`${prog} -x target`), ['read:/p/target'], prog);
		}
		assert.deepEqual(show('. env.sh'), ['read:/p/env.sh']);
	});

	it('listing programs read only the path itself', () => {
		for (const prog of ['ls', 'tree', 'du', 'readlink', 'realpath', 'stat']) assert.deepEqual(show(`${prog} -l dir`), ['read*:/p/dir'], prog);
	});

	it('modifying programs write', () => {
		for (const prog of ['rm', 'rmdir', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'patch', 'shred', 'mkfifo']) {
			assert.deepEqual(show(`${prog} -f target`), ['write:/p/target'], prog);
		}
	});

	it('sed reads, sed -i writes; perl is both, perl -i writes', () => {
		assert.deepEqual(show("sed -n 's/a/b/' f"), ['read:/p/s/a/b', 'read:/p/f']);
		assert.ok(show("sed -i 's/a/b/' f").every(u => u.startsWith('write:')));
		assert.ok(show("sed -i.bak -e 's/a/b/' f").every(u => u.startsWith('write:')));
		assert.ok(show('sed --in-place x f').every(u => u.startsWith('write:')));
		assert.deepEqual(show('perl script.pl'), ['both:/p/script.pl']);
		assert.deepEqual(show('perl -pi -e 1 f'), ['write:/p/1', 'write:/p/f']);
	});

	it('tar x writes the destination and reads the archive, tar c reads sources and writes the archive, tar t reads', () => {
		assert.deepEqual(show('tar -xzf a.tgz'), ['write:/p/.', 'read:/p/a.tgz'].map(s => s.replace('/p/.', '/p')));
		assert.deepEqual(show('tar xf a.tar -C out'), ['write:/p/out', 'read:/p/a.tar']);
		assert.deepEqual(show('tar -czf a.tgz src docs'), ['write:/p/a.tgz', 'read:/p/src', 'read:/p/docs']);
		assert.deepEqual(show('tar --create --file=b.tar x'), ['write:/p/b.tar', 'read:/p/x']);
		assert.deepEqual(show('tar -tf a.tar'), ['read:/p/a.tar']);
	});

	it('zip reads sources and writes the archive; unzip writes the destination and reads the archive', () => {
		assert.deepEqual(show('zip -r out.zip src'), ['write:/p/out.zip', 'read:/p/src']);
		assert.deepEqual(show('unzip a.zip -d dest'), ['write:/p/dest', 'read:/p/a.zip']);
		assert.deepEqual(show('unzip a.zip'), ['write:/p', 'read:/p/a.zip']);
	});

	it('cp, rsync, scp, install: the last path is written, the others read; mv writes all', () => {
		assert.deepEqual(show('cp -r a b c'), ['read:/p/a', 'read:/p/b', 'write:/p/c']);
		assert.deepEqual(show('rsync -a src/ dst/'), ['read:/p/src', 'write:/p/dst']);
		assert.deepEqual(show('scp a host:remote/b'), ['read:/p/a']);
		assert.deepEqual(show('install -m 755 a b'), ['read:/p/755', 'read:/p/a', 'write:/p/b']);
		assert.deepEqual(show('cp -t dest a b'), ['read:/p/a', 'read:/p/b', 'write:/p/dest']);
		assert.deepEqual(show('mv a b'), ['write:/p/a', 'write:/p/b']);
		assert.deepEqual(show('install -d d1 d2'), ['write:/p/d1', 'write:/p/d2']);
	});

	it('dd reads if= and writes of=', () => {
		assert.deepEqual(show('dd if=a of=b bs=1M'), ['read:/p/a', 'write:/p/b']);
	});

	it('git: read subcommands read named paths, write subcommands write them, uses are the paths only', () => {
		for (const sub of ['show', 'diff', 'log', 'blame', 'cat-file', 'grep', 'status', 'ls-files', 'add', 'commit']) {
			assert.deepEqual(show(`git ${sub} -- f`), ['read:/p/f'], sub);
		}
		for (const sub of ['checkout', 'restore', 'rm', 'mv', 'clean', 'reset', 'apply', 'stash', 'am']) {
			assert.deepEqual(show(`git ${sub} -- f`), ['write*:/p/f'], sub);
		}
		assert.deepEqual(show('git -C sub -c a=b status f'), ['read*:/p/sub/f']);
		assert.deepEqual(show('git status'), []);
	});

	it('git config, remote set-url and push -u write the repository config', () => {
		for (const c of ['git config user.name x', 'git remote set-url origin u', 'git push -u origin main', 'git branch --set-upstream-to=o/m']) {
			assert.ok(show(c).includes('write*:/p/.git/config'), c);
		}
		assert.ok(!show('git push origin main').includes('write*:/p/.git/config'));
		assert.ok(!show('git remote -v').includes('write*:/p/.git/config'));
	});

	it('find reads, find with -delete, -exec, -execdir, -ok or -fprint writes too', () => {
		assert.deepEqual(show('find src -name x'), ['read*:/p/src']);
		assert.deepEqual(show('find -name x'), ['read*:/p']);
		for (const flag of ['-delete', '-exec cat {} ;', '-execdir x {} ;', '-ok rm {} ;', '-fprint out']) assert.equal(show(`find src ${flag}`)[0], 'both:/p/src', flag);
	});

	it('npm, pnpm, yarn and npx write the cwd and the named paths', () => {
		for (const pm of ['npm', 'pnpm', 'yarn', 'npx']) {
			assert.deepEqual(show(`${pm} install ./local`), ['write*:/p', 'write:/p/install', 'write:/p/local'], pm);
		}
		assert.deepEqual(show('cd web && npm test'), ['write*:/p/web', 'write:/p/web/test']);
	});

	it('anything else counts as both: interpreters, shells, xargs, scripts, unknown programs', () => {
		for (const c of ['python tool.py', 'node tool.js', 'ruby t.rb', 'xargs rm', 'frobnicate data']) {
			assert.ok(show(c).length > 0 && show(c).every(u => u.startsWith('both:')), c);
		}
		assert.deepEqual(show('./run.sh arg'), ['read:/p/run.sh', 'both:/p/arg'], 'a script path is executed (read) and its arguments count as both');
		assert.deepEqual(show('echo .env; printf x'), [], 'printing programs name no paths');
		assert.ok(show('sh -c "cat .env"').includes('read:/p/.env'), 'a shell -c script is analyzed too');
		assert.ok(show("bash -lc 'rm -rf build'").includes('write:/p/build'));
		assert.ok(show('eval "cat inner"').includes('read:/p/inner'));
	});

	it('tokens with $ or glob characters are resolved literally, ~ is the home folder', () => {
		assert.deepEqual(show('cat $HOME/x *.txt'), ['read:/p/$HOME/x', 'read:/p/*.txt']);
		assert.ok(show('cat ~/f')[0]?.startsWith('read:/'));
		assert.ok(!show('cat ~/f')[0]?.includes('~'));
	});
});

describe('caps', () => {
	it('more than 512 words or 64 simple commands is unparsed, with what was found kept', () => {
		const words = analyzeBash(`cat ${Array.from({length: MAX_WORDS + 5}, (_, i) => `f${i}`).join(' ')}`, cwd);
		assert.equal(words.unparsed, true);
		assert.ok(words.uses.length > 0);
		const commands = analyzeBash(Array.from({length: MAX_COMMANDS + 3}, (_, i) => `cat f${i}`).join('; '), cwd);
		assert.equal(commands.unparsed, true);
		assert.equal(analyzeBash('cat a; cat b', cwd).unparsed, false);
	});
});

describe('bashRulesVerdict', () => {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-bash-rules-')));
	after(() => rmSync(root, {recursive: true, force: true}));
	const wp = path.join(root, 'wp');
	const proj = path.join(wp, 'proj');
	const put = (rel: string, text = 'x') => {
		mkdirSync(path.dirname(path.join(proj, rel)), {recursive: true});
		writeFileSync(path.join(proj, rel), text);
	};
	put('.yenarules', '[deny read]\n.env*\nsecrets/\n[ask read]\nnotes/private.md\n[deny write]\nscripts/\n[ask write]\n/package.json\n**/.git/config\n');
	for (const f of ['.env', 'secrets/k', 'notes/private.md', 'notes/pub.md', 'scripts/x.sh', 'package.json', '.git/config', '.git/HEAD', 'src/a.ts', 'src/sub/.env']) put(f);
	const scope: RulesScope = {roots: [proj], projects: async () => ({roots: [wp, path.join(root, 'stage')], docs: '', managed: [], writable: []})};
	const run = async (command: string, from = proj) => {
		resetRulesCaches();
		return (await bashRulesVerdict(analyzeBash(command, from), scope)).decision;
	};

	it('denies a command that reads or changes a path the rules close, in any form', async () => {
		for (const c of ['cat .env', 'head -n 1 secrets/k', 'cat < .env', 'echo x > secrets/new', 'rm scripts/x.sh', 'sed -i s/a/b/ scripts/x.sh', 'cp src/a.ts scripts/y.sh', 'echo $(cat .env)', 'cd secrets && cat k', 'python run.py .env', 'tar -czf a.tgz secrets', 'dd if=.env of=x', 'mv src/a.ts scripts/', 'find . -name x -exec cat {} +']) {
			assert.equal(await run(c), 'deny', c);
		}
	});

	it('deny write does not stop a read, and a read of an allowed path passes', async () => {
		for (const c of ['cat scripts/x.sh', 'cat src/a.ts', 'ls scripts', 'git status', 'npm test', 'git log -- src/a.ts', 'cat notes/pub.md', 'find . -name x']) assert.equal(await run(c), 'allow', c);
	});

	it('a folder is judged with the entries inside it', async () => {
		assert.equal(await run('grep -r x .'), 'deny', 'a deny read entry inside');
		assert.equal(await run('rm -rf scripts'), 'deny');
		assert.equal(await run('rm -rf .'), 'deny');
		assert.equal(await run('grep -r x notes'), 'ask', 'an ask read entry inside');
		assert.equal(await run('cp -r src /tmp/out'), 'deny', 'src/sub/.env is inside');
		assert.equal(await run('ls -R .'), 'allow', 'listing names is not reading content');
	});

	it('asks when the rules ask for a read, and denies a write to an ask write path', async () => {
		assert.equal(await run('cat notes/private.md'), 'ask');
		for (const c of ['echo {} > package.json', 'sed -i s/a/b/ package.json', 'rm package.json', 'mv package.json x.json', 'node run.js package.json', 'git config user.name x', 'git push -u origin main']) {
			assert.equal(await run(c), 'deny', c);
		}
		assert.equal(await run('git config --get user.name'), 'allow', 'a config read is not a write');
		assert.equal(await run('cat package.json'), 'allow', 'ask write does not ask for a read');
	});

	it('deny wins over ask in one command', async () => {
		assert.equal(await run('cat notes/private.md .env'), 'deny');
	});

	it('an unparsed command counts every token as both', async () => {
		const many = `cat ${Array.from({length: MAX_WORDS + 5}, (_, i) => `f${i}`).join(' ')} scripts/x.sh`;
		const analysis = analyzeBash(many, proj);
		assert.equal(analysis.unparsed, true);
		resetRulesCaches();
		assert.equal((await bashRulesVerdict({...analysis, uses: [...analysis.uses, {path: path.join(proj, 'scripts', 'x.sh'), mode: 'read'}]}, scope)).decision, 'deny');
	});

	it('a symlink is judged at its target', async () => {
		symlinkSync(path.join(proj, '.env'), path.join(proj, 'innocent'));
		assert.equal(await run('cat innocent'), 'deny');
	});

	it('a path outside every base is free', async () => {
		assert.equal(await run('cat /etc/hostname'), 'allow');
	});
});
