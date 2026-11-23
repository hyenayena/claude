import type {HookCallback, HookCallbackMatcher, HookEvent, HookJSONOutput} from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import {classifyEditTarget, createCanUseTool, globBase, inSharedTmp, PLANS_DIR, resolveReal, rulesFor, type Scope} from '../policy.js';
import {entriesInside, INDEX_MAX_AGE_MS, rulesLists} from '../deps/rules.js';
import {agentDenial} from './agent-policy.js';
import {addsPrivilegedFrontmatter, isDefinitionPath} from './definition-guard.js';
import type {ProfileGuard} from './profile-guard.js';
import {analyzeBash, bashRulesVerdict} from './bash-paths.js';
import {POLICY_ASK, POLICY_DENY, rulesDenied, scratchDenied} from './permission.js';

const AUTH_FILE = /credentials\.json|\.claude\.json|config\/backups|accounts\.json|claude\/accounts\b|claude\/auth\.json/;

const AGENT_VAR = /\bSSH_AUTH_SOCK\b|\bssh-add\b/;
const usesAgent = (command: string, socket: string | undefined): boolean =>
	AGENT_VAR.test(command) || (socket !== undefined && socket !== '' && (command.includes(socket) || command.includes(path.dirname(socket) + '/')));

const PROC_ENV = /\benviron\b/;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A readable dir counts only as a whole path segment and never with "..": the sandbox enforces the rest.
function touchesHostState(command: string, scope: Scope, sandboxed: boolean): boolean {
	let rest = command;
	if (sandboxed) {
		for (const dir of scope.hostStateReadable ?? []) rest = rest.replace(new RegExp(`${escapeRe(dir)}(?![\\w.-])`, 'g'), '');
		if (rest !== command && command.includes('..')) return true;
	}
	return (scope.hostStateDenied ?? []).some(s => rest.includes(s));
}

export async function outsideReason(scope: Scope, target: unknown): Promise<string> {
	if (scope.scratch !== undefined && typeof target === 'string' && (await inSharedTmp(target, scope))) {
		return scratchDenied(scope.scratch);
	}
	return POLICY_DENY.outside;
}

export type ReadRules = {deny?: string; ask?: boolean};

// What the rules files say about a Read, Glob or Grep call, whether or not the root checks let it through.
export async function readRules(scope: Scope, tool: string, args: Record<string, unknown>): Promise<ReadRules> {
	const cwd = scope.roots[0] ?? '/';
	const target = tool === 'Read' ? args.file_path : (args.path ?? cwd);
	if (typeof target !== 'string') return {};
	const own = await rulesFor(target, scope);
	if (own?.read === 'deny') return {deny: rulesDenied(own, 'read')};
	const pattern = tool === 'Glob' ? args.pattern : tool === 'Grep' ? args.glob : undefined;
	if (typeof pattern === 'string' && (pattern.startsWith('/') || pattern.startsWith('~'))) {
		const base = globBase(pattern, path.resolve(cwd, target));
		const verdict = base === undefined ? undefined : await rulesFor(base, scope);
		if (verdict?.read === 'deny') return {deny: rulesDenied(verdict, 'read')};
	}
	if (tool === 'Glob') return {};
	if (own?.read === 'ask') return {ask: true};
	if (tool !== 'Grep') return {};
	const real = await resolveReal(path.resolve(cwd, target)).catch(() => undefined);
	if (real === undefined) return {};
	const expansion = await rulesLists(scope, {maxAgeMs: INDEX_MAX_AGE_MS});
	return entriesInside(expansion.askRead, real).length > 0 ? {ask: true} : {};
}

export async function deniedReason(scope: Scope, tool: string, args: Record<string, unknown>): Promise<string | undefined> {
	return (await readRules(scope, tool, args)).deny;
}

const allow: HookJSONOutput = {continue: true};

const denyWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason},
});

const askWith = (reason: string): HookJSONOutput => ({
	hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason},
});

