export type SetHeader = (element: unknown) => void;

export function headerHost(host: unknown): SetHeader | undefined {
	const fn = (host as {setHeader?: unknown} | null | undefined)?.setHeader;
	if (typeof fn !== 'function') return undefined;
	return (fn as SetHeader).bind(host);
}
