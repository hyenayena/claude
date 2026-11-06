import type {AuditEntry, ChatMode, PermissionDecision, PermissionRequest} from '../deps/chat.js';

export const sdkPermissionMode = (mode: ChatMode): 'auto' | 'plan' | 'default' =>
	mode === 'auto' || mode === 'plan' ? mode : 'default';

export interface PermissionPrompter {
	readonly mode: ChatMode;
	request(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
	hasApproved(key: string): boolean;
	remember(key: string): void;
	audit(entry: AuditEntry): void;
	setMode?(mode: ChatMode): void;
}

export const PERMISSION_IDLE_MS = 15 * 60 * 1000;
export const MAX_QUEUE = 16;

export const BASH_TEXT_NOTE =
	'This Bash check matches the command text, so it also refuses commands that only mention the name. To write or change a file whose content mentions it (source, tests, docs), use Edit or Write; to search for it, use Grep. Do not read the protected files themselves.';
export const POLICY_DENY = {
	outside: 'Access to that path is not allowed (outside the project).',
	guard: 'Access to that path is not allowed (protected Claude configuration file).',
	secret: 'Access to that path is not allowed (secret or credential file).',
	readonly:
		'Writing there is not allowed: that project is read-only in this work session. Ask the user which projects the change touches, then run the console command "project isolate <name>" (it asks the user).',
	projectState: `The project module's data (its state decides which projects are writable) is not to be touched. ${BASH_TEXT_NOTE}`,
	image:
		'Writing there is not allowed: this is the read-only yena image, which changes only with ./yena build. Edit the working copy in /workplace/yena instead (ask the user, then "project isolate yena").',
	hostState: `yena's host state (the module overlay, the start mode) is not to be touched from the chat; use the console commands mod and mode. Only its logs folder is readable: with Read or Grep, or with a sandboxed Bash command that names that folder. ${BASH_TEXT_NOTE}`,
	locked: "Writing there is not allowed (yena's Claude data dir). Instructions, agents and skills are edited in the md hub, at its own path.",
	authFiles: `Access to authentication files is blocked. ${BASH_TEXT_NOTE}`,
	procEnv: `Reading process environments is blocked: they hold credentials. ${BASH_TEXT_NOTE}`,
	sshAgent: `Using the host's ssh-agent is blocked. Git in yena repositories goes out through the account set with "account use". ${BASH_TEXT_NOTE}`,
	accountSecrets: `Access to the account module's secrets and keys is blocked. Use the account console commands; they never show secret values. ${BASH_TEXT_NOTE}`,
	privileged:
		'Adding or changing allowed-tools, hooks, permissionMode or mcpServers in a skill, agent or command is not allowed in the chat: it would let tool calls skip the approval prompts. Tell the user the exact change so they can make it by hand.',
	background: 'Background execution is not available in the chat.',
	sandbox: 'The Bash sandbox could not be updated to the current project isolation, so the command was not run. Try again.',
	isolation: 'Running an agent in a worktree or remotely is not available in the chat.',
	invalidInput: 'The tool input is invalid.',
	unknownTool: 'That tool is not available in the chat.',
} as const;
export const scratchDenied = (scratch: string): string =>
	`Access to that path is not allowed: Claude Code's temporary folder and /tmp are shared by every chat. Put scratch files and script outputs in this chat's scratch folder, ${scratch} (also $YENA_SCRATCH); Read, Edit and Write work there.`;
export const POLICY_ASK = {
	instructions: 'CLAUDE.md and SOUL.md are loaded into every session: changes to them always need approval.',
	newHost: 'First fetch from this host: a URL can carry data out.',
} as const;
export const toolUnavailableMessage = (name: string): string =>
	`Tool "${name}" is not available in the chat`;
