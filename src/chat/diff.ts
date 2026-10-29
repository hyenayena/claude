import type {Preview, PreviewRow} from './permission.js';

export type DiffOptions = {
	context?: number;
	maxEdit?: number;
	maxLines?: number;
	maxChars?: number;
	maxRows?: number;
};

type Op = {t: 'eq' | 'add' | 'del'; text: string; no: number};

const splitLines = (text: string): string[] => {
	if (text === '') {
		return [];
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
};

const shown = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

const summary = (added: number, removed: number): Preview => ({
	rows: [{kind: 'meta', text: `+${added} -${removed} lines (too large to diff in detail)`}],
	added,
	removed,
	truncated: true,
	approximate: true,
});

function myers(a: number[], b: number[], maxEdit: number): ('eq' | 'add' | 'del')[] | undefined {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, maxEdit);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= max && found < 0; d++) {
		trace.push(v.slice(offset - d - 1, offset + d + 2));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
				x = v[offset + k + 1] as number;
			} else {
				x = (v[offset + k - 1] as number) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	if (found < 0) {
		return undefined;
	}
	const script: ('eq' | 'add' | 'del')[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const snap = trace[d] as Int32Array;
		const at = (k: number) => snap[k + d + 1] as number;
		const k = x - y;
		const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
		const prevX = at(prevK);
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			script.push('eq');
			x--;
			y--;
		}
		script.push(x === prevX ? 'add' : 'del');
		x = prevX;
		y = prevY;
	}
	while (x > 0 && y > 0) {
		script.push('eq');
		x--;
		y--;
	}
	return script.reverse();
}

export function diffLines(oldText: string, newText: string, opts: DiffOptions = {}): Preview {
	try {
		return diffUnsafe(String(oldText), String(newText), opts);
	} catch {
		return summary(0, 0);
	}
}

function diffUnsafe(oldText: string, newText: string, opts: DiffOptions): Preview {
	const context = Math.max(0, opts.context ?? 3);
	const maxEdit = Math.max(0, opts.maxEdit ?? 400);
	const maxLines = opts.maxLines ?? 5000;
	const maxChars = opts.maxChars ?? 262_144;
	const maxRows = Math.max(1, opts.maxRows ?? 2000);

	const oldLines = oldText.length > maxChars ? undefined : splitLines(oldText);
	const newLines = newText.length > maxChars ? undefined : splitLines(newText);
	if (!oldLines || !newLines) {
		return summary(newText === '' ? 0 : newText.split('\n').length, oldText === '' ? 0 : oldText.split('\n').length);
	}

	let pre = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (pre < minLen && oldLines[pre] === newLines[pre]) {
		pre++;
	}
	let suf = 0;
	while (
		suf < minLen - pre &&
		oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
	) {
		suf++;
	}
	const midOld = oldLines.slice(pre, oldLines.length - suf);
	const midNew = newLines.slice(pre, newLines.length - suf);
	if (oldLines.length > maxLines || newLines.length > maxLines) {
		return summary(midNew.length, midOld.length);
	}

	let script: ('eq' | 'add' | 'del')[] | undefined;
	if (midOld.length === 0) {
		script = midNew.map(() => 'add' as const);
	} else if (midNew.length === 0) {
		script = midOld.map(() => 'del' as const);
	} else {
		const ids = new Map<string, number>();
		const id = (s: string) => {
			let got = ids.get(s);
			if (got === undefined) {
				got = ids.size;
				ids.set(s, got);
			}
			return got;
		};
		script = myers(midOld.map(id), midNew.map(id), maxEdit);
	}
	if (!script) {
		return summary(midNew.length, midOld.length);
	}

	const ops: Op[] = [];
	for (let i = 0; i < pre; i++) {
		ops.push({t: 'eq', text: shown(oldLines[i] as string), no: i + 1});
	}
	let oi = pre;
	let ni = pre;
	let added = 0;
	let removed = 0;
	for (const step of script) {
		if (step === 'eq') {
			ops.push({t: 'eq', text: shown(newLines[ni] as string), no: ni + 1});
			oi++;
			ni++;
		} else if (step === 'del') {
			ops.push({t: 'del', text: shown(oldLines[oi] as string), no: oi + 1});
			oi++;
			removed++;
		} else {
			ops.push({t: 'add', text: shown(newLines[ni] as string), no: ni + 1});
			ni++;
			added++;
		}
	}
	for (let i = 0; i < suf; i++) {
		ops.push({t: 'eq', text: shown(newLines[ni + i] as string), no: ni + i + 1});
	}

	if (added === 0 && removed === 0) {
		return {rows: [], added: 0, removed: 0, truncated: false, approximate: false};
	}

	const keep = new Uint8Array(ops.length);
	for (let i = 0; i < ops.length; i++) {
		if ((ops[i] as Op).t !== 'eq') {
			for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) {
				keep[j] = 1;
			}
		}
	}

	const rows: PreviewRow[] = [];
	let truncated = false;
	let i = 0;
	while (i < ops.length) {
		if (rows.length >= maxRows) {
			rows.push({kind: 'meta', text: '… output truncated'});
			truncated = true;
			break;
		}
		if (!keep[i]) {
			let j = i;
			while (j < ops.length && !keep[j]) {
				j++;
			}
			rows.push({kind: 'gap', text: `... ${j - i} unchanged lines`});
			i = j;
			continue;
		}
		const op = ops[i] as Op;
		rows.push({kind: op.t === 'eq' ? 'ctx' : op.t, text: op.text, no: op.no});
		i++;
	}
	return {rows, added, removed, truncated, approximate: false};
}

const MAX_LOCATIONS = 1000;

export function locateEdit(
	fileText: string,
	old: string,
	_new: string,
	replaceAll: boolean,
): {lines: number[]; warnings: string[]} {
	const lines: number[] = [];
	const warnings: string[] = [];
	try {
		if (typeof fileText !== 'string' || typeof old !== 'string' || old === '') {
			return {lines, warnings: ['old_string is empty']};
		}
		let count = 0;
		let from = 0;
		let line = 1;
		let scanned = 0;
		for (;;) {
			const at = fileText.indexOf(old, from);
			if (at < 0 || count >= MAX_LOCATIONS) {
				break;
			}
			for (let p = fileText.indexOf('\n', scanned); p >= 0 && p < at; p = fileText.indexOf('\n', scanned)) {
				line++;
				scanned = p + 1;
			}
			count++;
			lines.push(line);
			from = at + old.length;
		}
		if (count === 0) {
			warnings.push('old_string not found in the current file');
		} else if (count > 1 && !replaceAll) {
			warnings.push(`matches ${count} places; Edit will fail unless unique`);
		}
	} catch {
		return {lines: [], warnings: []};
	}
	return {lines, warnings};
}

const NEW_FILE_ROWS = 40;

export function previewNewFile(content: string): Preview {
	const text = typeof content === 'string' ? content : '';
	const all = splitLines(text);
	const rows: PreviewRow[] = all
		.slice(0, NEW_FILE_ROWS)
		.map((line, i) => ({kind: 'add' as const, text: shown(line), no: i + 1}));
	const truncated = all.length > NEW_FILE_ROWS;
	if (truncated) {
		rows.push({kind: 'gap', text: `... ${all.length - NEW_FILE_ROWS} more lines`});
	}
	rows.push({kind: 'meta', text: `${all.length} lines, ${Buffer.byteLength(text)} bytes`});
	return {rows, added: all.length, removed: 0, truncated, approximate: false};
}
