import {accessSync, constants} from 'node:fs';
import {join} from 'node:path';
import type {ArgumentDoc, Command, CommandContext, Logger, OptionDoc, Setting, SettingsTab, StyledBlock, StyledCell, StyledSpan, Subcommand} from '../../../src/api.js';
import {line, printStyled, span, table, textBlock} from './kit.js';
import {chatSettings} from './chat-prefs.js';
import {type AccountView, checkAccountName, chooseAccount, clearPin, listAccounts, newAccountNameProblem, pinnedAccount, removeAccount, setOrder, suggestSecretName, useAccount} from './accounts.js';
import {legacyCount} from './migrate.js';
import {degradedReason, type ClaudeVault} from './vault.js';
import {isTier, makeScrub, type ChatProvider} from './deps/chat.js';
import {createSessionHub} from './session-hub.js';
import {createClaudeProvider} from './provider.js';
import {cliEnv, resolvePaths, runtimeInfo} from './config.js';
import {parseLoginArgs, probeLogin, runLogout, type LoginProbe, type LoginRequest} from './claude-login.js';
import {
	accountsCtx,
	allSecrets,
	type CredentialOpts,
	describeCredential,
	inspectFileMode,
	loadBundle,
	noteLoginStatus,
	refreshLoginInfo,
	makeRedactor,
	API_KEY_ONLY,
	noCredentials,
	requireCredential,
	resolveCredential,
	storeSecret,
	vaultOf,
} from './credentials.js';
import {editFile, readHidden, readLine, runInteractive, runInteractiveStatus, waitForEnter} from './terminal.js';
import {loadRetiredCredentials} from './deps/account.js';
import {noopLog} from './log.js';
import type {ChatRunDeps} from './chat/open.js';
import {readHolder} from './sessions/lock.js';
import {createStore, isModelId} from './store.js';
import type {ChatQueryFn, Credential, CredentialInfo, QueryFn} from './types.js';

const ruleKind = (rule: string): string =>
	rule.startsWith('mcp:')
		? 'MCP tool allowed with "always"'
		: rule.startsWith('cmd:')
			? 'Console command allowed with "always"'
			: rule.startsWith('web:')
				? 'Host WebFetch may reach without asking'
				: 'Bash command allowed with "always"';

export type ClaudeDeps = {
	dataDir: string;
	env: NodeJS.ProcessEnv;
	loadQuery: () => Promise<QueryFn>;
	loadChatQuery?: () => Promise<ChatQueryFn>;
	loadConsoleSdk?: ChatRunDeps['loadConsoleSdk'];
	shellTmp?: ChatRunDeps['shellTmp'];
	spawnRunner?: ChatRunDeps['spawnRunner'];
	chatTiming?: Pick<ChatRunDeps, 'remote'>;
	moduleDir?: string;
	runCode?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => number | undefined;
	sessionDir?: () => string;
	log?: Logger;
	vault?: ClaudeVault;
	loadRetired?: typeof loadRetiredCredentials;
	redactExtra?: (text: string) => string;
	timeoutMs?: number;
	registerAbort?: (c: AbortController) => () => void;
	login?: {
		probe?: LoginProbe;
		run?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => boolean;
		logout?: (bin: string, env: Record<string, string | undefined>) => Promise<boolean>;
		wait?: (message: string) => void;
		readSecret?: (prompt: string) => string;
		promptSecret?: (ctx: CommandContext, label: string) => Promise<string>;
		readName?: (prompt: string) => string;
		promptName?: (ctx: CommandContext, label: string, initial: string, validate: (value: string) => string | undefined) => Promise<string | undefined>;
	};
};

const unknownSubcommand = (name: string): string => `Unknown subcommand "${makeScrub(s => s)(name).slice(0, 64)}". See "claude help"`;
const AUTH_USAGE = 'Usage: claude auth <status|login|add|order|use|auto|remove|logout>';
const ORDER_USAGE = 'Usage: claude auth order <account>…';
const ADD_USAGE = 'Usage: claude auth add [--name <account>]';
const TIER_USAGE = 'Usage: claude tier [auto|light|standard|strong|max]';

