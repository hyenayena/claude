import {readdir} from 'node:fs/promises';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.yena', '.runtime', '.idea', '.next', '.cache']);
const MAX_FILES = 5000;
const MAX_DEPTH = 8;
const SECRET = [/^\.env/, /\.pem$/, /^id_rsa/];

export async function listProjectFiles(root: string, max = MAX_FILES): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (out.length >= max || depth > MAX_DEPTH) return;
		let entries;
		try {
			entries = await readdir(dir, {withFileTypes: true});
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const e of entries) {
			if (out.length >= max) return;
			if (SECRET.some(re => re.test(e.name))) continue;
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				if (!SKIP.has(e.name)) await walk(full, depth + 1);
			} else if (e.isFile()) {
				out.push(path.relative(root, full));
			}
		}
	};
	await walk(root, 0);
	return out;
}

export function matchFiles(files: readonly string[], query: string, limit = 6): string[] {
	const q = query.toLowerCase();
	if (q === '') return files.slice(0, limit);
	const scored: Array<[number, string]> = [];
	for (const f of files) {
		const lower = f.toLowerCase();
		const base = path.basename(lower);
		const score = base.startsWith(q) ? 0 : lower.startsWith(q) ? 1 : base.includes(q) ? 2 : lower.includes(q) ? 3 : -1;
		if (score >= 0) scored.push([score, f]);
	}
	scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || a[1].localeCompare(b[1]));
	return scored.slice(0, limit).map(([, f]) => f);
}

export function mentionAt(text: string, cursor: number): {start: number; query: string} | undefined {
	let i = cursor;
	while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
	if (text[i] !== '@') return undefined;
	return {start: i, query: text.slice(i + 1, cursor)};
}
