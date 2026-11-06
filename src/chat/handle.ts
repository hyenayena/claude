import type {LivePatch} from '../chat-prefs.js';
import type {RewindResult} from '../types.js';
import type {SlashCommandInfo, TaskInfo} from './chat-session.js';
import type {ChatSession, McpServerStatus, Tier} from '../deps/chat.js';

export interface ClaudeChatHandle extends ChatSession {
	readonly commands: readonly SlashCommandInfo[];
	readonly tasks: readonly TaskInfo[];
	backgroundTasks(): Promise<boolean>;
	stopTask(id: string): Promise<void>;
	mcpStatus(): Promise<McpServerStatus[] | undefined>;
	reconnectMcp(name: string): Promise<void>;
	rewindFiles(userMessageId: string): Promise<RewindResult>;
	setTitle(title: string): void;
	forget(key: string): void;
	applyLive(patch: LivePatch): void;
	setTier?(tier: Tier | 'auto'): void;
}
