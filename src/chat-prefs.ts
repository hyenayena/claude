import type {Options} from '@anthropic-ai/claude-agent-sdk';
import type {Logger, Setting, SettingOption} from '../../../src/api.js';
import type {ClaudeState} from './types.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const OUTPUT_STYLES = ['Explanatory', 'Learning'] as const;

export type Effort = (typeof EFFORTS)[number];
export type OutputStyle = (typeof OUTPUT_STYLES)[number];

/** Per-chat tuning beyond the model; unset fields keep the Claude Code defaults. */
export type ChatTuning = {
	effort?: Effort;
	thinking?: 'disabled';
	fastMode?: true;
	outputStyle?: OutputStyle;
	// MCP servers from the Claude Code config are on unless this is set.
	noMcp?: true;
	// Hooks from settings files run only when this is set.
	hooks?: true;
};

/** A change to the running chat; null returns a field to its default. */
export type LivePatch = {
	model?: string | null;
	effort?: Effort | null;
	thinking?: 'disabled' | null;
	fastMode?: boolean;
	outputStyle?: OutputStyle | null;
};

/** The live change a settings value stands for. */
export function livePatch(key: string, value: string): LivePatch | undefined {
	switch (key) {
		case 'chatModel':
			return {model: value === '' ? null : value};
		case 'chatEffort':
			return {effort: isEffort(value) ? value : null};
		case 'chatThinking':
			return {thinking: value === 'disabled' ? 'disabled' : null};
		case 'chatFastMode':
			return {fastMode: value === 'on'};
		case 'chatOutputStyle':
			return {outputStyle: isOutputStyle(value) ? value : null};
		default:
			return undefined;
	}
}

/** Model and tuning after a live change, for the next query the chat spawns. */
export function withPatch(cur: {model?: string; tuning: ChatTuning}, patch: LivePatch): {model?: string; tuning: ChatTuning} {
	const tuning: ChatTuning = {...cur.tuning};
	let model = cur.model;
	if (patch.model !== undefined) model = patch.model ?? undefined;
	if (patch.effort !== undefined) {
		if (patch.effort) tuning.effort = patch.effort;
		else delete tuning.effort;
	}
	if (patch.thinking !== undefined) {
		if (patch.thinking) tuning.thinking = patch.thinking;
		else delete tuning.thinking;
	}
	if (patch.fastMode !== undefined) {
		if (patch.fastMode) tuning.fastMode = true;
		else delete tuning.fastMode;
	}
	if (patch.outputStyle !== undefined) {
		if (patch.outputStyle) tuning.outputStyle = patch.outputStyle;
		else delete tuning.outputStyle;
	}
	return {...(model !== undefined && {model}), tuning};
}

export const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);
export const isOutputStyle = (v: unknown): v is OutputStyle => OUTPUT_STYLES.includes(v as OutputStyle);

export function tuningFromState(state: ClaudeState): ChatTuning {
	return {
		...(state.chatEffort && {effort: state.chatEffort}),
		...(state.chatThinking && {thinking: state.chatThinking}),
		...(state.chatFastMode && {fastMode: true as const}),
		...(state.chatOutputStyle && {outputStyle: state.chatOutputStyle}),
		...(state.chatMcp === 'off' && {noMcp: true as const}),
		...(state.chatHooks === 'on' && {hooks: true as const}),
	};
}

export function applyTuning(options: Options, tuning: ChatTuning | undefined): Options {
	const next: Options = {...options};
	// MCP servers configured for Claude Code (user and project) load unless turned off; the
	// in-process servers passed in `mcpServers` (yena's console tools) stay either way.
	if (!tuning?.noMcp) next.strictMcpConfig = false;
	if (tuning?.hooks) {
		const base = typeof next.settings === 'object' && next.settings !== null ? next.settings : {};
		next.settings = {...base, disableAllHooks: false};
	}
	if (!tuning) return next;
	if (tuning.effort) next.effort = tuning.effort;
	if (tuning.thinking === 'disabled') next.thinking = {type: 'disabled'};
	if (tuning.fastMode || tuning.outputStyle) {
		const base = typeof options.settings === 'object' && options.settings !== null ? options.settings : {};
		next.settings = {
			...base,
			...(tuning.fastMode && {fastMode: true}),
			...(tuning.outputStyle && {outputStyle: tuning.outputStyle}),
		};
	}
	return next;
}

