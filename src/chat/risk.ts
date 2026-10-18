import {BASH_REVIEW_MAX, type Highlight} from './permission.js';

type Segment = {words: string[]; sep: string};

type Scan = {
	segments: Segment[];
	redirect: boolean;
	substitution: boolean;
};

const OPERATORS = new Set(['|', '&', ';', '\n', '(', ')']);

// Single pass, no backtracking: quotes and escapes are tracked only to avoid obvious false positives.
function scan(command: string): Scan {
	const segments: Segment[] = [];
	let words: string[] = [];
	let word = '';
	let inWord = false;
	let sep = '';
	let quote = '';
	let redirect = false;
	let substitution = false;
	const endWord = () => {
		if (inWord) {
			words.push(word);
		}
		word = '';
		inWord = false;
	};
	const endSegment = (next: string) => {
		endWord();
		if (words.length > 0) {
			segments.push({words, sep});
		}
		words = [];
		sep = next;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i] as string;
		if (quote === "'") {
			if (ch === "'") {
				quote = '';
			} else {
				word += ch;
			}
			continue;
		}
		if (ch === '\\') {
			word += command[i + 1] ?? '';
			inWord = true;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = '';
			} else {
				if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
					substitution = true;
				}
				word += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
			continue;
		}
		if (ch === '`' || (ch === '$' && command[i + 1] === '(')) {
			substitution = true;
		}
		if (ch === '>') {
			let j = i + 1;
			if (command[j] === '>' || command[j] === '|') {
				j++;
			}
			if (command[j] !== '&') {
				while (command[j] === ' ' || command[j] === '\t') {
					j++;
				}
				if (!command.startsWith('/dev/null', j) && j < command.length) {
					redirect = true;
				}
			}
			endWord();
			continue;
		}
		if (ch === ' ' || ch === '\t' || ch === '\r') {
			endWord();
			continue;
		}
		if (OPERATORS.has(ch)) {
			let op = ch;
			if ((ch === '|' || ch === '&') && command[i + 1] === ch) {
				op = ch + ch;
				i++;
			}
			endSegment(op);
			continue;
		}
		word += ch;
		inWord = true;
	}
	endSegment('');
	return {segments, redirect, substitution};
}

const WRAPPERS = new Set(['sudo', 'doas', 'su', 'env', 'command', 'time', 'nohup', 'exec', 'nice', 'xargs']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const NETWORK = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'rsync', 'sftp', 'ftp', 'telnet']);
const NAMED = [
	'CLAUDE.md',
	'CLAUDE.local.md',
	'.claude',
	'.yena',
	'.token',
	'credentials',
	'.env',
	'.ssh',
	'/proc',
	'settings',
];

