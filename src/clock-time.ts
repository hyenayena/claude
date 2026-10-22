/** HH:MM in the process time zone (the container's, UTC unless TZ is set). */
export const clockTime = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);
