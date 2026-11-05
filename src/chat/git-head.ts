import {lstat, open} from 'node:fs/promises';
import {dirname, isAbsolute, join, resolve} from 'node:path';

const MAX_BYTES = 4096;
const MAX_PARENTS = 16;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function parseHead(text: string): string | undefined {
	const line = text.split('\n', 1)[0]!.trim();
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(line);
	if (ref) return ref[1];
	if (HASH.test(line)) return line.slice(0, 7);
	return undefined;
}

async function readSmall(file: string): Promise<string | undefined> {
	const info = await lstat(file);
	if (!info.isFile() || info.size > MAX_BYTES) return undefined;
	const handle = await open(file, 'r');
	try {
		const buf = Buffer.alloc(MAX_BYTES);
		const {bytesRead} = await handle.read(buf, 0, MAX_BYTES, 0);
		return buf.subarray(0, bytesRead).toString('utf8');
	} finally {
		await handle.close();
	}
}

async function headFile(dir: string): Promise<string | undefined> {
	const dotGit = join(dir, '.git');
	let info;
	try {
		info = await lstat(dotGit);
	} catch {
		return undefined;
	}
	if (info.isDirectory()) return join(dotGit, 'HEAD');
	if (!info.isFile()) return undefined;
	const text = await readSmall(dotGit);
	const m = text === undefined ? null : /^gitdir:\s*(.+)$/m.exec(text);
	if (!m) return undefined;
	const target = m[1]!.trim();
	return join(isAbsolute(target) ? target : resolve(dir, target), 'HEAD');
}

// No git process: only the HEAD file is read, bounded in size and in the parents walked.
export async function readGitBranch(dir: string): Promise<string | undefined> {
	try {
		let current = resolve(dir);
		for (let i = 0; i <= MAX_PARENTS; i++) {
			const head = await headFile(current);
			if (head !== undefined) {
				const text = await readSmall(head);
				return text === undefined ? undefined : parseHead(text);
			}
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

