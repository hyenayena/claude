import type {LivePatch} from '../chat-prefs.js';
import type {RewindResult} from '../types.js';
import type {SlashCommandInfo, TaskInfo} from './chat-session.js';
import type {ChatController} from './events.js';
import type {ChatUsage} from './usage.js';

export interface ChatHandle extends ChatController {
	readonly commands: readonly SlashCommandInfo[];
	readonly tasks: readonly TaskInfo[];
	backgroundTasks(): Promise<boolean>;
	stopTask(id: string): Promise<void>;
	mcpStatus(): Promise<Array<{name: string; status: string; error?: string}> | undefined>;
	reconnectMcp(name: string): Promise<void>;
	rewindFiles(userMessageId: string): Promise<RewindResult>;
	setTitle(title: string): void;
	forget(key: string): void;
	applyLive(patch: LivePatch): void;
	readonly usage?: ChatUsage;
	setKeep?(keep: boolean): void;
	end?(): void;
}