export {MODEL_OPTIONS} from './chat-prefs.js';

const takeName = (args: string[]): {name: string | undefined; rest: string[]} => {
	const at = args.indexOf('--name');
	if (at < 0) return {name: undefined, rest: args};
	const name = args[at + 1];
	if (name === undefined || name.startsWith('--')) throw new Error('"--name" needs an account name');
	if (args.indexOf('--name', at + 1) >= 0) throw new Error('"--name" was given twice');
	return {name: checkAccountName(name), rest: [...args.slice(0, at), ...args.slice(at + 2)]};
};

const TYPE_LABELS: Record<AccountView['type'], string> = {
	env: 'environment variable',
	login: 'Claude Code login',
	key: 'API key',
};

const SOURCE_LABELS: Record<CredentialInfo['source'], string> = {
	env: 'environment variable',
	'claude-login': 'Claude Code login',
	stored: 'stored in the account module',
};

const UNUSABLE_LABELS: Record<NonNullable<AccountView['unusable']>, string> = {
	disabled: 'disabled in the account module',
	reserved: 'not used: the name is reserved for an environment variable',
	missing: 'not used: no secret is set',
};

const LOGOUT_USAGE = 'Usage: claude auth logout';

export const createClaudeCommand = (deps: ClaudeDeps): Command => createClaudeCommands(deps).find(c => c.name === 'claude')!;

export const createClaudeCommands = (deps: ClaudeDeps): Command[] => createClaude(deps).commands;


