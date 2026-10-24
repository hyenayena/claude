import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// These run while core has handed the terminal over (ctx.suspend); they block on purpose so that
// nothing renders over the child program.

export const editorCommand = (env: NodeJS.ProcessEnv): string => env['VISUAL'] || env['EDITOR'] || 'vi';

/** Opens `text` in the user's editor; the edited text, or undefined when the editor failed. */
export function editInEditor(text: string, env: NodeJS.ProcessEnv): string | undefined {
	const dir = mkdtempSync(path.join(tmpdir(), 'yena-prompt-'));
	const file = path.join(dir, 'prompt.md');
	try {
		writeFileSync(file, text, {mode: 0o600});
		const r = spawnSync(editorCommand(env), [file], {stdio: 'inherit', env, shell: false});
		if (r.error || r.status !== 0) return undefined;
		return readFileSync(file, 'utf8').replace(/\n$/, '');
	} finally {
		rmSync(dir, {recursive: true, force: true});
	}
}

/** Opens a file in the user's editor; false when the editor failed. */
export function editFile(file: string, env: NodeJS.ProcessEnv): boolean {
	const r = spawnSync(editorCommand(env), [file], {stdio: 'inherit', env, shell: false});
	return !r.error && r.status === 0;
}

/** Runs an interactive program on the terminal; true when it exited with 0. */
export function runInteractive(bin: string, args: string[], env: NodeJS.ProcessEnv): boolean {
	const r = spawnSync(bin, args, {stdio: 'inherit', env, shell: false});
	return !r.error && r.status === 0;
}

/** Runs an interactive program on the terminal; its exit status, or undefined when it did not start or a signal ended it. */
export function runInteractiveStatus(bin: string, args: string[], env: NodeJS.ProcessEnv): number | undefined {
	const r = spawnSync(bin, args, {stdio: 'inherit', env, shell: false});
	return r.error || r.status === null ? undefined : r.status;
}

/** Asks for a secret on the terminal without echo; the typed line (never logged or shown). */
export function readHidden(prompt: string): string {
	const script = 'printf "%s" "$1" >&2; stty -echo; IFS= read -r t; stty echo; printf "\\n" >&2; printf "%s" "$t"';
	const r = spawnSync('sh', ['-c', script, 'sh', prompt], {stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8'});
	return typeof r.stdout === 'string' ? r.stdout : '';
}

/** Waits for Enter, so output stays readable before the app comes back. */
export function waitForEnter(message: string): void {
	spawnSync('sh', ['-c', 'printf "%s" "$1" >&2; IFS= read -r _', 'sh', message], {stdio: 'inherit'});
}
