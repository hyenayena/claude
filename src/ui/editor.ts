export const MAX_INPUT = 32000;

export interface EditorState {
	text: string;
	cursor: number;
	truncated: boolean;
	// The last text removed by a kill (Ctrl+K/U/W, Alt+D, vim d/c/x), for Ctrl+Y and vim p.
	killed?: string;
}

export type EditorAction =
	| {type: 'insert'; text: string}
	| {type: 'backspace'}
	| {type: 'delete'}
	| {type: 'left'}
	| {type: 'right'}
	| {type: 'home'}
	| {type: 'end'}
	| {type: 'killLine'}
	| {type: 'killEnd'}
	| {type: 'killWordBack'}
	| {type: 'killWordForward'}
	// vim dw: the word and the spaces after it.
	| {type: 'killToNextWord'}
	| {type: 'wordLeft'}
	| {type: 'wordRight'}
	| {type: 'yank'}
	| {type: 'set'; text: string}
	| {type: 'clear'};

export const emptyEditor: EditorState = {text: '', cursor: 0, truncated: false};

export function normalizeNewlines(s: string): string {
	return s.replace(/\r\n?/g, '\n');
}

function lineStart(text: string, cursor: number): number {
	return text.lastIndexOf('\n', cursor - 1) + 1;
}

function lineEnd(text: string, cursor: number): number {
	const i = text.indexOf('\n', cursor);
	return i === -1 ? text.length : i;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

/** Start of the word before the cursor (spaces skipped first). */
export function wordStartBefore(text: string, cursor: number): number {
	let i = cursor;
	while (i > 0 && isSpace(text[i - 1])) i--;
	while (i > 0 && !isSpace(text[i - 1])) i--;
	return i;
}

/** End of the word after the cursor (spaces skipped first). */
export function wordEndAfter(text: string, cursor: number): number {
	let i = cursor;
	while (i < text.length && isSpace(text[i])) i++;
	while (i < text.length && !isSpace(text[i])) i++;
	return i;
}

const cut = (state: EditorState, from: number, to: number): EditorState => {
	if (to <= from) return state;
	return {text: state.text.slice(0, from) + state.text.slice(to), cursor: from, truncated: false, killed: state.text.slice(from, to)};
};

export function editorReduce(state: EditorState, action: EditorAction): EditorState {
	const next = reduce(state, action);
	// The kill ring survives every edit that does not replace it.
	return next.killed === undefined && state.killed !== undefined ? {...next, killed: state.killed} : next;
}

function reduce(state: EditorState, action: EditorAction): EditorState {
	const {text, cursor} = state;
	switch (action.type) {
		case 'insert': {
			const room = MAX_INPUT - text.length;
			if (room <= 0) return {...state, truncated: action.text.length > 0};
			const ins = normalizeNewlines(action.text).slice(0, room);
			const truncated = ins.length < normalizeNewlines(action.text).length;
			return {
				text: text.slice(0, cursor) + ins + text.slice(cursor),
				cursor: cursor + ins.length,
				truncated,
			};
		}
		case 'backspace':
			if (cursor === 0) return state;
			return {text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1, truncated: false};
		case 'delete':
			if (cursor >= text.length) return state;
			return {text: text.slice(0, cursor) + text.slice(cursor + 1), cursor, truncated: false};
		case 'left':
			return {...state, cursor: Math.max(0, cursor - 1), truncated: false};
		case 'right':
			return {...state, cursor: Math.min(text.length, cursor + 1), truncated: false};
		case 'home':
			return {...state, cursor: lineStart(text, cursor), truncated: false};
		case 'end':
			return {...state, cursor: lineEnd(text, cursor), truncated: false};
		case 'killLine':
			return cut(state, lineStart(text, cursor), cursor);
		case 'killEnd':
			return cut(state, cursor, lineEnd(text, cursor));
		case 'killWordBack':
			return cut(state, wordStartBefore(text, cursor), cursor);
		case 'killWordForward':
			return cut(state, cursor, wordEndAfter(text, cursor));
		case 'killToNextWord': {
			let end = cursor;
			while (end < text.length && !isSpace(text[end])) end++;
			while (end < text.length && isSpace(text[end]) && text[end] !== '\n') end++;
			return cut(state, cursor, end);
		}
		case 'wordLeft':
			return {...state, cursor: wordStartBefore(text, cursor), truncated: false};
		case 'wordRight':
			return {...state, cursor: wordEndAfter(text, cursor), truncated: false};
		case 'yank':
			return state.killed ? editorReduce(state, {type: 'insert', text: state.killed}) : state;
		case 'set':
			return editorReduce(emptyEditor, {type: 'insert', text: action.text});
		case 'clear':
			return emptyEditor;
	}
}
