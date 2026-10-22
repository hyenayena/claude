import type {Logger, ModulePlugin} from '../../../src/api.js';
import {createClaudeCommands} from './commands.js';
import type {ChatUi} from './chat/command.js';
import type {ConsoleSdk} from './chat/console-tools.js';
import {noopLog} from './log.js';
import type {ChatQueryFn, QueryFn} from './types.js';

const active = new Set<AbortController>();
let exitHookInstalled = false;

let exitLog: Logger = noopLog;

const abortAll = (): void => {
	if (active.size > 0) exitLog.warn('exit hook aborting requests', {count: active.size});
	for (const c of active) c.abort();
};

const registerAbort = (controller: AbortController): (() => void) => {
	active.add(controller);
	if (!exitHookInstalled) {
		exitHookInstalled = true;
		process.once('exit', abortAll);
	}
	return () => {
		active.delete(controller);
	};
};

// Lazy import: a missing SDK must not break plugin load or `ping`.
const loadQuery = async (): Promise<QueryFn> => {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as QueryFn;
};

const loadChatQuery = async (): Promise<ChatQueryFn> => {
	const sdk = await import('@anthropic-ai/claude-agent-sdk');
	return sdk.query as unknown as ChatQueryFn;
};

const loadConsoleSdk = async (): Promise<ConsoleSdk> => {
	const [sdk, {z}] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]);
	return {createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z};
};

// Lazy import: ping and ask must never load React or Ink.
const loadUi = (): Promise<ChatUi> => import('./ui/mount.js');

const plugin: ModulePlugin = host => {
	const log = host.log ?? noopLog;
	exitLog = log;
	log.info('plugin loaded');
	return [
		...createClaudeCommands({dataDir: host.dataDir, env: process.env, log, loadQuery, loadChatQuery, loadConsoleSdk, loadUi, registerAbort}),
	];
};

export default plugin;
