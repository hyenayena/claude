import {randomUUID} from 'node:crypto';
import type {z as Zod} from 'zod';
import type {createSdkMcpServer, tool} from '@anthropic-ai/claude-agent-sdk';
import type {CommandBridge, Logger} from '../../../../src/api.js';
import {COMMAND_TOOLS, formatCommandList, formatRunResult} from '../kit.js';
import {errClass} from '../log.js';
import type {PermissionPrompter} from './permission.js';
import {makeScrub} from './scrub.js';

export const CONSOLE_SERVER_NAME = 'yena';
export const LIST_COMMANDS_TOOL = `mcp__${CONSOLE_SERVER_NAME}__list_commands`;
export const RUN_COMMAND_TOOL = `mcp__${CONSOLE_SERVER_NAME}__run_command`;
export const CONSOLE_TOOL_NAMES: readonly string[] = [LIST_COMMANDS_TOOL, RUN_COMMAND_TOOL];

// The SDK and zod are loaded lazily by the caller, so this file stays free of runtime imports of either.
export type ConsoleSdk = {
	createSdkMcpServer: typeof createSdkMcpServer;
	tool: typeof tool;
	z: typeof Zod;
};

export type ConsoleServerDeps = {
	bridge: CommandBridge;
	sdk: ConsoleSdk;
	prompter: PermissionPrompter;
	redact: (s: string) => string;
	// Working directory shown in the confirmation prompt.
	cwd: string;
	log: Logger;
	// Pauses the chat turn timeout while a command runs; returns the release.
	holdTurn?: () => () => void;
};

// Core's maximum; the bridge answers with a formatted timeout before the MCP call limit below.
export const CONSOLE_TIMEOUT_MS = 600_000;
export const CONSOLE_MCP_TIMEOUT_MS = 610_000;

type ToolResult = {content: {type: 'text'; text: string}[]; isError?: boolean};

let seq = 0;

const signalOf = (extra: unknown): AbortSignal | undefined => {
	const s = typeof extra === 'object' && extra !== null ? (extra as {signal?: unknown}).signal : undefined;
	return s instanceof AbortSignal ? s : undefined;
};


export function createConsoleServer(deps: ConsoleServerDeps): ReturnType<typeof createSdkMcpServer> {
	const {bridge, sdk, prompter, redact, log, cwd} = deps;
	const {z} = sdk;
	const scrub = makeScrub(redact);
	const text = (s: string, isError: boolean): ToolResult => ({
		content: [{type: 'text', text: scrub(s)}],
		...(isError && {isError: true}),
	});

	const confirmWith =
		(signal: AbortSignal | undefined) =>
		async (req: {line: string}): Promise<boolean> => {
			try {
				const d = await prompter.request(
					{
						kind: 'tool',
						id: randomUUID(),
						seq: ++seq,
						toolName: 'Command',
						input: {command: req.line},
						cwd,
						highlights: [],
						defaultToNo: false,
						always: false,
						oversize: false,
					},
					signal ?? new AbortController().signal,
				);
				return d.kind === 'allow';
			} catch {
				return false;
			}
		};

	const listTool = sdk.tool(
		'list_commands',
		COMMAND_TOOLS.list_commands.description,
		{},
		async (): Promise<ToolResult> => {
			const started = Date.now();
			try {
				const out = text(formatCommandList(bridge.list()), false);
				log.info('console tool', {tool: 'list_commands', status: 'ok', ms: Date.now() - started});
				return out;
			} catch (err) {
				log.warn('console tool failed', {tool: 'list_commands', err});
				return text('Could not list the console commands.', true);
			}
		},
		{annotations: {readOnlyHint: true}},
	);

	const runTool = sdk.tool(
		'run_command',
		COMMAND_TOOLS.run_command.description,
		{command: z.string()},
		async (args, extra): Promise<ToolResult> => {
			const started = Date.now();
			const line = typeof args.command === 'string' ? args.command.trim() : '';
			if (line === '' || line.includes('\0')) {
				return text('The command is empty or invalid.', true);
			}
			const signal = signalOf(extra);
			let release: (() => void) | undefined;
			try {
				release = deps.holdTurn?.();
				const result = await bridge.run({
					line,
					caller: 'claude',
					confirm: confirmWith(signal),
					timeoutMs: CONSOLE_TIMEOUT_MS,
					...(signal && {signal}),
				});
				log.info('console tool', {tool: 'run_command', status: result.status, ms: Date.now() - started});
				return text(formatRunResult(result), result.status !== 'ok');
			} catch (err) {
				log.warn('console tool failed', {tool: 'run_command', err: errClass(err)});
				return text('The console command failed to run.', true);
			} finally {
				release?.();
			}
		},
		{annotations: {destructiveHint: true}},
	);

	return sdk.createSdkMcpServer({name: CONSOLE_SERVER_NAME, version: '1.0.0', tools: [listTool, runTool], timeout: CONSOLE_MCP_TIMEOUT_MS});
}
