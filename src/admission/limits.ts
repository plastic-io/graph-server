/**
 * Size, structure and rate limits for admission (plan PB-025).
 *
 * Sizes and struct counts are hard limits checked before anything is decoded
 * in earnest.  The rate limiter is per Lambda instance, in memory: it is a
 * brake on a client that keeps sending malformed or refused updates, not an
 * accounting system, and a burst spread over several instances can exceed it.
 */
export const MAX_UPDATE_BYTES = Number(process.env.MAX_UPDATE_BYTES || 1048576);   // 1 MiB decoded
export const MAX_STRUCTS = Number(process.env.MAX_STRUCTS || 200000);
export const MAX_DESCRIPTION = 200;
export const MAX_INTENT = 4000;
export const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000);
export const RATE_MAX_MUTATIONS = Number(process.env.RATE_MAX_MUTATIONS || 600);    // per principal per window
export const RATE_MAX_REJECTIONS = Number(process.env.RATE_MAX_REJECTIONS || 30);   // rejected ones, same window

export interface RateVerdict {
    ok: boolean;
    reason?: string;
    retryAfterMs?: number;
}

export class RateLimiter {
    private windowMs: number;
    private maxMutations: number;
    private maxRejections: number;
    private seen = new Map<string, { all: number[]; rejected: number[] }>();

    constructor(options: { windowMs?: number; maxMutations?: number; maxRejections?: number } = {}) {
        this.windowMs = options.windowMs ?? RATE_WINDOW_MS;
        this.maxMutations = options.maxMutations ?? RATE_MAX_MUTATIONS;
        this.maxRejections = options.maxRejections ?? RATE_MAX_REJECTIONS;
    }

    private bucket(key: string, now: number) {
        const b = this.seen.get(key) || { all: [], rejected: [] };
        const cutoff = now - this.windowMs;
        b.all = b.all.filter((t) => t > cutoff);
        b.rejected = b.rejected.filter((t) => t > cutoff);
        this.seen.set(key, b);
        return b;
    }

    check(key: string, now = Date.now()): RateVerdict {
        const b = this.bucket(key, now);
        if (b.rejected.length >= this.maxRejections) {
            return { ok: false, reason: `${b.rejected.length} rejected mutations in the last ${this.windowMs / 1000}s`, retryAfterMs: b.rejected[0] + this.windowMs - now };
        }
        if (b.all.length >= this.maxMutations) {
            return { ok: false, reason: `${b.all.length} mutations in the last ${this.windowMs / 1000}s`, retryAfterMs: b.all[0] + this.windowMs - now };
        }
        return { ok: true };
    }

    record(key: string, rejected: boolean, now = Date.now()) {
        const b = this.bucket(key, now);
        b.all.push(now);
        if (rejected) {
            b.rejected.push(now);
        }
    }
}