const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1);
const isAssign = (word: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

// Index of the command word, skipping env assignments, wrappers and their options.
function commandIndex(words: string[]): {at: number; elevated: boolean} {
	let at = 0;
	let elevated = false;
	let afterWrapper = false;
	while (at < words.length) {
		const w = words[at] as string;
		const b = base(w);
		if (isAssign(w)) {
			at++;
		} else if (WRAPPERS.has(b)) {
			elevated ||= b === 'sudo' || b === 'doas' || b === 'su';
			afterWrapper = true;
			at++;
		} else if (afterWrapper && w.startsWith('-')) {
			at++;
		} else {
			break;
		}
	}
	return {at, elevated};
}

const hasFlag = (words: string[], short: RegExp, long?: string): boolean =>
	words.some(w => short.test(w) || (long !== undefined && w === long));

function hasNonAscii(command: string): boolean {
	for (let i = 0; i < command.length; i++) {
		if (command.charCodeAt(i) > 127) {
			return true;
		}
	}
	return false;
}

export function bashHighlights(command: string): Highlight[] {
	try {
		if (typeof command !== 'string') {
			return [];
		}
		const text = command.length > BASH_REVIEW_MAX ? command.slice(0, BASH_REVIEW_MAX) : command;
		const {segments, redirect, substitution} = scan(text);
		const warn = new Set<string>();
		const info = new Set<string>();

		segments.forEach((seg, idx) => {
			const {at, elevated} = commandIndex(seg.words);
			const name = base(seg.words[at] ?? '');
			const args = seg.words.slice(at + 1);
			if (elevated) {
				warn.add('runs with elevated privileges (sudo/su)');
			}
			if (name === 'rm' && hasFlag(args, /^-[a-zA-Z]*[rR][a-zA-Z]*$/, '--recursive')) {
				warn.add('deletes recursively (rm -r)');
			}
			if (SHELLS.has(name) && (seg.sep === '|' || seg.sep === '|&') && idx > 0) {
				warn.add('pipes data into a shell');
			}
			if (SHELLS.has(name) && hasFlag(args, /^-[a-z]*c$/)) {
				warn.add('runs an inline script (-c / -e / eval)');
			}
			if (/^python[0-9.]*$/.test(name) && hasFlag(args, /^-[a-z]*c$/)) {
				warn.add('runs an inline script (-c / -e / eval)');
			}
			if (/^(node|nodejs|perl|ruby|php|deno|bun)$/.test(name) && hasFlag(args, /^-[a-z]*[ep]$/, '--eval')) {
				warn.add('runs an inline script (-c / -e / eval)');
			}
			if (name === 'eval') {
				warn.add('runs an inline script (-c / -e / eval)');
			}
			if (name === 'base64' && hasFlag(args, /^-[a-zA-Z]*[dD]$/, '--decode')) {
				warn.add('decodes base64 data (base64 -d)');
			}
			if (name === 'chmod' || name === 'chown' || name === 'chgrp' || name === 'dd' || name.startsWith('mkfs')) {
				warn.add(`changes permissions or devices (${name.startsWith('mkfs') ? 'mkfs' : name})`);
			}
			if (NETWORK.has(name)) {
				info.add(`uses the network (${name})`);
			}
			const sub = args.find(w => !w.startsWith('-'));
			if (name === 'git' && (sub === 'push' || sub === 'clone')) {
				info.add(`uses the network (git ${sub})`);
			}
			if (
				(name === 'npm' && (sub === 'install' || sub === 'i' || sub === 'add')) ||
				((name === 'pip' || name === 'pip3') && sub === 'install') ||
				(name === 'apk' && sub === 'add')
			) {
				info.add(`installs packages (${name} ${sub})`);
			}
			if (name === 'cd') {
				const target = args[0];
				if (target === undefined || target.startsWith('/') || target.startsWith('~') || target === '-' || /(^|\/)\.\.(\/|$)/.test(target)) {
					info.add('changes directory outside the working directory (cd)');
				}
			}
			if (idx > 0 && (seg.sep === '&&' || seg.sep === ';' || seg.sep === '\n' || seg.sep === '||')) {
				info.add('chains several commands');
			}
		});

		if (text.includes('/dev/tcp') || text.includes('/dev/udp')) {
			warn.add('opens a network connection through /dev/tcp');
		}
		const names = NAMED.filter(n => text.includes(n));
		if (names.length > 0) {
			warn.add(`mentions protected or secret names: ${names.join(', ')}`);
		}
		if (substitution) {
			info.add('uses command substitution');
		}
		if (redirect) {
			info.add('writes to a file through a redirect');
		}
		if (hasNonAscii(text)) {
			info.add('contains non-ASCII characters (possible look-alike characters)');
		}
		if (command.length > BASH_REVIEW_MAX) {
			info.add(`only the first ${BASH_REVIEW_MAX} characters were checked`);
		}
		return [
			...[...warn].map(t => ({level: 'warn' as const, text: t})),
			...[...info].map(t => ({level: 'info' as const, text: t})),
		];
	} catch {
		return [];
	}
}
