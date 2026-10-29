export const clockTime = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