export const createClaude = (deps: ClaudeDeps): {commands: Command[]; provider: ChatProvider} => {
	const {dataDir, env} = deps;
	const log = deps.log ?? noopLog;
	const store = createStore(dataDir, log);
	const redactor = (cred?: Credential) => makeRedactor(cred, allSecrets(credOpts), deps.redactExtra);
	const loginPaths = () => resolvePaths(dataDir, deps.moduleDir);
	const cliBin = (): string | undefined => {
		const paths = loginPaths();
		return runtimeInfo(paths).cli ? paths.runtimeBin : undefined;
	};
	const probe: LoginProbe =
		deps.login?.probe ??
		(async () => {
			const bin = cliBin();
			return bin ? probeLogin({bin, env: cliEnv(env, loginPaths())}) : undefined;
		});
	const credOpts: CredentialOpts = {env, dataDir, log, probeLogin: probe, ...(deps.vault && {vault: deps.vault})};
	const vault = vaultOf(credOpts);
	const runCli = deps.login?.run ?? ((bin, args, e) => runInteractive(bin, args, e));
	const runCode = deps.runCode ?? runInteractiveStatus;
	const wait = deps.login?.wait ?? waitForEnter;
	const readSecret = deps.login?.readSecret ?? readHidden;
	const readName = deps.login?.readName ?? readLine;
	const logoutCli = deps.login?.logout ?? ((bin, e) => runLogout({bin, env: e}));
	const hub = createSessionHub(deps, store, credOpts, log);
	const provider = createClaudeProvider(hub, deps);

	let rules: string[] = [];
	const refreshRules = async (): Promise<void> => {
		try {
			rules = (await store.read()).allowedCommands ?? [];
		} catch {
			rules = [];
		}
	};
	void refreshRules();
	hub.onRulesChanged = () => void refreshRules();

	const ruleSettings = (): Setting[] =>
		rules.map((rule, i) => ({
			key: `rule:${i}`,
			label: rule.length > 80 ? `${rule.slice(0, 79)}…` : rule,
			description: ruleKind(rule),
			options: [
				{value: 'keep', label: 'Allowed'},
				{value: 'remove', label: 'Remove', description: 'ask again next time'},
			],
			get: () => (rules.includes(rule) ? 'keep' : 'remove'),
			set: async value => {
				if (value !== 'remove') return;
				const now = (await store.read()).allowedCommands ?? [];
				await store.update({allowedCommands: now.filter(c => c !== rule)});
				hub.openSession?.forget(rule);
				log.info('permission rule removed');
				await refreshRules();
			},
		}));

	const printActive = async (ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential(credOpts);
		if (active) ctx.print(`Active credential: ${describeCredential(active)}`);
	};

	const chatRunning = (): boolean => {
		if (hub.openSession?.state === 'running') return true;
		const dir = hub.sessionsDir();
		return dir !== undefined && readHolder(dir).holder !== undefined;
	};

	const accountTable = (list: AccountView[]): StyledBlock => {
		const chosen = chooseAccount(accountsCtx(credOpts));
		const pinned = pinnedAccount(accountsCtx(credOpts))?.name;
		const scrub = makeScrub(redactor());
		return table(
			list.map((a, i) => {
				const what =
					a.type === 'login'
						? `Claude Code login (${a.kind === 'oauth' ? 'subscription' : 'Console'}${a.email ? `, ${a.email}` : ''})`
						: a.type === 'env'
							? `${a.kind === 'api-key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN'} (${TYPE_LABELS.env})`
							: 'API key (stored in the account module)';
				const state: StyledCell = a.unusable !== undefined ? span(scrub(UNUSABLE_LABELS[a.unusable]), {tone: 'error'}) : '';
				const head: StyledSpan[] = [
					chosen?.name === a.name ? span('▸', {tone: 'accent'}) : span(' '),
					span(` ${i + 1}. `),
					...(pinned === a.name ? [span('*', {tone: 'accent'})] : []),
					span(scrub(a.name), {bold: true}),
				];
				return [head, scrub(what), state];
			}),
		);
	};

	const authStatus = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude auth status');
		await loadBundle(credOpts);
		const list = listAccounts(accountsCtx(credOpts));
		const active = await resolveCredential(credOpts);
		const status = vault.current().status;
		log.info('auth status', {kind: active?.kind, source: active?.source, accounts: list.length});
		const blocks: StyledBlock[] = [];
		if (!active) {
			blocks.push(textBlock(noCredentials(vault.current()), 'warn'));
		} else {
			blocks.push(line(span('Active credential:', {bold: true}), ` ${describeCredential(active)}`));
			const pin = pinnedAccount(accountsCtx(credOpts));
			if (pin) blocks.push(line(span(`Pinned: "${pin.name}" ("claude auth auto" unpins)`, {tone: 'accent'})));
			blocks.push(
				line(
					span('Accounts', {bold: true}),
					span(' (▸ is used for new turns: the pinned account, else the first in this order; yena never switches on its own):', {tone: 'muted'}),
				),
			);
			blocks.push(accountTable(list));
			const reason = degradedReason(status);
			if (reason) blocks.push(line(span(reason, {tone: 'warn'})));
		}
		const waiting = status === 'ok' ? 0 : legacyCount(dataDir);
		if (waiting > 0) {
			blocks.push(line(span(`${waiting} stored Claude account${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} to move to the account module: account grant claude`, {tone: 'warn'})));
		}
		for (const warning of await inspectFileMode(dataDir)) blocks.push(line(span(`Warning: ${warning}`, {tone: 'warn'})));
		printStyled(ctx, blocks);
		if (active) await hub.showNoticeOnce(active, ctx);
		else await hub.showRetiredOnce(ctx);
	};

	const authOrder = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length === 0) throw new Error(ORDER_USAGE);
		await loadBundle(credOpts);
		const list = setOrder(accountsCtx(credOpts), args);
		log.info('auth order', {count: list.length});
		printStyled(ctx, [accountTable(list)]);
	};

	const authUse = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.includes('--only')) {
			throw new Error('Unknown option "--only": yena no longer switches accounts on its own, so "claude auth use <account>" already keeps it until "claude auth auto"');
		}
		if (args.length !== 1 || args[0]!.startsWith('--')) throw new Error('Usage: claude auth use <account>');
		const name = args[0]!;
		await loadBundle(credOpts);
		const list = useAccount(accountsCtx(credOpts), name);
		log.info('auth use', {count: list.length});
		printStyled(ctx, [line(`"${name}" is pinned: new turns use it until "claude auth auto".`), accountTable(list)]);
		hub.refreshOpenPin?.();
	};

	const authAuto = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error('Usage: claude auth auto');
		await loadBundle(credOpts);
		const cleared = clearPin(accountsCtx(credOpts));
		log.info('auth auto', {cleared});
		printStyled(ctx, [
			line(cleared ? 'No account is pinned any more; new turns use the first account in the order.' : 'No account was pinned.'),
			accountTable(listAccounts(accountsCtx(credOpts))),
		]);
		hub.refreshOpenPin?.();
	};

	const authRemove = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length !== 1) throw new Error('Usage: claude auth remove <account>');
		await loadBundle(credOpts);
		await removeAccount(accountsCtx(credOpts), vault, args[0]!);
		log.info('auth remove');
		ctx.print(`Account "${args[0]}" removed.`);
		if (hub.chatOpen) ctx.print('The open chat keeps its current account until Claude Code restarts.');
		await printActive(ctx);
		hub.refreshOpenPin?.();
	};

	const promptSecret =
		deps.login?.promptSecret ??
		(async (ctx: CommandContext, label: string): Promise<string> => {
			if (ctx.mount && !ctx.headless) {
				const {secretPrompt} = await import('./ui/secret-prompt.js');
				let value = '';
				await ctx.mount(control => secretPrompt(control, label, v => (value = v)), {target: 'panel'});
				return value;
			}
			if (ctx.suspend) return ctx.suspend(() => readSecret(`${label} (input hidden): `));
			throw new Error('"claude auth add" needs the app (./yena) or a terminal: the key is typed into a hidden input');
		});

	const promptName =
		deps.login?.promptName ??
		(async (ctx: CommandContext, label: string, initial: string, validate: (v: string) => string | undefined): Promise<string | undefined> => {
			if (ctx.mount && !ctx.headless) {
				const {namePrompt} = await import('./ui/name-prompt.js');
				let value: string | undefined;
				await ctx.mount(control => namePrompt(control, label, initial, validate, v => (value = v)), {target: 'panel'});
				return value;
			}
			if (!ctx.suspend) return initial;
			return ctx.suspend(() => {
				let problem: string | undefined;
				for (let i = 0; i < 3; i++) {
					const typed = readName(`${problem ? `${problem}\n` : ''}${label} [${initial}]: `).trim();
					const name = typed === '' ? initial : typed;
					problem = validate(name);
					if (!problem) return name;
				}
				throw new Error(problem);
			});
		});

	const authAdd = async (rawArgs: string[], ctx: CommandContext): Promise<void> => {
		const {name: given, rest} = takeName(rawArgs);
		if (rest.length > 0) {
			throw new Error(`Keys are not accepted as arguments: they would stay in the scrollback and history. ${ADD_USAGE}`);
		}
		const reason = degradedReason((await loadBundle(credOpts)).status);
		if (reason) throw new Error(reason);
		const value = (await promptSecret(ctx, 'API key (sk-ant-…)')).trim();
		if (value === '') {
			ctx.print('Cancelled; nothing was saved.');
			return;
		}
		let name = given;
		if (name === undefined) {
			const actx = accountsCtx(credOpts);
			name = await promptName(ctx, 'Account name', suggestSecretName(actx, value), v => newAccountNameProblem(actx, v));
			if (name === undefined) {
				ctx.print('Cancelled; nothing was saved.');
				return;
			}
		}
		const account = await storeSecret(credOpts, value, name);
		log.info('credential stored', {type: account.type});
		ctx.print(`API key stored as account "${account.name}" in the account module (account list shows it).`);
		await noteIfShadowed(account.name, ctx);
		await hub.showRetiredOnce(ctx);
	};

	const noteIfShadowed = async (name: string, ctx: CommandContext): Promise<void> => {
		const active = await resolveCredential(credOpts);
		if (active && active.account !== name) {
			ctx.print(`Note: "${name}" is used after ${describeCredential(active)} in priority order; "claude auth order ${name}" puts it first.`);
		}
	};

	const cliLoggedIn = async (): Promise<boolean> => {
		const status = await probe().catch(() => undefined);
		noteLoginStatus(credOpts, status);
		return status?.loggedIn === true;
	};

	const authLogout = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 0) throw new Error(LOGOUT_USAGE);
		if (await cliLoggedIn()) {
			const bin = cliBin();
			const ok = bin ? await logoutCli(bin, cliEnv(env, loginPaths())) : false;
			const still = await cliLoggedIn();
			log.info('claude logout', {ok, stillLoggedIn: still});
			if (still) {
				ctx.print('Warning: Claude Code still reports a login. Run "claude auth logout" in the Claude Code CLI, or remove it from the Claude Code config directory.');
			} else {
				ctx.print('Claude Code is signed out.');
				if (hub.chatOpen) ctx.print('The open chat keeps running with its credentials until you close it.');
			}
		} else {
			ctx.print('Claude Code was not signed in.');
		}
		ctx.print('Stored API keys stay; "claude auth remove <account>" removes one.');
		await printActive(ctx);
	};

	const code = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (!ctx.suspend) throw new Error('"claude code" needs an interface that can hand over the terminal');
		const bin = join(loginPaths().moduleDir, 'bin', 'claude');
		try {
			accessSync(bin, constants.X_OK);
		} catch {
			throw new Error('Claude Code wrapper not found or not executable. Run modules/claude/bin/install.');
		}
		const status = await ctx.suspend(() => runCode(bin, args, env));
		log.info('claude code finished', {args: args.length, status});
		await refreshLoginInfo(credOpts, true);
		if (status === 0) return;
		if (!ctx.headless) wait('\nClaude Code did not finish cleanly. Press Enter to return to yena. ');
		throw new Error(status === undefined ? 'Claude Code did not run to completion (it did not start or was stopped by a signal)' : `Claude Code exited with status ${status}`);
	};

	const authLogin = async (args: string[], ctx: CommandContext): Promise<void> => {
		const request = parseLoginArgs(args);
		if (!ctx.suspend) throw new Error('"claude auth login" needs an interface that can hand over the terminal');
		const bin = cliBin();
		if (!bin) throw new Error('Claude Code is not installed for this module. Run modules/claude/bin/install.');
		return authLoginBrowser(bin, request, ctx);
	};

	const authLoginBrowser = async (bin: string, request: LoginRequest, ctx: CommandContext): Promise<void> => {
		const paths = loginPaths();
		const {meta} = request;
		if (chatRunning()) throw new Error('A chat is answering; wait for it (a sign-in replaces the login Claude Code is using)');
		log.info('claude login started', {method: meta.console ? 'console' : 'claude.ai', sso: meta.sso, email: meta.email});
		const ok = await ctx.suspend!(() => {
			const done = runCli(bin, ['auth', 'login', ...request.cliArgs], cliEnv(env, paths) as NodeJS.ProcessEnv);
			if (!done) wait('\n"claude auth login" did not finish. Press Enter to return to yena. ');
			return done;
		});
		const status = await probe().catch(() => undefined);
		noteLoginStatus(credOpts, status);
		log.info('claude login finished', {
			exitOk: ok,
			loggedIn: status?.loggedIn === true,
			method: status?.method,
			subscriptionType: status?.subscriptionType,
		});
		if (!status?.loggedIn || !status.method) {
			ctx.print('Login did not complete; nothing was changed.');
			return;
		}
		ctx.print(
			`Signed in with Claude Code (${status.method === 'claude.ai' ? 'claude.ai' : 'Console'} account). yena does not store this login; Claude Code keeps it in its own config.`,
		);
		await noteIfShadowed('login', ctx);
		await hub.showNoticeOnce({kind: status.method === 'claude.ai' ? 'oauth' : 'api-key', source: 'claude-login'}, ctx);
	};

	const memory = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error('Usage: claude memory [file]');
		if (!ctx.suspend) throw new Error('"claude memory" needs an interface that can hand over the terminal');
		const paths = resolvePaths(dataDir, deps.moduleDir);
		const name = args[0] ?? 'CLAUDE.md';
		if (!/^[\w.-]+\.md$/.test(name)) throw new Error('Give a file name in the md directory, such as CLAUDE.md or SOUL.md');
		const file = join(paths.mdDir, name);
		const ok = await ctx.suspend(() => editFile(file, process.env));
		ctx.print(ok ? `Edited ${file}; new chats read it.` : `The editor did not finish; ${file} may be unchanged.`);
	};

	const auth = async (args: string[], ctx: CommandContext): Promise<void> => {
		const [sub, ...rest] = args;
		switch (sub) {
			case 'status':
				return authStatus(rest, ctx);
			case 'order':
				return authOrder(rest, ctx);
			case 'use':
				return authUse(rest, ctx);
			case 'auto':
				return authAuto(rest, ctx);
			case 'remove':
				return authRemove(rest, ctx);
			case 'add':
				return authAdd(rest, ctx);
			case 'logout':
				return authLogout(rest, ctx);
			case 'login':
				return authLogin(rest, ctx);
			case undefined:
				if (!ctx.showHelp) throw new Error(AUTH_USAGE);
				return ctx.showHelp(['auth']);
			default:
				throw new Error(AUTH_USAGE);
		}
	};

	const tierCmd = async (args: string[], ctx: CommandContext): Promise<void> => {
		if (args.length > 1) throw new Error(TIER_USAGE);
		const session = hub.openSession && hub.openSession.state !== 'closed' ? hub.openSession : undefined;
		const routerOn = (await store.read()).chatRouter === 'on';
		if (args.length === 0) {
			if (!session) {
				ctx.print('No chat is open.');
				return;
			}
			const r = session.route;
			const state = !routerOn
				? 'The model router is off.'
				: r?.pinned !== undefined
					? `Pinned to the ${r.pinned} tier.`
					: r?.rated !== undefined || r?.main !== undefined
						? `Task: ${r.rated ?? 'not rated'} · chat: ${r.main ?? 'configured model'}.`
						: 'The router has not rated a message of this chat yet.';
			ctx.print(state);
			return;
		}
		const wanted = args[0]!.toLowerCase();
		if (wanted !== 'auto' && !isTier(wanted)) {
			throw new Error(`Unknown tier "${makeScrub(s => s)(args[0]!).slice(0, 40)}"; use auto, light, standard, strong or max. ${TIER_USAGE}`);
		}
		if (!routerOn) throw new Error('The model router is off; turn it on in the Claude settings');
		if (!session || !hub.setOpenTier) throw new Error('No chat is open. Start one with "chat".');
		hub.setOpenTier(wanted);
		ctx.print(
			wanted === 'auto'
				? 'The chat follows the router again from the next message.'
				: `The chat is pinned to the ${wanted} tier until "claude tier auto" or a new chat.`,
		);
	};

	const ACCOUNT_ARG: ArgumentDoc = {name: 'account', description: 'Account name, as "claude auth status" lists it'};
	const NAME_OPTION: OptionDoc = {name: '--name', value: '<account>', description: 'Name of the new account (asked for when left out)'};

	const OWN_SUBCOMMANDS: Subcommand[] = [
		{name: 'ping', usage: 'claude ping', description: 'Check that the claude module is loaded', agent: 'confirm'},
		{
			name: 'memory',
			usage: 'claude memory [file]',
			description: 'Edit an md instruction file in your editor',
			agent: 'deny',
			args: [{name: 'file', description: 'File in the md directory (default: CLAUDE.md)'}],
		},
		{
			name: 'code',
			usage: 'claude code [args…]',
			description: 'Run the Claude Code CLI in this terminal',
			agent: 'deny',
			args: [{name: 'args', description: 'Arguments passed on to bin/claude as they are'}],
		},
		{
			name: 'tier',
			usage: 'claude tier [auto|light|standard|strong|max]',
			description: 'Pin the open chat to a model tier, or return it to the router',
			agent: 'confirm',
			args: [{name: 'auto|light|standard|strong|max', description: 'A tier to pin, or auto for the router; without it, show the current tier'}],
			notes: ['Needs the model router (Claude settings). A pin lasts until "claude tier auto" or a new chat.'],
		},
		{
			name: 'auth',
			usage: 'claude auth <subcommand>',
			description: 'Accounts in priority order; yena never switches on its own',
			args: [{name: 'subcommand', description: 'One of the subcommands below'}],
			agent: 'confirm',
			subcommands: [
				{name: 'status', usage: 'claude auth status', description: 'Show the active credential and the accounts in order', agent: 'confirm'},
				{
					name: 'login',
					usage: 'claude auth login [--console | --claudeai] [--sso] [--email <address>]',
					description: "Sign in with Claude Code's own browser login (yena stores nothing)",
					agent: 'deny',
					options: [
						{name: '--console', description: 'Sign in with an Anthropic Console account (API billing)'},
						{name: '--claudeai', description: 'Sign in with a claude.ai subscription'},
						{name: '--sso', description: 'Sign in through single sign-on'},
						{name: '--email', value: '<address>', description: 'Email address to prefill on the login page'},
					],
				},
				{
					name: 'add',
					usage: 'claude auth add [--name <account>]',
					description: 'Add an API key (typed into a hidden input)',
					agent: 'confirm',
					options: [NAME_OPTION],
				},
				{
					name: 'order',
					usage: 'claude auth order <account>…',
					description: 'Set the priority order of the accounts',
					agent: 'confirm',
					args: [{...ACCOUNT_ARG, description: 'Accounts, first one first; the ones left out follow'}],
				},
				{
					name: 'use',
					usage: 'claude auth use <account>',
					description: 'Pin an account for new turns until "claude auth auto"',
					agent: 'confirm',
					args: [ACCOUNT_ARG],
				},
				{name: 'auto', usage: 'claude auth auto', description: 'Unpin the account; new turns use the first account in the order', agent: 'confirm'},
				{name: 'remove', usage: 'claude auth remove <account>', description: 'Remove a stored API key account', agent: 'confirm', args: [ACCOUNT_ARG]},
				{name: 'logout', usage: 'claude auth logout', description: 'Sign Claude Code out (stored API keys stay)', agent: 'confirm'},
			],
		},
	];
	const claude: Command = {
		name: 'claude',
		description: 'Claude Code integration',
		usage: 'claude <subcommand> [args…]',
		agent: 'deny',
		args: [
			{name: 'subcommand', description: 'One of the subcommands below'},
			{name: 'args', description: 'Its arguments'},
		],
		subcommands: OWN_SUBCOMMANDS,
		get settings(): SettingsTab {
			return {
				title: 'Claude',
				settings: [...chatSettings(store, isModelId, log, {applyLive: patch => hub.applyOpenChat?.(patch)}), ...ruleSettings()],
			};
		},
		run: async ([sub, ...args], ctx) => {
			switch (sub) {
				case undefined:
					if (!ctx.showHelp) throw new Error('Usage: claude <ping|memory|code|tier|auth|help>');
					return ctx.showHelp();
				case 'ping':
					ctx.print('pong');
					return;
				case 'memory':
					return memory(args, ctx);
				case 'code':
					return code(args, ctx);
				case 'tier':
					return tierCmd(args, ctx);
				case 'auth':
					return auth(args, ctx);
				default:
					throw new Error(unknownSubcommand(sub));
			}
		},
	};

	return {commands: [claude], provider};
};
