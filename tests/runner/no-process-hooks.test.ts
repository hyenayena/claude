import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));

const specifiers = (source: string): string[] =>
	[...source.matchAll(/(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(m => m[1]!);

const resolve = (from: string, spec: string): string | undefined => {
	if (!spec.startsWith('.')) return undefined;
	const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
	for (const ext of ['.ts', '.tsx']) {
		try {
			if (statSync(base + ext).isFile()) return base + ext;
		} catch {
		}
	}
	return undefined;
};

test('nothing in the runner import graph registers process-level listeners', () => {
	const seen = new Set<string>();
	const queue = [path.join(srcDir, 'runner', 'main.ts')];
	const offenders: string[] = [];
	const hook = /process\s*\.\s*(?:on|once|addListener|prependListener)\s*\(\s*['"`](SIG\w+|uncaughtException|unhandledRejection|uncaughtExceptionMonitor|exit|beforeExit|disconnect)['"`]/;
	while (queue.length > 0) {
		const file = queue.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const text = readFileSync(file, 'utf8');
		if (hook.test(text)) offenders.push(path.relative(srcDir, file));
		for (const spec of specifiers(text)) {
			const next = resolve(file, spec);
			if (next) queue.push(next);
		}
	}
	assert.ok(seen.size > 10, 'the walk found the runner graph');
	assert.deepEqual(offenders, []);
});

test('the runner entry exits through process.exit after done and sets no listeners', () => {
	const text = readFileSync(path.join(srcDir, 'runner', 'main.ts'), 'utf8');
	assert.match(text, /process\.exit\(\)/);
	assert.doesNotMatch(text, /process\.(on|once)\(/);
});
