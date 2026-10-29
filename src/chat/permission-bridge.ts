import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import type {CanUseTool, PermissionResult} from '@anthropic-ai/claude-agent-sdk';
import {classifyEditTarget, createCanUseTool, type Scope} from '../policy.js';
import {agentDenial} from './agent-policy.js';
import {type ConsoleFlags, LIST_COMMANDS_TOOL, RUN_COMMAND_TOOL} from './console-tools.js';
import {
	BASH_REVIEW_MAX,
	CANCEL_MESSAGE,
	DENY_MESSAGE,
	DENY_REASON_PREFIX,
	DISMISS_MESSAGE,
	type Highlight,
	PAYLOAD_REVIEW_MAX,
	POLICY_DENY,
	type PermissionDecision,
	type PermissionPrompter,
	type PermissionRequest,
	type Preview,
	QUESTION_LIMITS,
	type QuestionSpec,
	REASON_MAX,
	toolUnavailableMessage,
} from './permission.js';
import {sanitizeBlock, sanitizeText} from '../kit.js';
import {WEB_KEY_PREFIX, webKey} from './policy-hook.js';

export type PermissionBridgeDeps = {
	scope: Scope;
	projectDir: string;
	mdDir: string;
	prompter: PermissionPrompter;
	consoleFlags?: ConsoleFlags;
	preview?: (toolName: 'Edit' | 'Write', input: Record<string, unknown>, scope: Scope) => Promise<Preview | undefined>;
	highlights?: (command: string) => Highlight[];
	previewTimeoutMs?: number;
};

type Opts = Parameters<CanUseTool>[2];
type Extras = {decisionReasonType?: unknown; requiresUserInteraction?: unknown};

const PREVIEW_TIMEOUT_MS = 1500;
export const PLAN_ACCEPT_EDITS_LABEL = 'Yes, and accept edits';
export const MCP_TOOL_FIELD = '__mcpTool';
const ALWAYS_COMMAND_MAX = 2000;
const ALWAYS_LABEL = 'Always allow this exact command in this chat';

const deny = (message: string, toolUseID?: string): PermissionResult => ({
	behavior: 'deny',
	message,
	...(toolUseID !== undefined && {toolUseID}),
});

const cleanReason = (s: string): string =>
	sanitizeBlock(s).replace(/\s+/g, ' ').trim().slice(0, REASON_MAX);

const countLines = (s: string): number => {
	if (s === '') return 0;
	const n = s.split('\n').length;
	return s.endsWith('\n') ? n - 1 : n;
};

