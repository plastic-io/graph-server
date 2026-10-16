import {diagnosticText} from '../iac/diagnosticSafety';
import {LIMITS} from './contract';
export const safeText = (text: unknown, limit = LIMITS.resultBytes) => diagnosticText(text, undefined, limit);
export function safeValue(value: any, depth = 0): any {
    if (depth > 24) return '[depth limit]';
    if (typeof value === 'string') return safeText(value);
    if (Array.isArray(value)) return value.slice(0, 500).map(x => safeValue(x, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 500).map(([key, v]) =>
        [key, /^(credentials|password|secret|authorization|accessToken|refreshToken|idToken|sessionToken|clientSecret)$/i.test(key) ? '[redacted]' : safeValue(v, depth + 1)]));
    return value;
}
export function boundedResult(value: any) {
    const clean = safeValue(value), text = JSON.stringify(clean);
    return Buffer.byteLength(text) <= LIMITS.resultBytes ? clean : {truncated: true, preview: Buffer.from(text).subarray(0, LIMITS.resultBytes).toString('utf8'), instruction: 'Use narrower queries or cursors; this result is truncated.'};
}
export function chatChunks(text: string): string[] {
    const chunks: string[] = []; let chunk = '';
    for (const c of safeText(text, 20000)) {if (Buffer.byteLength(chunk + c) > 1800) {chunks.push(chunk); chunk = '';} chunk += c;}
    if (chunk.trim()) chunks.push(chunk);
    return chunks.filter(x => x.trim());
}