export const MODEL_OPTIONS: SettingOption[] = [
	{value: '', label: 'Default', description: 'the account default'},
	{value: 'claude-fable-5-1', label: 'Fable 5.1'},
	{value: 'opus', label: 'Opus', description: 'latest Opus'},
	{value: 'sonnet', label: 'Sonnet', description: 'latest Sonnet'},
	{value: 'haiku', label: 'Haiku', description: 'latest Haiku'},
];

type PrefKey =
	| 'chatModel'
	| 'chatEffort'
	| 'chatThinking'
	| 'chatFastMode'
	| 'chatOutputStyle'
	| 'chatPermissionMode'
	| 'chatInputMode'
	| 'chatMcp'
	| 'chatHooks';

type Store = {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};

type PrefSpec = {
	key: PrefKey;
	label: string;
	description: string;
	options: SettingOption[];
	// Converts a chosen option value into the stored value; throws on anything not offered.
	parse: (value: string) => ClaudeState[PrefKey];
	show: (state: ClaudeState) => string;
	onSet?: (value: string) => void;
	// Takes effect only in chats opened after the change.
	newChatsOnly?: true;
};

const fromOptions = <T extends string>(options: SettingOption[], value: string): T | undefined => {
	if (!options.some(o => o.value === value)) throw new Error('Unknown option');
	return value === '' ? undefined : (value as T);
};

const EFFORT_OPTIONS: SettingOption[] = [
	{value: '', label: 'Default', description: 'the model default'},
	...EFFORTS.map(e => ({value: e, label: e[0]!.toUpperCase() + e.slice(1)})),
];
const THINKING_OPTIONS: SettingOption[] = [
	{value: '', label: 'Adaptive', description: 'Claude decides when to think'},
	{value: 'disabled', label: 'Off'},
];
const FAST_OPTIONS: SettingOption[] = [
	{value: '', label: 'Off'},
	{value: 'on', label: 'On', description: 'faster output on supported models'},
];
const MODE_OPTIONS: SettingOption[] = [
	{value: '', label: 'Default', description: 'edits and commands ask first'},
	{value: 'acceptEdits', label: 'Accept edits', description: 'project edits go through without asking'},
	{value: 'plan', label: 'Plan', description: 'Claude researches and proposes a plan first, no edits'},
	{value: 'auto', label: 'Auto', description: 'a classifier approves or denies, asks when unsure'},
];
const INPUT_OPTIONS: SettingOption[] = [
	{value: '', label: 'Normal'},
	{value: 'vim', label: 'Vim', description: 'Esc for NORMAL mode, i/a/o to type'},
];
const MCP_OPTIONS: SettingOption[] = [
	{value: '', label: 'On', description: 'servers from the Claude Code config; each call asks'},
	{value: 'off', label: 'Off'},
];
const HOOK_OPTIONS: SettingOption[] = [
	{value: '', label: 'Off'},
	{value: 'on', label: 'On', description: 'hooks from settings files run (yena\'s path policy stays)'},
];
const STYLE_OPTIONS: SettingOption[] = [
	{value: '', label: 'Default'},
	{value: 'Explanatory', label: 'Explanatory', description: 'explains its choices'},
	{value: 'Learning', label: 'Learning', description: 'leaves parts for you to write'},
];

export type ChatSettingsHooks = {
	// Applies a newly chosen permission mode to the open chat, if any.
	applyMode?: (mode: 'default' | 'acceptEdits' | 'plan' | 'auto') => void;
	// Switches the chat input between normal and vim editing.
	applyInputMode?: (mode: 'normal' | 'vim') => void;
	// Applies model, effort, thinking, fast mode or output style to the open chat, if any.
	applyLive?: (patch: LivePatch) => void;
};

