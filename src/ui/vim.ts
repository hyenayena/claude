import type {EditorAction} from './editor.js';

// A small vim layer for the chat input: INSERT types as usual, NORMAL moves and edits.
export type VimMode = 'insert' | 'normal';
export type VimState = {mode: VimMode; pending: '' | 'd' | 'c' | 'y'};

export const vimStart: VimState = {mode: 'insert', pending: ''};

export type VimKey = {input: string; escape?: boolean; return?: boolean; leftArrow?: boolean; rightArrow?: boolean; upArrow?: boolean; downArrow?: boolean; backspace?: boolean};

/** What the chat does for a key in NORMAL mode (or Esc in INSERT). */
export type VimEffect =
	| {kind: 'edit'; actions: EditorAction[]}
	| {kind: 'submit'}
	| {kind: 'undo'}
	| {kind: 'history'; step: -1 | 1}
	// Esc in NORMAL: the chat's own Esc (interrupt, clear, open the console).
	| {kind: 'escape'}
	| {kind: 'none'};

const edit = (...actions: EditorAction[]): VimEffect => ({kind: 'edit', actions});

/**
 * One key while vim mode is on. INSERT keys other than Esc are not handled here (the chat types
 * them); `handled: false` tells the chat to treat the key as usual.
 */
export function vimKey(state: VimState, key: VimKey): {state: VimState; effect: VimEffect; handled: boolean} {
	if (state.mode === 'insert') {
		if (key.escape) return {state: {mode: 'normal', pending: ''}, effect: edit({type: 'left'}), handled: true};
		return {state, effect: {kind: 'none'}, handled: false};
	}
	const normal = (effect: VimEffect, mode: VimMode = 'normal'): {state: VimState; effect: VimEffect; handled: boolean} => ({
		state: {mode, pending: ''},
		effect,
		handled: true,
	});
	if (key.escape) return state.pending ? normal({kind: 'none'}) : normal({kind: 'escape'});
	if (key.return) return normal({kind: 'submit'});
	if (key.leftArrow || key.backspace) return normal(edit({type: 'left'}));
	if (key.rightArrow) return normal(edit({type: 'right'}));
	if (key.upArrow) return normal({kind: 'history', step: -1});
	if (key.downArrow) return normal({kind: 'history', step: 1});

	const ch = key.input;
	if (state.pending) {
		const op = state.pending;
		const killed: Record<string, EditorAction[]> = {
			w: [{type: 'killToNextWord'}],
			e: [{type: 'killWordForward'}],
			b: [{type: 'killWordBack'}],
			$: [{type: 'killEnd'}],
			'0': [{type: 'killLine'}],
		};
		const whole: EditorAction[] = [{type: 'home'}, {type: 'killEnd'}];
		const actions = ch === op ? whole : killed[ch];
		if (!actions) return normal({kind: 'none'});
		if (op === 'y') {
			// Yank = kill then put the text straight back, so the kill ring holds it and nothing changes.
			return normal(edit(...actions, {type: 'yank'}));
		}
		return normal(edit(...actions), op === 'c' ? 'insert' : 'normal');
	}
	switch (ch) {
		case 'h':
			return normal(edit({type: 'left'}));
		case 'l':
		case ' ':
			return normal(edit({type: 'right'}));
		case '0':
		case '^':
			return normal(edit({type: 'home'}));
		case '$':
			return normal(edit({type: 'end'}));
		case 'w':
		case 'e':
			return normal(edit({type: 'wordRight'}));
		case 'b':
			return normal(edit({type: 'wordLeft'}));
		case 'j':
			return normal({kind: 'history', step: 1});
		case 'k':
			return normal({kind: 'history', step: -1});
		case 'x':
			return normal(edit({type: 'delete'}));
		case 'X':
			return normal(edit({type: 'backspace'}));
		case 'D':
			return normal(edit({type: 'killEnd'}));
		case 'C':
			return normal(edit({type: 'killEnd'}), 'insert');
		case 'p':
		case 'P':
			return normal(edit({type: 'yank'}));
		case 'u':
			return normal({kind: 'undo'});
		case 'i':
			return normal(edit(), 'insert');
		case 'a':
			return normal(edit({type: 'right'}), 'insert');
		case 'I':
			return normal(edit({type: 'home'}), 'insert');
		case 'A':
			return normal(edit({type: 'end'}), 'insert');
		case 'o':
			return normal(edit({type: 'end'}, {type: 'insert', text: '\n'}), 'insert');
		case 'O':
			return normal(edit({type: 'home'}, {type: 'insert', text: '\n'}, {type: 'left'}), 'insert');
		case 's':
			return normal(edit({type: 'delete'}), 'insert');
		case 'S':
			return normal(edit({type: 'home'}, {type: 'killEnd'}), 'insert');
		// ":" starts typing a command such as ":q" on the line.
		case ':':
			return normal(edit({type: 'insert', text: ':'}), 'insert');
		case 'd':
		case 'c':
		case 'y':
			return {state: {mode: 'normal', pending: ch}, effect: {kind: 'none'}, handled: true};
		default:
			return normal({kind: 'none'});
	}
}
