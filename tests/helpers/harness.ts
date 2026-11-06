import {PassThrough} from 'node:stream';
import type {ReactElement} from 'react';
import {render} from 'ink';

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function mountHarness(element: ReactElement, size = {columns: 80, rows: 24}) {
	const stdin = Object.assign(new PassThrough(), {
		isTTY: true,
		raw: [] as boolean[],
		setRawMode(value: boolean) {
			this.raw.push(value);
			return this;
		},
		ref() {},
		unref() {},
	});
	const stdout = Object.assign(new PassThrough(), {isTTY: true, ...size});
	const chunks: string[] = [];
	stdout.on('data', chunk => chunks.push(String(chunk)));

	const instance = render(element, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: new PassThrough() as unknown as NodeJS.WriteStream,
		debug: true,
		interactive: true,
		exitOnCtrlC: false,
		patchConsole: false,
	});

	return {
		chunks,
		press: (sequence: string) => stdin.write(sequence),
		settle: (ms = 30) => wait(ms),
		lastFrame: () => chunks.at(-1) ?? '',
		resize(columns: number, rows: number) {
			Object.assign(stdout, {columns, rows});
			stdout.emit('resize');
		},
		unmount: () => instance.unmount(),
	};
}