export function chatSettings(
	store: Store,
	isModelId: (v: string) => boolean,
	log: Logger,
	hooks: ChatSettingsHooks = {},
): Setting[] {
	const specs: PrefSpec[] = [
		{
			key: 'chatPermissionMode',
			label: 'Permission mode',
			description: 'How tool calls are approved',
			options: MODE_OPTIONS,
			parse: v => fromOptions<'acceptEdits' | 'plan' | 'auto'>(MODE_OPTIONS, v),
			show: s => s.chatPermissionMode ?? '',
			onSet: v => hooks.applyMode?.(v === '' ? 'default' : (v as 'acceptEdits' | 'plan' | 'auto')),
		},
		{
			key: 'chatModel',
			label: 'Chat model',
			description: 'The model Claude answers with',
			options: MODEL_OPTIONS,
			parse: v => {
				if (v !== '' && !isModelId(v)) throw new Error('Invalid model id');
				return v === '' ? undefined : v;
			},
			show: s => s.chatModel ?? '',
		},
		{
			key: 'chatEffort',
			label: 'Effort',
			description: 'How much effort Claude puts into answers',
			options: EFFORT_OPTIONS,
			parse: v => fromOptions<Effort>(EFFORT_OPTIONS, v),
			show: s => s.chatEffort ?? '',
		},
		{
			key: 'chatThinking',
			label: 'Thinking',
			description: 'Extended thinking',
			options: THINKING_OPTIONS,
			parse: v => fromOptions<'disabled'>(THINKING_OPTIONS, v),
			show: s => s.chatThinking ?? '',
		},
		{
			key: 'chatFastMode',
			label: 'Fast mode',
			description: 'Faster output at a higher price',
			options: FAST_OPTIONS,
			parse: v => (fromOptions(FAST_OPTIONS, v) ? true : undefined),
			show: s => (s.chatFastMode ? 'on' : ''),
		},
		{
			key: 'chatOutputStyle',
			label: 'Output style',
			description: 'How Claude writes its answers',
			options: STYLE_OPTIONS,
			parse: v => fromOptions<OutputStyle>(STYLE_OPTIONS, v),
			show: s => s.chatOutputStyle ?? '',
		},
		{
			key: 'chatMcp',
			label: 'MCP servers',
			description: 'Tools from MCP servers configured for Claude Code',
			newChatsOnly: true,
			options: MCP_OPTIONS,
			parse: v => fromOptions<'off'>(MCP_OPTIONS, v),
			show: s => s.chatMcp ?? '',
		},
		{
			key: 'chatHooks',
			label: 'Settings hooks',
			description: 'Hooks from Claude Code settings files',
			newChatsOnly: true,
			options: HOOK_OPTIONS,
			parse: v => fromOptions<'on'>(HOOK_OPTIONS, v),
			show: s => s.chatHooks ?? '',
		},
		{
			key: 'chatInputMode',
			label: 'Input mode',
			description: 'How the chat input edits text',
			options: INPUT_OPTIONS,
			parse: v => fromOptions<'vim'>(INPUT_OPTIONS, v),
			show: s => s.chatInputMode ?? '',
			onSet: v => hooks.applyInputMode?.(v === 'vim' ? 'vim' : 'normal'),
		},
	];
	return specs.map(spec => ({
		key: spec.key,
		label: spec.label,
		description: `${spec.description}; ${spec.newChatsOnly ? 'applies to new chats' : 'applies now and to new chats'}`,
		options: spec.options,
		get: async () => spec.show(await store.read()),
		set: async value => {
			const stored = spec.parse(value);
			await store.update({[spec.key]: stored});
			log.info('chat setting set', {key: spec.key, value: value === '' ? 'default' : value});
			spec.onSet?.(value);
			const patch = livePatch(spec.key, value);
			if (patch) hooks.applyLive?.(patch);
		},
	}));
}
