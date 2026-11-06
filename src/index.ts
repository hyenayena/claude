import type {Logger, ModulePlugin} from '../../../src/api.js';
import {createClaude} from './commands.js';
import {registerChatProvider} from './deps/chat.js';
import type {ChatUi} from './chat/command.js';
import type {ConsoleSdk} from './chat/console-tools.js';
import {ensureSessionDir} from './chat/shell-tmp.js';
import {noopLog} from './log.js';
import {spawnRunner} from './runner/spawn.js';
import type {ChatQueryFn, QueryFn} from './types.js';
import {hostVault} from './vault.js';

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

const loadUi = (): Promise<ChatUi> => import('./deps/chat-ui.js');

let unregisterProvider: (() => void) | undefined;

// For a reload of the module, and for tests: only the registration made here is removed.
export const releaseProvider = (): void => {
	unregisterProvider?.();
	unregisterProvider = undefined;
};

const plugin: ModulePlugin = host => {
	const log = host.log ?? noopLog;
	exitLog = log;
	log.info('plugin loaded');
	const vault = hostVault(host.credentials, log);
	const redactExtra = log.redact?.bind(log);
	const {commands, provider} = createClaude({dataDir: host.dataDir, env: process.env, log, vault, ...(redactExtra && {redactExtra}),...(host.build && {build: host.build}), ...(host.devFailure && {devFailure: host.devFailure}), loadQuery, loadChatQuery, loadConsoleSdk, loadUi, registerAbort, spawnRunner, sessionDir: () => ensureSessionDir()});
	const off = registerChatProvider(provider);
	if (off) unregisterProvider = off;
	else log.warn('chat provider not registered');
	return commands;
};

export default plugin;
