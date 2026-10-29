import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export const editorCommand = (env: NodeJS.ProcessEnv): string => env['VISUAL'] || env['EDITOR'] || 'vi';

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

export function editFile(file: string, env: NodeJS.ProcessEnv): boolean {
	const r = spawnSync(editorCommand(env), [file], {stdio: 'inherit', env, shell: false});
	return !r.error && r.status === 0;
}

export function runInteractive(bin: string, args: string[], env: NodeJS.ProcessEnv): boolean {
	const r = spawnSync(bin, args, {stdio: 'inherit', env, shell: false});
	return !r.error && r.status === 0;
}

export function runInteractiveStatus(bin: string, args: string[], env: NodeJS.ProcessEnv): number | undefined {
	const r = spawnSync(bin, args, {stdio: 'inherit', env, shell: false});
	return r.error || r.status === null ? undefined : r.status;
}

export function readHidden(prompt: string): string {
	const script = 'printf "%s" "$1" >&2; stty -echo; IFS= read -r t; stty echo; printf "\\n" >&2; printf "%s" "$t"';
	const r = spawnSync('sh', ['-c', script, 'sh', prompt], {stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8'});
	return typeof r.stdout === 'string' ? r.stdout : '';
}

export function readLine(prompt: string): string {
	const script = 'printf "%s" "$1" >&2; IFS= read -r t; printf "%s" "$t"';
	const r = spawnSync('sh', ['-c', script, 'sh', prompt], {stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8'});
	return typeof r.stdout === 'string' ? r.stdout : '';
}

export function waitForEnter(message: string): void {
	spawnSync('sh', ['-c', 'printf "%s" "$1" >&2; IFS= read -r _', 'sh', message], {stdio: 'inherit'});
}
