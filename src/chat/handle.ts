import type {LivePatch} from '../chat-prefs.js';
import type {RewindResult} from '../types.js';
import type {SlashCommandInfo, TaskInfo} from './chat-session.js';
import type {ChatController} from './events.js';
import type {ChatUsage} from './usage.js';

/** What the console commands and the settings use of an open chat; a local session and a remote mirror both provide it. */
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
	// Tokens since the chat opened; only a chat that runs in this process counts them.
	readonly usage?: ChatUsage;
	// Only a chat that runs in a background process.
	setKeep?(keep: boolean): void;
	// Ends the background chat instead of just leaving it.
	end?(): void;
}
