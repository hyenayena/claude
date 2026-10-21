export type {PickerItem} from '../kit.js';

export function ago(ms: number, now: number): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86_400)} d ago`;
}