export const WEB_KEY_PREFIX = 'web:';
export function webKey(url: unknown): string | undefined {
	if (typeof url !== 'string') return undefined;
	try {
		const u = new URL(url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
		return u.hostname === '' ? undefined : `${WEB_KEY_PREFIX}${u.hostname.toLowerCase()}`;
	} catch {
		return undefined;
	}
}

export type PolicyHookOptions = {
	beforeBash?: () => Promise<void>;
	procHidden?: boolean;
	sandboxed?: boolean;
	bashTracker?: {begin(id: string): void; end(id: string, cwd?: string): Promise<void>};
	agentRoute?: (input: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
	profile?: ProfileGuard;
};

export function createPolicyHook(scope: Scope, configDir?: string, hookOpts: PolicyHookOptions = {}): HookCallback {
	const config = configDir ? path.resolve(configDir) : undefined;
	const plans = config ? path.join(config, PLANS_DIR) : undefined;
	const inside = (p: string, dir: string) => p === dir || p.startsWith(dir + path.sep);
	const readTool = createCanUseTool(scope);
	const projectData = scope.projectDataDir ? path.resolve(scope.projectDataDir) : undefined;
	const opts = {signal: new AbortController().signal, toolUseID: 'policy-hook'} as Parameters<typeof readTool>[2];
	return async input => {
		if (input.hook_event_name !== 'PreToolUse') return allow;
		const tool = input.tool_name;
		const args = (input.tool_input ?? {}) as Record<string, unknown>;
		if (hookOpts.profile) {
			const verdict = hookOpts.profile.preToolUse(tool, args, input.agent_id);
			if (verdict.kind === 'deny') return denyWith(verdict.reason);
			if (verdict.kind === 'rewrite') {
				return {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: verdict.input}};
			}
		}
		switch (tool) {
			case 'Read':
			case 'Glob':
			case 'Grep': {
				const r = await readTool(tool, args, opts);
				const rules = await readRules(scope, tool, args);
				if (r?.behavior !== 'allow') return denyWith(rules.deny ?? (await outsideReason(scope, tool === 'Read' ? args.file_path : args.path)));
				if (rules.deny !== undefined) return denyWith(rules.deny);
				return rules.ask ? askWith(POLICY_ASK.rulesRead) : allow;
			}
			case 'Edit':
			case 'Write': {
				if (typeof args.file_path !== 'string') return denyWith(POLICY_DENY.invalidInput);
				const cls = await classifyEditTarget(args.file_path, scope);
				if (cls === 'deny-outside') return denyWith(await outsideReason(scope, args.file_path));
				if (cls === 'deny-locked') return denyWith(POLICY_DENY.locked);
				if (cls === 'deny-readonly') return denyWith(POLICY_DENY.readonly);
				if (cls === 'deny-image') return denyWith(POLICY_DENY.image);
				if (cls === 'deny-rules') return denyWith(rulesDenied(await rulesFor(args.file_path, scope), 'write'));
				if (config && plans) {
					const target = await resolveReal(path.resolve(scope.roots[0] ?? '/', args.file_path)).catch(() => undefined);
					const realConfig = await resolveReal(config).catch(() => config);
					if (target === undefined) return denyWith(POLICY_DENY.outside);
					if (inside(target, realConfig) && !inside(target, path.join(realConfig, PLANS_DIR))) return denyWith(POLICY_DENY.guard);
				}
				if (cls === 'deny-guard') return denyWith(POLICY_DENY.guard);
				if (cls === 'deny-secret') return denyWith(POLICY_DENY.secret);
				const lexical = path.resolve(scope.roots[0] ?? '/', args.file_path);
				const real = await resolveReal(lexical).catch(() => lexical);
				const hubs = await Promise.all((scope.free ?? []).map(d => resolveReal(d).catch(() => path.resolve(d))));
				if (
					(isDefinitionPath(real, hubs) || isDefinitionPath(lexical, hubs)) &&
					(await addsPrivilegedFrontmatter(real, tool, args))
				) {
					return denyWith(POLICY_DENY.privileged);
				}
				return cls === 'ask-rules' ? askWith(POLICY_ASK.rulesWrite) : allow;
			}
			case 'WebFetch': {
				return webKey(args.url) === undefined ? denyWith(POLICY_DENY.invalidInput) : allow;
			}
			case 'Bash': {
				if (args.dangerouslyDisableSandbox) return denyWith(POLICY_DENY.background);
				const command = args.command;
				if (typeof command !== 'string') {
					hookOpts.bashTracker?.begin(input.tool_use_id);
					return allow;
				}
				if (AUTH_FILE.test(command)) return denyWith(POLICY_DENY.authFiles);
				if (scope.shellDenied?.some(s => command.includes(s))) return denyWith(POLICY_DENY.accountSecrets);
				if (touchesHostState(command, scope, hookOpts.sandboxed === true)) return denyWith(POLICY_DENY.hostState);
				if (!hookOpts.procHidden && PROC_ENV.test(command)) return denyWith(POLICY_DENY.procEnv);
				if (usesAgent(command, scope.agentSocket)) return denyWith(POLICY_DENY.sshAgent);
				if (projectData && command.includes(projectData)) return denyWith(POLICY_DENY.projectState);
				const rules = await bashRulesVerdict(analyzeBash(command, typeof input.cwd === 'string' ? input.cwd : (scope.roots[0] ?? '/')), scope);
				if (rules.decision === 'deny') return denyWith(rules.askWrite ? POLICY_DENY.rulesBashAsk : POLICY_DENY.rulesBash);
				if (hookOpts.beforeBash) {
					try {
						await hookOpts.beforeBash();
					} catch {
						return denyWith(POLICY_DENY.sandbox);
					}
				}
				hookOpts.bashTracker?.begin(input.tool_use_id);
				return rules.decision === 'ask' ? askWith(POLICY_ASK.rulesBash) : allow;
			}
			case 'Agent':
			case 'Task': {
				const denial = agentDenial(tool, args);
				if (denial) return denyWith(denial);
				const updatedInput = await hookOpts.agentRoute?.(args).catch(() => undefined);
				return updatedInput
					? {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput}}
					: allow;
			}
			default: {
				const denial = agentDenial(tool, args);
				return denial ? denyWith(denial) : allow;
			}
		}
	};
}

export function policyHooks(
	scope: Scope,
	configDir?: string,
	hookOpts: PolicyHookOptions = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
		PreToolUse: [{hooks: [createPolicyHook(scope, configDir, hookOpts)]}],
	};
	const tracker = hookOpts.bashTracker;
	if (!tracker) return hooks;
	const after: HookCallback = async input => {
		if ('tool_name' in input && input.tool_name === 'Bash' && 'tool_use_id' in input) await tracker.end(input.tool_use_id, input.cwd);
		return allow;
	};
	for (const event of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'] as const) {
		hooks[event] = [{matcher: 'Bash', hooks: [after]}];
	}
	return hooks;
}
