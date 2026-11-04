import type {GallerySection} from '../kit.js';

const scrub = (s: string): string => s;

const intro = [
	'# Heading one',
	'## Heading two',
	'### Heading three',
	'',
	'Plain text with **bold**, *italic*, ~~strike~~, `inline code` and a [link](https://example.com/docs).',
	'',
	'- first item',
	'  - nested item',
	'    - deeper item',
	'- second item that is long enough to wrap onto a second row under its marker, not under the bullet',
	'1. one',
	'2. two',
	'- [x] done',
	'- [ ] to do',
	'',
	'> A quoted remark that may also run long enough to wrap inside the quote rule.',
	'',
	'---',
].join('\n');

const typescript = ['```typescript', 'export function load(path: string): Row[] {', '\t// one JSON object per line', '\treturn read(path).map(line => JSON.parse(line));', '}', '```'].join('\n');

const bash = ['```bash', 'npm run -s dev -- --run dev check core claude 2>&1 | tail -n 60', '```'].join('\n');

const longLine = ['```text', `const value = compute(${Array.from({length: 14}, (_, i) => `argument${i}`).join(', ')});`, '```'].join('\n');

const table = ['| Name | Kind | Notes |', '|---|:-:|--:|', '| `parse` | function | reads **text** |', '| render | function | draws rows |'].join('\n');

const capped = ['```', ...Array.from({length: 130}, (_, i) => `line ${i + 1}`), '```'].join('\n');

export const markdownGallerySection: GallerySection = {
	name: 'markdown',
	title: 'Assistant text',
	description: 'Assistant Markdown: headings, lists, quotes, links, code blocks with syntax colours, tables, the thinking row',
	load: async () => {
		const [p, hl] = await Promise.all([import('./present.js'), import('./highlight.js')]);
		await hl.preloadHighlighter();
		return ({width}) => {
			const rows = (md: string): string[] => p.formatAssistantBlock(md, scrub, false, width).split('\n');
			return [
				...rows(intro),
				...rows(typescript),
				...rows(bash),
				...rows(longLine),
				...rows(table),
				...rows(capped),
				p.formatThinking('Looking at the parser first.', scrub, 12_000),
			];
		};
	},
};
