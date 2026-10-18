import type {Options, SDKMessage, SDKUserMessage} from '@anthropic-ai/claude-agent-sdk';

export type CredentialKind = 'api-key' | 'oauth';
export type CredentialSource = 'env' | 'stored' | 'legacy-file';

export type CredentialInfo = {
	readonly kind: CredentialKind;
	readonly source: CredentialSource;
};

export type Credential = CredentialInfo & {readonly value: string};

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
	subscriptionNoticeShown?: boolean;
};

export type ChatQueryFn = (p: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}) => AsyncIterable<SDKMessage> & {interrupt?: () => Promise<unknown>; close?: () => void};
