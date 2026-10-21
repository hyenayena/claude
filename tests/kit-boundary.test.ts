import assert from 'node:assert/strict';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const ADAPTERS = new Set([path.join(srcDir, 'kit.ts'), path.join(srcDir, 'ui', 'kit.ts')]);

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
	});
}

// Static `import`/`export ... from` specifiers only; dynamic import() calls are excluded.
function staticSpecifiers(source: string): string[] {
	const out: string[] = [];
	const pattern = /(?:^|\n)\s*(?:import|export)\b(?!\s+type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
	for (const m of source.matchAll(pattern)) out.push((m[1] ?? m[2]) as string);
	return out;
}

test('only the two adapter files import from core', () => {
	const offenders: string[] = [];
	for (const file of walk(srcDir)) {
		const text = readFileSync(file, 'utf8');
		const specs = [...staticSpecifiers(text), ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1] as string)];
		const touches = specs.some(s => /(^|\/)core\//.test(s));
		if (touches && !ADAPTERS.has(file)) offenders.push(path.relative(srcDir, file));
		if (!touches && ADAPTERS.has(file)) offenders.push(`${path.relative(srcDir, file)} (adapter without core import)`);
	}
	assert.deepEqual(offenders, []);
});

function resolveLocal(from: string, spec: string): string | undefined {
	if (!spec.startsWith('.')) return undefined;
	const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
	for (const ext of ['.ts', '.tsx']) {
		try {
			if (statSync(base + ext).isFile()) return base + ext;
		} catch {
			// try the next extension
		}
	}
	return undefined;
}

test('the static import graph of index.ts never reaches react, ink or the core UI kit', () => {
	const seen = new Set<string>();
	const queue = [path.join(srcDir, 'index.ts')];
	const bad: string[] = [];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
			if (/^(react|ink)(\/|$)/.test(spec) || /kit\/ui(\.js)?$/.test(spec)) {
				bad.push(`${path.relative(srcDir, file)} -> ${spec}`);
				continue;
			}
			if (file === path.join(srcDir, 'ui', 'kit.ts')) continue;
			const next = resolveLocal(file, spec);
			if (next) queue.push(next);
		}
	}
	assert.ok(seen.size > 5, 'the walk found the module graph');
	assert.deepEqual(bad, []);
});
