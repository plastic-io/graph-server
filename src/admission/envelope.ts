import { ulid } from "ulid";
import { fromBase64, UPDATE_FORMAT } from "@plastic-io/graph-crdt";

/**
 * The wire envelope for a mutation (plan §5.1).  v1 is the pre-existing YjsEnvelope; v2
 * adds a client-minted mutationId (idempotency) and clientInfo.  Everything about
 * identity is server-derived; nothing here is trusted for who is acting.
 */
export interface ParsedEnvelope {
    graphId: string;
    mutationId: string;
    legacy: boolean;          // no mutationId supplied: minted here, allowed during the migration
    description: string;
    update: Uint8Array;       // the raw sync message bytes (type + content), base64-decoded
    intent?: string;
    clientInfo?: { name: string; version: string };
    origin?: string;
}

export interface EnvelopeError {
    code: "SCHEMA_INVALID";
    reason: string;
}

export const MAX_UPDATE_BYTES = Number(process.env.MAX_UPDATE_BYTES || 1048576);   // 1 MiB decoded
export const MAX_DESCRIPTION = 200;
const ID = /^[A-Za-z0-9_.-]{1,64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseEnvelope(body: any): ParsedEnvelope | EnvelopeError {
    if (!body || typeof body !== "object") {
        return { code: "SCHEMA_INVALID", reason: "the message is not an object" };
    }
    if (typeof body.graphId !== "string" || !ID.test(body.graphId)) {
        return { code: "SCHEMA_INVALID", reason: "graphId is missing or malformed" };
    }
    if (body.format !== undefined && body.format !== UPDATE_FORMAT) {
        return { code: "SCHEMA_INVALID", reason: `update format ${body.format} is not supported; this server speaks ${UPDATE_FORMAT}` };
    }
    if (body.schemaVersion !== undefined && body.schemaVersion !== 1 && body.schemaVersion !== 2) {
        return { code: "SCHEMA_INVALID", reason: `envelope schemaVersion ${body.schemaVersion} is not supported` };
    }
    if (typeof body.payload !== "string" || body.payload.length === 0) {
        return { code: "SCHEMA_INVALID", reason: "payload is missing" };
    }
    if (body.payload.length > Math.ceil(MAX_UPDATE_BYTES * 4 / 3) + 4) {
        return { code: "SCHEMA_INVALID", reason: `payload exceeds MAX_UPDATE_BYTES (${MAX_UPDATE_BYTES})` };
    }
    let update: Uint8Array;
    try {
        update = fromBase64(body.payload);
    } catch (err) {
        return { code: "SCHEMA_INVALID", reason: "payload is not base64" };
    }
    if (update.byteLength > MAX_UPDATE_BYTES) {
        return { code: "SCHEMA_INVALID", reason: `update exceeds MAX_UPDATE_BYTES (${MAX_UPDATE_BYTES})` };
    }
    let mutationId = body.mutationId;
    let legacy = false;
    if (mutationId === undefined || mutationId === null || mutationId === "") {
        mutationId = ulid();
        legacy = true;
    } else if (typeof mutationId !== "string" || !ULID.test(mutationId)) {
        return { code: "SCHEMA_INVALID", reason: "mutationId must be a ULID" };
    }
    const description = typeof body.description === "string" && body.description.trim()
        ? body.description.trim().slice(0, MAX_DESCRIPTION)
        : "Change";
    const clientInfo = body.clientInfo && typeof body.clientInfo === "object"
        ? { name: String(body.clientInfo.name || "").slice(0, 64), version: String(body.clientInfo.version || "").slice(0, 32) }
        : undefined;
    return {
        graphId: body.graphId,
        mutationId,
        legacy,
        description,
        update,
        intent: typeof body.intent === "string" ? body.intent.slice(0, 4000) : undefined,
        clientInfo,
        origin: typeof body.origin === "string" ? body.origin : undefined,
    };
}

export function isEnvelopeError(x: any): x is EnvelopeError {
    return x && x.code === "SCHEMA_INVALID" && typeof x.reason === "string";
}
