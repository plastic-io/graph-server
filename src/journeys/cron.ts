/**
 * The small part of cron a journey needs (plan §8.1.7: `schedule` is a cron
 * string).  Five fields: a star, a step ("every n"), a range, a list, or a
 * plain number, matched
 * against a minute in UTC.  Anything richer is refused when the journey is
 * saved rather than silently never running.
 */
const FIELD_RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function matchField(field: string, value: number, [min, max]: [number, number]): boolean {
    return field.split(",").some((part) => {
        const trimmed = part.trim();
        if (trimmed === "*") {
            return true;
        }
        const [range, stepText] = trimmed.split("/");
        const step = stepText ? Number(stepText) : 1;
        if (!isFinite(step) || step < 1) {
            return false;
        }
        let from = min;
        let to = max;
        if (range !== "*") {
            const bounds = range.split("-").map(Number);
            if (!bounds.every((n) => isFinite(n))) {
                return false;
            }
            from = bounds[0];
            to = bounds.length > 1 ? bounds[1] : (stepText ? max : bounds[0]);
        }
        if (value < from || value > to) {
            return false;
        }
        return (value - from) % step === 0;
    });
}

/** Does this field match at least one value in its range?  A field that matches nothing never runs. */
function matchesAnything(field: string, range: [number, number]): boolean {
    for (let value = range[0]; value <= range[1]; value++) {
        if (matchField(field, value, range)) {
            return true;
        }
    }
    return false;
}

export function isValidCron(schedule: string): boolean {
    const fields = String(schedule || "").trim().split(/\s+/);
    if (fields.length !== 5) {
        return false;
    }
    return fields.every((field, i) => /^[0-9*/,-]+$/.test(field) && matchesAnything(field, FIELD_RANGES[i]));
}

/** Is this minute one the schedule names?  Day-of-month and day-of-week are or-ed, as cron does. */
export function cronMatches(schedule: string, at: Date): boolean {
    const fields = String(schedule || "").trim().split(/\s+/);
    if (fields.length !== 5) {
        return false;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    if (!matchField(minute, at.getUTCMinutes(), FIELD_RANGES[0])) return false;
    if (!matchField(hour, at.getUTCHours(), FIELD_RANGES[1])) return false;
    if (!matchField(month, at.getUTCMonth() + 1, FIELD_RANGES[3])) return false;
    const domRestricted = dayOfMonth.trim() !== "*";
    const dowRestricted = dayOfWeek.trim() !== "*";
    const domMatch = matchField(dayOfMonth, at.getUTCDate(), FIELD_RANGES[2]);
    const dowMatch = matchField(dayOfWeek, at.getUTCDay(), FIELD_RANGES[4]);
    if (domRestricted && dowRestricted) {
        return domMatch || dowMatch;
    }
    if (domRestricted) {
        return domMatch;
    }
    if (dowRestricted) {
        return dowMatch;
    }
    return true;
}

/**
 * Is this journey due?  A tick that covers several minutes (the scheduler runs
 * every five) asks about each minute since it last ran, so a journey scheduled
 * for a minute the tick skipped still runs, and runs once.
 */
export function isDue(schedule: string, now: Date, lastRunAt?: string | null, windowMinutes = 5): boolean {
    const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
    if (isFinite(last) && now.getTime() - last < 60000) {
        return false;                       // it ran within this minute already
    }
    const minutes = isFinite(last) ? Math.min(windowMinutes, Math.floor((now.getTime() - last) / 60000)) : windowMinutes;
    for (let back = 0; back < Math.max(1, minutes); back++) {
        if (cronMatches(schedule, new Date(now.getTime() - back * 60000))) {
            return true;
        }
    }
    return false;
}
