// A structural copy of core's mouse event: core provides it at runtime, older cores do not.
export type ViewMouseEvent = {
	kind: 'press' | 'release' | 'wheel';
	button: 'left' | 'middle' | 'right' | 'none';
	wheel?: 'up' | 'down';
	x: number;
	y: number;
	width: number;
	height: number;
	shift: boolean;
	meta: boolean;
	ctrl: boolean;
};

export type MouseListener = (event: ViewMouseEvent) => boolean | void;
export type SubscribeMouse = (listener: MouseListener) => () => void;

/** The host's mouse subscription, or undefined when the host has none. */
export function mouseHost(host: unknown): SubscribeMouse | undefined {
	const fn = (host as {subscribeMouse?: unknown} | null | undefined)?.subscribeMouse;
	if (typeof fn !== 'function') return undefined;
	return (fn as SubscribeMouse).bind(host);
}

const KINDS = new Set(['press', 'release', 'wheel']);
const BUTTONS = new Set(['left', 'middle', 'right', 'none']);
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

export function validEvent(e: unknown): e is ViewMouseEvent {
	if (typeof e !== 'object' || e === null) return false;
	const v = e as Record<string, unknown>;
	if (!KINDS.has(v.kind as string) || !BUTTONS.has(v.button as string)) return false;
	if (v.wheel !== undefined && v.wheel !== 'up' && v.wheel !== 'down') return false;
	if (v.kind === 'wheel' && v.wheel === undefined) return false;
	if (!isCount(v.x) || !isCount(v.y) || !isCount(v.width) || !isCount(v.height)) return false;
	return v.x >= 0 && v.x < v.width && v.y >= 0 && v.y < v.height;
}
