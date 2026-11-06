import assert from 'node:assert/strict';
import {readFileSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const srcDir = fileURLToPath(new URL('../../src/', import.meta.url));
const chatSrc = path.resolve(srcDir, '..', '..', 'chat', 'src') + path.sep;
const FROM = /(?:^|\n)\s*(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function resolveLocal(from: string, spec: string): string | undefined {
	if (!spec.startsWith('.')) return undefined;
	const base = path.resolve(path.dirname(from), spec.replace(/\.js$/, ''));
	for (const ext of ['.ts', '.tsx']) {
		try {
			if (statSync(base + ext).isFile()) return base + ext;
		} catch {}
	}
	return undefined;
}

test('the background runner never reaches the chat UI or the theme tables', () => {
	const seen = new Set<string>();
	const queue = [path.join(srcDir, 'runner', 'main.ts')];
	const bad: string[] = [];
	while (queue.length > 0) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, 'utf8');
		if (/\b(toneSgr|sgrTable|paintTone)\b/.test(source)) bad.push(`${path.relative(srcDir, file)} uses the theme tables`);
		for (const m of source.matchAll(FROM)) {
			const spec = (m[1] ?? m[2] ?? m[3]) as string;
			const next = resolveLocal(file, spec);
			if (!next) continue;
			if (next === path.join(srcDir, 'deps', 'chat-ui.ts') || next.startsWith(chatSrc + 'ui' + path.sep) || next === chatSrc + 'public-ui.ts') bad.push(`${path.relative(srcDir, file)} -> ${spec}`);
			if (!next.startsWith(srcDir)) continue;
			if (next.startsWith(path.join(srcDir, 'ui') + path.sep)) bad.push(`${path.relative(srcDir, file)} -> ${spec}`);
			queue.push(next);
		}
	}
	assert.ok(seen.size > 5, 'the walk found the module graph');
	assert.deepEqual(bad, []);
});
