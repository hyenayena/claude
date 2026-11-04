import {wrapLines} from '../kit.js';
import type {AgentBox, AgentEntry} from './agents.js';
import {formatNotice, formatOut, formatUserLine, sgr, styledToolHeader, type Scrub} from './present.js';

const blockOf = (e: AgentEntry, scrub: Scrub, reveal: Scrub, width: number): string => {
	switch (e.kind) {
		case 'text':
			return formatOut({kind: 'assistant', text: e.text, interrupted: false}, scrub, reveal, width);
		case 'thinking':
			return formatOut({kind: 'thinking', text: e.text}, scrub, reveal, width);
		case 'notice':
			return formatNotice(e.text, scrub);
		case 'tool':
			if (!e.done) return styledToolHeader(e.name, e.input, scrub);
			return formatOut(
				{kind: 'tool', name: e.name, input: e.input, isError: e.isError === true, text: e.text ?? '', ...(e.patch !== undefined && {patch: e.patch})},
				scrub,
				reveal,
				width,
			);
	}
};

const lastText = (box: AgentBox): string | undefined => {
	for (let i = box.history.length - 1; i >= 0; i--) {
		const e = box.history[i]!;
		if (e.kind === 'text') return e.text;
		if (e.kind === 'tool') return undefined;
	}
	return undefined;
};

export function agentViewBlocks(box: AgentBox, scrub: Scrub, reveal: Scrub, width: number): string[] {
	const sg = sgr();
	const blocks: string[] = [];
	if (box.prompt.trim() !== '') blocks.push(formatUserLine(box.prompt, scrub));
	if (box.dropped > 0) blocks.push(`${sg.muted}… ${box.dropped} earlier message${box.dropped === 1 ? '' : 's'}${sg.reset}`);
	for (const e of box.history) blocks.push(blockOf(e, scrub, reveal, width));
	if (box.report !== undefined && box.report.trim() !== lastText(box)?.trim()) {
		blocks.push(formatOut({kind: 'assistant', text: box.report, interrupted: false}, scrub, reveal, width));
	}
	return blocks;
}

const cache = new WeakMap<AgentBox, {width: number; length: number; rows: string[]}>();

export function agentViewLines(box: AgentBox, scrub: Scrub, reveal: Scrub, width: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const hit = cache.get(box);
	if (hit && hit.width === w && hit.length === box.history.length) return hit.rows;
	const lines = agentViewBlocks(box, scrub, reveal, w).flatMap((block, i) => [...(i > 0 ? [''] : []), ...block.split('\n')]);
	const rows = wrapLines(lines, w, {mode: 'char'});
	cache.set(box, {width: w, length: box.history.length, rows});
	return rows;
}
