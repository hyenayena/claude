import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';
import type {Effort} from './chat-prefs.js';
import type {TierModel} from './chat/tiers.js';

export type CredentialKind = 'api-key' | 'oauth';
export type CredentialSource = 'env' | 'claude-login' | 'stored';

export type CredentialInfo = {
	readonly kind: CredentialKind;
	readonly source: CredentialSource;
	readonly account?: string;
};

export type Credential = CredentialInfo & {readonly value: string; readonly passthrough?: true};

export type QueryFn = (p: {
	prompt: string;
	options?: Options;
}) => AsyncIterable<SDKMessage> & {close?: () => void};

export type TurnResult = {
	sessionId: string;
	text: string;
	model?: string;
	apiKeySource?: string;
	numTurns?: number;
};

export type ClaudeState = {
	lastSessionId?: string;
	lastModel?: string;
	chatModel?: string;
	chatEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	chatThinking?: 'disabled';
	chatFastMode?: boolean;
	chatOutputStyle?: 'Explanatory' | 'Learning';
	chatPermissionMode?: 'acceptEdits' | 'plan' | 'auto';
	chatInputMode?: 'vim';
	chatMcp?: 'off';
	chatHooks?: 'on';
	chatKeepRunning?: 'on';
	chatRouter?: 'on';
	chatClassifier?: 'off';
	tierLightModel?: TierModel;
	tierLightEffort?: Effort;
	tierStandardModel?: TierModel;
	tierStandardEffort?: Effort;
	tierStrongModel?: TierModel;
	tierStrongEffort?: Effort;
	tierMaxModel?: TierModel;
	tierMaxEffort?: Effort;
	allowedCommands?: string[];
	subscriptionNotice?: number;
	retiredNoticeAt?: string;
};

export type ChatQueryFn = (p: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}) => AsyncIterable<SDKMessage> & {
	interrupt?: () => Promise<unknown>;
	close?: () => void;
	setPermissionMode?: (mode: 'default' | 'auto' | 'plan') => Promise<void>;
	setModel?: (model?: string) => Promise<void>;
	setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
	applyFlagSettings?: (settings: Record<string, unknown>) => Promise<void>;
	rewindFiles?: (userMessageId: string, options?: {dryRun?: boolean}) => Promise<RewindResult>;
	stopTask?: (taskId: string) => Promise<void>;
	backgroundTasks?: (toolUseId?: string) => Promise<boolean>;
	mcpServerStatus?: () => Promise<Array<{name: string; status: string; error?: string}>>;
	reconnectMcpServer?: (name: string) => Promise<void>;
	getContextUsage?: (opts?: {detail?: 'summary' | 'full'}) => Promise<unknown>;
};

export type RewindResult = {canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number};
