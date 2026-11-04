// The depth is detected once per process, on first use: importing this first pins the 16-colour codes the tests assert.
process.env['YENA_COLOR'] = '16';

const esc = (params: string): string => `${String.fromCharCode(27)}[${params}m`;

export const SGR = {
	reset: esc('0'),
	dim: esc('2'),
	red: esc('31'),
	green: esc('32'),
	cyan: esc('36'),
	bold: esc('1'),
	italic: esc('3'),
	underline: esc('4'),
	yellow: esc('33'),
	magenta: esc('35'),
	blue: esc('34'),
	boldOff: esc('22'),
	italicOff: esc('23'),
	underlineOff: esc('24'),
	fgOff: esc('39'),
	userBg: esc('100'),
	strike: esc('9'),
} as const;
