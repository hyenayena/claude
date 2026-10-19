import {useEffect, useState} from 'react';
import type {ViewHost} from '../../../../src/api.js';

export type ViewLayout = {focused: boolean; columns: number};

/** Focus and width from the host; without one the view owns the terminal and is always focused. */
export function useViewHost(host: ViewHost | undefined, terminalColumns: number): ViewLayout {
	const read = (): ViewLayout =>
		host ? {focused: host.isFocused(), columns: host.columns()} : {focused: true, columns: terminalColumns};
	const [layout, setLayout] = useState(read);
	useEffect(() => {
		if (!host) return;
		const sync = () =>
			setLayout(prev => {
				const next = read();
				return prev.focused === next.focused && prev.columns === next.columns ? prev : next;
			});
		sync();
		return host.subscribe(sync);
	}, [host]);
	return host ? layout : {focused: true, columns: terminalColumns};
}
