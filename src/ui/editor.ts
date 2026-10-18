export const MAX_INPUT = 32000;

export interface EditorState {
	text: string;
	cursor: number;
	truncated: boolean;
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

export function editorReduce(state: EditorState, action: EditorAction): EditorState {
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
		case 'killLine': {
			const start = lineStart(text, cursor);
			return {text: text.slice(0, start) + text.slice(cursor), cursor: start, truncated: false};
		}
		case 'clear':
			return emptyEditor;
	}
}
