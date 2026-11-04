import type {GallerySection} from '../kit.js';

const scrub = (s: string): string => s;

const todos = [
	{content: 'Read the parser', status: 'completed' as const},
	{content: 'Patch parse()', status: 'in_progress' as const, activeForm: 'Patching parse()'},
	{content: 'Run the tests', status: 'pending' as const},
];

const patch = {hunks: [{oldStart: 11, newStart: 11, lines: [' const rows = split(text);', '-return rows[0];', '+return rows.at(0) ?? "";']}]};

// present.ts stays out of the plugin start: it is loaded when the gallery is shown.
export const chatGallerySection: GallerySection = {
	name: 'chat',
	title: 'Chat transcript',
	description: 'The pieces of the claude chat as they are drawn today',
	load: async () => {
		const p = await import('./present.js');
		return ({width}) => {
			const blocks = [
				p.formatUserLine('Fix the failing test in parse.ts', scrub),
				p.formatAssistantBlock('Here is the plan:\n\n- read the **test**\n- patch `parse()`', scrub, false, width),
				p.formatThinking('Looking at the parser first.', scrub),
				p.formatToolBlock({name: 'Edit', input: {file_path: 'src/parse.ts', old_string: 'return rows[0];', new_string: 'return rows.at(0) ?? "";'}, isError: false, text: '', patch}, scrub, width),
				p.formatToolBlock({name: 'Bash', input: {command: 'npm test'}, isError: true, text: '1 test failed'}, scrub, width),
				p.todoLines(todos, scrub, 4).join('\n'),
				p.formatNotice('Notice: the model is unchanged', scrub),
				p.formatWarning('Warning: the session is almost full', scrub),
				p.formatError('The request failed', scrub),
			];
			return blocks.flatMap(b => b.split('\n'));
		};
	},
};
