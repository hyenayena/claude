import type {Logger, ModulePlugin} from '../../../src/api.js';
import {createClaudeCommands} from './commands.js';
import * as kit from './kit.js';
import {chatGallerySection, diffGallerySection, planGallerySection, statusGallerySection, toolsGallerySection} from './ui/gallery.js';
import {markdownGallerySection} from './ui/markdown-gallery.js';
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

const loadUi = (): Promise<ChatUi> => import('./ui/mount.js');

// The gallery is optional: an older core has no registry, and a failure here must not stop the plugin.
function registerGallery(log: Logger): void {
	try {
		if (typeof kit.registerGallerySection !== 'function') {
			log.warn('gallery section skipped');
			return;
		}
		for (const section of [chatGallerySection, diffGallerySection, toolsGallerySection, statusGallerySection, planGallerySection, markdownGallerySection]) {
			if (!kit.registerGallerySection(section)) log.warn('gallery section skipped', {section: section.name});
		}
	} catch (err) {
		log.warn('gallery section skipped', {err});
	}
}

const plugin: ModulePlugin = host => {
	const log = host.log ?? noopLog;
	exitLog = log;
	log.info('plugin loaded');
	registerGallery(log);
	const vault = hostVault(host.credentials, log);
	const redactExtra = log.redact?.bind(log);
	return [
		...createClaudeCommands({dataDir: host.dataDir, env: process.env, log, vault, ...(redactExtra && {redactExtra}),...(host.build && {build: host.build}), ...(host.devFailure && {devFailure: host.devFailure}), loadQuery, loadChatQuery, loadConsoleSdk, loadUi, registerAbort, spawnRunner, sessionDir: () => ensureSessionDir()}),
	];
};

export default plugin;
