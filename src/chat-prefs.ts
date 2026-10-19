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
};

export const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);
export const isOutputStyle = (v: unknown): v is OutputStyle => OUTPUT_STYLES.includes(v as OutputStyle);

export function tuningFromState(state: ClaudeState): ChatTuning {
	return {
		...(state.chatEffort && {effort: state.chatEffort}),
		...(state.chatThinking && {thinking: state.chatThinking}),
		...(state.chatFastMode && {fastMode: true as const}),
		...(state.chatOutputStyle && {outputStyle: state.chatOutputStyle}),
	};
}

export function applyTuning(options: Options, tuning: ChatTuning | undefined): Options {
	if (!tuning) return options;
	const next: Options = {...options};
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

type PrefKey = 'chatModel' | 'chatEffort' | 'chatThinking' | 'chatFastMode' | 'chatOutputStyle';

type Store = {read: () => Promise<ClaudeState>; update: (patch: Partial<ClaudeState>) => Promise<unknown>};

type PrefSpec = {
	key: PrefKey;
	label: string;
	description: string;
	options: SettingOption[];
	// Converts a chosen option value into the stored value; throws on anything not offered.
	parse: (value: string) => ClaudeState[PrefKey];
	show: (state: ClaudeState) => string;
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
const STYLE_OPTIONS: SettingOption[] = [
	{value: '', label: 'Default'},
	{value: 'Explanatory', label: 'Explanatory', description: 'explains its choices'},
	{value: 'Learning', label: 'Learning', description: 'leaves parts for you to write'},
];

export function chatSettings(store: Store, isModelId: (v: string) => boolean, log: Logger): Setting[] {
	const specs: PrefSpec[] = [
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
	];
	return specs.map(spec => ({
		key: spec.key,
		label: spec.label,
		description: `${spec.description}; applies to new chats`,
		options: spec.options,
		get: async () => spec.show(await store.read()),
		set: async value => {
			const stored = spec.parse(value);
			await store.update({[spec.key]: stored});
			log.info('chat setting set', {key: spec.key, value: value === '' ? 'default' : value});
		},
	}));
}
