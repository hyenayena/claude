import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatAssistantBlock, formatToolBlock, formatUserLine} from '../../src/ui/present.js';

const KEYS = ['NO_COLOR', 'YENA_COLOR', 'COLORTERM', 'TERM'];

test('laying out thousands of blocks reads the environment at most once per key', () => {
	// A fresh process per test file: the depth has not been detected yet.
	const reads = new Map<string, number>();
	const real = process.env;
	process.env = new Proxy(real, {
		get(target, key, receiver) {
			if (typeof key === 'string' && KEYS.includes(key)) reads.set(key, (reads.get(key) ?? 0) + 1);
			return Reflect.get(target, key, receiver);
		},
	});
	const scrub = (s: string) => s;
	try {
		for (const width of [80, 120]) {
			for (let i = 0; i < 2000; i++) {
				formatUserLine(`line ${i}`, scrub);
				formatAssistantBlock(`- item ${i}\n\n\`code\` and **bold**`, scrub, false, width);
				formatToolBlock({name: 'Bash', input: {command: 'ls'}, isError: i % 2 === 0, text: 'out'}, scrub, width);
			}
		}
	} finally {
		process.env = real;
	}
	for (const k of KEYS) assert.ok((reads.get(k) ?? 0) <= 1, `${k} read ${reads.get(k)} times`);
});
