import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import {isPathAllowed, type Scope} from '../policy.js';
import {diffLines, locateEdit, previewNewFile} from './diff.js';
import {PAYLOAD_REVIEW_MAX, type Preview, type PreviewRow} from './permission.js';

export const FILE_READ_MAX = 256 * 1024;

type FileState =
	| {kind: 'text'; text: string; size: number}
	| {kind: 'missing'}
	| {kind: 'unreadable'; size?: number};

async function readFileState(
	filePath: string,
	scope: Scope,
	signal?: AbortSignal,
): Promise<FileState> {
	try {
		if (!(await isPathAllowed(filePath, scope)) || signal?.aborted) {
			return {kind: 'unreadable'};
		}
		const abs = path.resolve(scope.roots[0] as string, filePath);
		let handle;
		try {
			handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === 'ENOENT'
				? {kind: 'missing'}
				: {kind: 'unreadable'};
		}
		try {
			const st = await handle.stat();
			if (!st.isFile()) {
				return {kind: 'unreadable'};
			}
			if (st.size > FILE_READ_MAX) {
				return {kind: 'unreadable', size: st.size};
			}
			const buf = Buffer.alloc(st.size);
			let got = 0;
			while (got < buf.length) {
				if (signal?.aborted) {
					return {kind: 'unreadable', size: st.size};
				}
				const {bytesRead} = await handle.read(buf, got, buf.length - got, got);
				if (bytesRead === 0) {
					break;
				}
				got += bytesRead;
			}
			const data = buf.subarray(0, got);
			if (data.includes(0)) {
				return {kind: 'unreadable', size: st.size};
			}
			return {kind: 'text', text: data.toString('utf8'), size: st.size};
		} finally {
			await handle.close().catch(() => undefined);
		}
	} catch {
		return {kind: 'unreadable'};
	}
}

const meta = (text: string): PreviewRow => ({kind: 'meta', text});

function withNotes(preview: Preview, notes: string[]): Preview {
	return notes.length === 0 ? preview : {...preview, rows: [...notes.map(meta), ...preview.rows]};
}

function replaceFirst(text: string, old: string, next: string): string {
	const at = text.indexOf(old);
	return at < 0 ? text : text.slice(0, at) + next + text.slice(at + old.length);
}

async function editPreview(
	input: Record<string, unknown>,
	scope: Scope,
	signal?: AbortSignal,
): Promise<Preview | undefined> {
	const {file_path: filePath, old_string: old, new_string: next, replace_all: all} = input;
	if (typeof filePath !== 'string' || typeof old !== 'string' || typeof next !== 'string') {
		return undefined;
	}
	const replaceAll = all === true;
	if (old.length > PAYLOAD_REVIEW_MAX || next.length > PAYLOAD_REVIEW_MAX) {
		const preview = diffLines(old, next, {maxChars: PAYLOAD_REVIEW_MAX});
		return withNotes({...preview, approximate: true}, ['edit too large to place in the file']);
	}
	const file = await readFileState(filePath, scope, signal);
	if (file.kind !== 'text') {
		const note =
			file.kind === 'missing'
				? 'file does not exist; showing only the proposed edit'
				: 'file not readable for preview; showing only the proposed edit';
		return withNotes({...diffLines(old, next), approximate: true}, [note]);
	}
	const {lines, warnings} = locateEdit(file.text, old, next, replaceAll);
	const notes = [...warnings];
	if (lines.length === 0) {
		return withNotes({...diffLines(old, next), approximate: true}, notes);
	}
	if (replaceAll) {
		notes.push(`replace_all: ${lines.length} occurrence${lines.length === 1 ? '' : 's'}`);
	}
	const after = replaceAll ? file.text.split(old).join(next) : replaceFirst(file.text, old, next);
	return withNotes(diffLines(file.text, after), notes);
}

async function writePreview(
	input: Record<string, unknown>,
	scope: Scope,
	signal?: AbortSignal,
): Promise<Preview | undefined> {
	const {file_path: filePath, content} = input;
	if (typeof filePath !== 'string' || typeof content !== 'string') {
		return undefined;
	}
	const file = await readFileState(filePath, scope, signal);
	if (file.kind === 'missing') {
		return previewNewFile(content);
	}
	if (file.kind === 'text') {
		const diff = diffLines(file.text, content, {maxChars: FILE_READ_MAX});
		return diff.rows.length === 0
			? withNotes(diff, ['overwrites the file with identical content'])
			: diff;
	}
	const note =
		file.size === undefined
			? 'overwrites existing file, no preview'
			: `overwrites existing file (${file.size} bytes), no preview`;
	const fresh = previewNewFile(content);
	return withNotes({...fresh, approximate: true}, [note]);
}

export async function buildPreview(
	toolName: 'Edit' | 'Write',
	input: Record<string, unknown>,
	scope: Scope,
	signal?: AbortSignal,
): Promise<Preview | undefined> {
	try {
		if (typeof input !== 'object' || input === null) {
			return undefined;
		}
		return toolName === 'Edit'
			? await editPreview(input, scope, signal)
			: toolName === 'Write'
				? await writePreview(input, scope, signal)
				: undefined;
	} catch {
		return undefined;
	}
}