async function resolveTarget(p: string): Promise<string> {
	const tail: string[] = [];
	let cur = p;
	for (;;) {
		try {
			return path.join(await realpath(cur), ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return p;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const sleepFor = (ms: number): {promise: Promise<undefined>; cancel: () => void} => {
	let timer: NodeJS.Timeout | undefined;
	const promise = new Promise<undefined>(resolve => {
		timer = setTimeout(() => resolve(undefined), ms);
		timer.unref();
	});
	return {promise, cancel: () => clearTimeout(timer)};
};

function parseQuestions(input: Record<string, unknown>): QuestionSpec[] | undefined {
	const L = QUESTION_LIMITS;
	const raw = input.questions;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > L.questions) return undefined;
	const seen = new Set<string>();
	const out: QuestionSpec[] = [];
	for (const q of raw as unknown[]) {
		if (!isRecord(q)) return undefined;
		const {question, header, options, multiSelect} = q;
		if (typeof question !== 'string' || question === '' || question.length > L.question) return undefined;
		if (typeof header !== 'string' || header.length > L.header) return undefined;
		if (multiSelect !== undefined && typeof multiSelect !== 'boolean') return undefined;
		if (seen.has(question)) return undefined;
		seen.add(question);
		if (!Array.isArray(options) || options.length < 2 || options.length > L.options) return undefined;
		const opts: QuestionSpec['options'] = [];
		for (const o of options as unknown[]) {
			if (!isRecord(o)) return undefined;
			const {label, description} = o;
			if (typeof label !== 'string' || label === '' || label.length > L.label) return undefined;
			if (description !== undefined && (typeof description !== 'string' || description.length > L.description)) {
				return undefined;
			}
			opts.push({label, description: description ?? ''});
		}
		out.push({question, header, multiSelect: multiSelect === true, options: opts});
	}
	return out;
}

export function createChatCanUseTool(deps: PermissionBridgeDeps): CanUseTool {
	const {scope, projectDir, prompter} = deps;
	const readTool = createCanUseTool(scope);
	const previewTimeout = deps.previewTimeoutMs ?? PREVIEW_TIMEOUT_MS;
	let seq = 0;

	const policyDeny = (toolName: string, message: string, summary: string, id?: string): PermissionResult => {
		prompter.audit({outcome: 'denied-by-policy', toolName, summary});
		return deny(message, id);
	};

	const ask = async (req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision> => {
		try {
			return await prompter.request(req, signal);
		} catch {
			return {kind: 'cancel', cause: 'aborted'};
		}
	};

	const denyFor = (d: PermissionDecision, id: string): PermissionResult => {
		if (d.kind === 'deny') {
			const reason = d.reason === undefined ? '' : cleanReason(d.reason);
			return deny(reason === '' ? DENY_MESSAGE : `${DENY_MESSAGE} ${DENY_REASON_PREFIX}${reason}`, id);
		}
		return deny(CANCEL_MESSAGE, id);
	};

	const buildPreview = async (
		toolName: 'Edit' | 'Write',
		input: Record<string, unknown>,
	): Promise<Preview | undefined> => {
		if (!deps.preview) return undefined;
		const timer = sleepFor(previewTimeout);
		try {
			return await Promise.race([deps.preview(toolName, input, scope).catch(() => undefined), timer.promise]);
		} catch {
			return undefined;
		} finally {
			timer.cancel();
		}
	};

	const base = (opts: Opts) => {
		const extras = opts as Opts & Extras;
		const reasonType = typeof extras.decisionReasonType === 'string' ? extras.decisionReasonType : undefined;
		return {
			id: opts.toolUseID,
			reasonType,
			defaultToNo: opts.defaultToNo === true,
			interaction: extras.requiresUserInteraction === true,
			cliNote:
				typeof opts.decisionReason === 'string' && opts.decisionReason !== ''
					? {text: opts.decisionReason, ...(reasonType !== undefined && {type: reasonType})}
					: undefined,
			description: typeof opts.description === 'string' ? opts.description : undefined,
		};
	};

	const handleQuestion = async (input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		const id = opts.toolUseID;
		const questions = parseQuestions(input);
		if (!questions) return policyDeny('AskUserQuestion', POLICY_DENY.invalidInput, 'invalid question', id);
		const d = await ask({kind: 'question', id: randomUUID(), seq: ++seq, questions}, opts.signal);
		if (d.kind !== 'answers') return deny(d.kind === 'deny' ? DISMISS_MESSAGE : CANCEL_MESSAGE, id);
		const entries: Array<[string, string]> = [];
		for (const q of questions) {
			const raw = Object.hasOwn(d.answers, q.question) ? d.answers[q.question] : undefined;
			const value = typeof raw === 'string' ? sanitizeBlock(raw).slice(0, QUESTION_LIMITS.freeText) : '';
			if (value.trim() === '') return deny(DISMISS_MESSAGE, id);
			entries.push([q.question, value]);
		}
		return {
			behavior: 'allow',
			updatedInput: {...input, answers: Object.fromEntries(entries)},
			toolUseID: id,
		};
	};

	const handleBash = async (input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		const b = base(opts);
		const {command} = input;
		if (
			typeof command !== 'string' ||
			command.trim() === '' ||
			command.includes('\0') ||
			(input.description !== undefined && typeof input.description !== 'string')
		) {
			return policyDeny('Bash', POLICY_DENY.invalidInput, 'invalid input', b.id);
		}
		if (input.dangerouslyDisableSandbox) {
			return policyDeny('Bash', POLICY_DENY.background, 'sandbox override', b.id);
		}
		const highlights = deps.highlights ? deps.highlights(command) : [];
		const warn = highlights.some(h => h.level === 'warn');
		const flagged = b.defaultToNo || b.reasonType === 'safetyCheck' || b.reasonType === 'rule' || b.interaction || warn;
		if (!flagged && prompter.hasApproved(command)) {
			prompter.audit({outcome: 'always-allowed', toolName: 'Bash', summary: command});
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		const rulable = (opts.suggestions ?? []).some(
			s => s.type === 'addRules' && s.rules.some(r => r.toolName === 'Bash'),
		);
		const alwaysOk =
			rulable &&
			opts.suppressAlwaysAllowRule !== true &&
			!b.defaultToNo &&
			b.reasonType !== 'safetyCheck' &&
			!warn &&
			command.length <= ALWAYS_COMMAND_MAX &&
			!command.includes('\n') &&
			!command.includes('*');
		const d = await ask(
			{
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName: 'Bash',
				input,
				cwd: projectDir,
				...(b.description !== undefined && {description: b.description}),
				...(b.cliNote && {cliNote: b.cliNote}),
				highlights,
				defaultToNo: b.defaultToNo,
				always: alwaysOk ? {label: ALWAYS_LABEL} : false,
				oversize: command.length > BASH_REVIEW_MAX,
			},
			opts.signal,
		);
		if (d.kind === 'allow') {
			if (d.always === true && alwaysOk) prompter.remember(command);
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		return denyFor(d, b.id);
	};

	const handleEdit = async (
		toolName: 'Edit' | 'Write',
		input: Record<string, unknown>,
		opts: Opts,
	): Promise<PermissionResult> => {
		const b = base(opts);
		const {file_path: filePath} = input;
		const strings = toolName === 'Edit' ? ['old_string', 'new_string'] : ['content'];
		if (
			typeof filePath !== 'string' ||
			filePath === '' ||
			strings.some(k => typeof input[k] !== 'string') ||
			(input.replace_all !== undefined && typeof input.replace_all !== 'boolean')
		) {
			return policyDeny(toolName, POLICY_DENY.invalidInput, 'invalid input', b.id);
		}
		const cls = await classifyEditTarget(filePath, scope);
		const lexical = path.resolve(projectDir, filePath);
		const resolved = await resolveTarget(lexical);
		const resolvedPath = resolved === lexical ? undefined : resolved;
		const summaryPath = resolvedPath === undefined ? lexical : `${lexical} -> ${resolvedPath}`;
		if (cls === 'deny-outside') return policyDeny(toolName, POLICY_DENY.outside, summaryPath, b.id);
		if (cls === 'deny-locked') return policyDeny(toolName, POLICY_DENY.locked, summaryPath, b.id);
		if (cls === 'deny-readonly') return policyDeny(toolName, POLICY_DENY.readonly, summaryPath, b.id);
		if (cls === 'deny-image') return policyDeny(toolName, POLICY_DENY.image, summaryPath, b.id);
		if (cls === 'deny-guard') return policyDeny(toolName, POLICY_DENY.guard, summaryPath, b.id);
		if (cls === 'deny-secret') return policyDeny(toolName, POLICY_DENY.secret, summaryPath, b.id);

		const added = countLines(String(input.new_string ?? input.content));
		const removed = toolName === 'Edit' ? countLines(String(input.old_string)) : 0;
		const autoEdit =
			cls === 'free' || (prompter.mode === 'acceptEdits' && cls === 'auto-eligible' && b.reasonType === undefined);
		if (autoEdit && !b.defaultToNo && !b.interaction) {
			prompter.audit({
				outcome: 'auto-accepted',
				toolName,
				summary: `${summaryPath} (+${added} -${removed})`,
			});
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		const size = strings.reduce((n, k) => n + (input[k] as string).length, 0);
		const oversize = size > PAYLOAD_REVIEW_MAX;
		const preview = oversize ? undefined : await buildPreview(toolName, input);
		const d = await ask(
			{
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName,
				input,
				cwd: projectDir,
				path: lexical,
				...(resolvedPath !== undefined && {resolvedPath}),
				...(b.description !== undefined && {description: b.description}),
				...(b.cliNote && {cliNote: b.cliNote}),
				...(preview && {preview}),
				highlights: [],
				defaultToNo: b.defaultToNo,
				always: false,
				oversize,
			},
			opts.signal,
		);
		if (d.kind === 'allow') return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		return denyFor(d, b.id);
	};

	const handleWebFetch = async (input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		const b = base(opts);
		const {url} = input;
		const key = webKey(url);
		if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 4096 || url.includes('\0') || key === undefined) {
			return policyDeny('WebFetch', POLICY_DENY.invalidInput, 'invalid input', b.id);
		}
		if (!b.defaultToNo && prompter.hasApproved(key)) {
			prompter.audit({outcome: 'always-allowed', toolName: 'WebFetch', summary: key});
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		const host = key.slice(WEB_KEY_PREFIX.length);
		const d = await ask(
			{
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName: 'WebFetch',
				input,
				cwd: projectDir,
				...(b.description !== undefined && {description: b.description}),
				...(b.cliNote && {cliNote: b.cliNote}),
				highlights: [],
				defaultToNo: b.defaultToNo,
				always: b.defaultToNo ? false : {label: `Yes, always for ${sanitizeText(host, 253)}`},
				oversize: false,
			},
			opts.signal,
		);
		if (d.kind === 'allow') {
			if (d.always === true && !b.defaultToNo) prompter.remember(key);
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		return denyFor(d, b.id);
	};

	const handleMcp = async (toolName: string, input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		const b = base(opts);
		const key = `mcp:${toolName}`;
		if (!b.defaultToNo && prompter.hasApproved(key)) {
			prompter.audit({outcome: 'always-allowed', toolName, summary: toolName});
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		const d = await ask(
			{
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName: 'Mcp',
				input: {...input, [MCP_TOOL_FIELD]: toolName},
				cwd: projectDir,
				...(b.description !== undefined && {description: b.description}),
				highlights: [],
				defaultToNo: b.defaultToNo,
				always: b.defaultToNo ? false : {label: 'Yes, always for this tool'},
				oversize: JSON.stringify(input).length > PAYLOAD_REVIEW_MAX,
			},
			opts.signal,
		);
		if (d.kind === 'allow') {
			if (d.always === true) prompter.remember(key);
			return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
		}
		return denyFor(d, b.id);
	};

	const handlePlanExit = async (input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		const b = base(opts);
		const d = await ask(
			{
				kind: 'tool',
				id: randomUUID(),
				seq: ++seq,
				toolName: 'ExitPlanMode',
				input,
				cwd: projectDir,
				highlights: [],
				defaultToNo: false,
				always: {label: PLAN_ACCEPT_EDITS_LABEL},
				oversize: false,
			},
			opts.signal,
		);
		if (d.kind !== 'allow') return denyFor(d, b.id);
		prompter.setMode?.(d.always === true ? 'acceptEdits' : 'default');
		return {behavior: 'allow', updatedInput: input, toolUseID: b.id};
	};

	const dispatch = async (toolName: string, input: Record<string, unknown>, opts: Opts): Promise<PermissionResult> => {
		switch (toolName) {
			case 'Read':
			case 'Glob':
			case 'Grep': {
				const r = await readTool(toolName, input, opts);
				if (r?.behavior === 'allow') return r;
				prompter.audit({outcome: 'denied-by-policy', toolName, summary: 'outside scope'});
				return r ?? deny(POLICY_DENY.outside, opts.toolUseID);
			}
			case 'TaskStop':
			case 'TaskGet':
			case 'TaskList':
			case 'TaskOutput':
			case 'BashOutput':
			case 'KillShell':
			case 'Skill':
			case 'TodoWrite':
			case 'WebSearch':
				return {behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID};
			case 'WebFetch':
				return handleWebFetch(input, opts);
			case 'ExitPlanMode':
				return handlePlanExit(input, opts);
			case 'Agent':
			case 'Task':
			case 'SendMessage': {
				const denial = agentDenial(toolName, input);
				if (denial) return policyDeny(toolName, denial, 'agent option not allowed', opts.toolUseID);
				return {behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID};
			}
			case 'AskUserQuestion':
				return handleQuestion(input, opts);
			case 'Bash':
				return handleBash(input, opts);
			case 'Edit':
			case 'Write':
				return handleEdit(toolName, input, opts);
			case RUN_COMMAND_TOOL:
				if (prompter.mode === 'auto' && typeof input.command === 'string') {
					deps.consoleFlags?.flag(input.command.trim());
				}
				return {behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID};
			case LIST_COMMANDS_TOOL:
				return {behavior: 'allow', updatedInput: input, toolUseID: opts.toolUseID};
			default:
				if (toolName.startsWith('mcp__')) return handleMcp(toolName, input, opts);
				return policyDeny(toolName, toolUnavailableMessage(toolName), 'unknown tool', opts.toolUseID);
		}
	};

	return async (toolName, input, opts) => {
		const id = opts?.toolUseID;
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<PermissionResult>(resolve => {
			if (!opts?.signal) return;
			onAbort = () => resolve(deny(CANCEL_MESSAGE, id));
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener('abort', onAbort, {once: true});
		});
		try {
			if (!isRecord(input)) return deny(POLICY_DENY.invalidInput, id);
			return await Promise.race([dispatch(toolName, input, opts), aborted]);
		} catch {
			return deny('Permission handling failed', id);
		} finally {
			if (onAbort) opts.signal.removeEventListener('abort', onAbort);
		}
	};
}
