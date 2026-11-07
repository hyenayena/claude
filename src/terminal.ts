import {spawnSync} from 'node:child_process';

export const editorCommand = (env: NodeJS.ProcessEnv): string => env['VISUAL'] || env['EDITOR'] || 'vi';

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
