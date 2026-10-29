import {spawn} from 'node:child_process';

export type LoginMethod = 'claude.ai' | 'console';
export type LoginStatus = {loggedIn: boolean; method?: LoginMethod; subscriptionType?: string; email?: string};
export type LoginProbe = () => Promise<LoginStatus | undefined>;

type CliOpts = {bin: string; env: Record<string, string | undefined>; timeoutMs?: number};

const MAX_STATUS_BYTES = 64 * 1024;
const SUBSCRIPTION = /^[a-z0-9_-]{1,32}$/i;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const validEmail = (v: string): boolean => v.length <= 254 && !v.startsWith('-') && EMAIL.test(v);

export const parseLoginStatus = (stdout: string): LoginStatus | undefined => {
	if (stdout.length > MAX_STATUS_BYTES) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.loggedIn !== 'boolean') return undefined;
	if (!r.loggedIn) return {loggedIn: false};
	let method: LoginMethod | undefined;
	if (r.authMethod === 'claude.ai') method = 'claude.ai';
	else if (r.authMethod === 'api_key' && r.apiKeySource === '/login managed key') method = 'console';
	if (!method) return {loggedIn: false};
	const out: LoginStatus = {loggedIn: true, method};
	if (typeof r.subscriptionType === 'string' && SUBSCRIPTION.test(r.subscriptionType)) {
		out.subscriptionType = r.subscriptionType;
	}
	if (typeof r.email === 'string' && validEmail(r.email)) out.email = r.email;
	return out;
};

// Resolves on timeout without waiting for 'close': a grandchild may keep the pipes open.
const runCli = (
	p: CliOpts,
	args: string[],
	capture: boolean,
): Promise<{code: number | null; stdout: string} | undefined> =>
	new Promise(resolve => {
		let done = false;
		let stdout = '';
		let child: ReturnType<typeof spawn>;
		const finish = (v: {code: number | null; stdout: string} | undefined): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => {
			child?.kill('SIGKILL');
			finish(undefined);
		}, p.timeoutMs ?? 10_000);
		try {
			child = spawn(p.bin, args, {
				shell: false,
				env: p.env as NodeJS.ProcessEnv,
				stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
			});
		} catch {
			finish(undefined);
			return;
		}
		child.on('error', () => finish(undefined));
		if (capture) {
			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', (chunk: string) => {
				if (stdout.length <= MAX_STATUS_BYTES) stdout += chunk;
			});
		}
		child.on('close', code => finish({code, stdout}));
	});

export const probeLogin = async (p: CliOpts): Promise<LoginStatus | undefined> => {
	const res = await runCli(p, ['auth', 'status', '--json'], true);
	return res ? parseLoginStatus(res.stdout) : undefined;
};

export const runLogout = async (p: CliOpts): Promise<boolean> => {
	const res = await runCli({...p, timeoutMs: p.timeoutMs ?? 30_000}, ['auth', 'logout'], false);
	return res?.code === 0;
};

export const LOGIN_USAGE = 'Usage: claude auth login [--name <account>] [--console|--claudeai] [--sso] [--email <address>]';

export type LoginRequest = {cliArgs: string[]; meta: {console: boolean; sso: boolean; email: boolean}};

const shown = (arg: string): string => {
	const clean = arg.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
	const chars = [...clean];
	return chars.length > 64 ? `${chars.slice(0, 64).join('')}…` : clean;
};

export const parseLoginArgs = (args: string[]): LoginRequest => {
	const cliArgs: string[] = [];
	let console_ = false;
	let claudeai = false;
	let sso = false;
	let email = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--console' || arg === '--claudeai') {
			if (console_ || claudeai) throw new Error(`Use only one of --console and --claudeai, once. ${LOGIN_USAGE}`);
			if (arg === '--console') console_ = true;
			else claudeai = true;
			cliArgs.push(arg);
		} else if (arg === '--sso') {
			if (sso) throw new Error(`"--sso" was given twice. ${LOGIN_USAGE}`);
			sso = true;
			cliArgs.push(arg);
		} else if (arg === '--email') {
			if (email) throw new Error(`"--email" was given twice. ${LOGIN_USAGE}`);
			const addr = args[++i];
			if (addr === undefined) throw new Error(`"--email" needs an address. ${LOGIN_USAGE}`);
			if (!validEmail(addr)) throw new Error(`Invalid email address for "--email". ${LOGIN_USAGE}`);
			email = true;
			cliArgs.push(arg, addr);
		} else {
			throw new Error(`Unknown option "${shown(arg)}". ${LOGIN_USAGE}`);
		}
	}
	return {cliArgs, meta: {console: console_, sso, email}};
};
