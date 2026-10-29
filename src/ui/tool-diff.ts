import {diffLines} from '../chat/diff.js';
import type {ToolPatch} from '../chat/events.js';
import type {PreviewRow} from '../chat/permission.js';

export const WRITE_HEAD_LINES = 10;

export type DiffRows = {rows: PreviewRow[]; added: number; removed: number};
export type WriteRows = DiffRows & {mode: 'diff' | 'head' | 'none'; total: number};

const inputText = (input: unknown, key: string): string => {
	if (typeof input !== 'object' || input === null) return '';
	const v = (input as Record<string, unknown>)[key];
	return typeof v === 'string' ? v : '';
};

const dropCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s);

const isEmpty = (patch: ToolPatch): boolean => patch.hunks.every(h => h.lines.length === 0);

export function patchRows(patch: ToolPatch): DiffRows {
	const rows: PreviewRow[] = [];
	let added = 0;
	let removed = 0;
	patch.hunks.forEach((h, i) => {
		if (i > 0) rows.push({kind: 'gap', text: ''});
		let o = h.oldStart;
		let n = h.newStart;
		for (const line of h.lines) {
			const text = dropCr(line.slice(1));
			switch (line[0]) {
				case ' ':
					rows.push({kind: 'ctx', text, no: n});
					o++;
					n++;
					break;
				case '-':
					rows.push({kind: 'del', text, no: o++});
					removed++;
					break;
				case '+':
					rows.push({kind: 'add', text, no: n++});
					added++;
					break;
			}
		}
	});
	return {rows, added, removed};
}

export function editRows(input: unknown, patch?: ToolPatch): DiffRows {
	if (patch !== undefined && !isEmpty(patch)) return patchRows(patch);
	const preview = diffLines(inputText(input, 'old_string'), inputText(input, 'new_string'));
	const rows = preview.rows.map(({kind, text}) => ({kind, text}));
	return {rows, added: preview.added, removed: preview.removed};
}

const contentLines = (content: string): string[] => {
	if (content === '') return [];
	const lines = content.split('\n');
	if (content.endsWith('\n')) lines.pop();
	return lines;
};

export function writeRows(input: unknown, patch?: ToolPatch): WriteRows {
	if (patch === undefined || patch.created === true) {
		const lines = contentLines(inputText(input, 'content'));
		const rows = lines.slice(0, WRITE_HEAD_LINES).map((l, i): PreviewRow => ({kind: 'add', text: dropCr(l), no: i + 1}));
		return {mode: 'head', rows, added: lines.length, removed: 0, total: lines.length};
	}
	if (isEmpty(patch)) return {mode: 'none', rows: [], added: 0, removed: 0, total: 0};
	const diff = patchRows(patch);
	return {mode: 'diff', ...diff, total: diff.rows.length};
}
