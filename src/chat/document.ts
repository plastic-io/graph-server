import * as Y from 'yjs';
import {applyUpdate, encodeState, mergeUpdates, diffUpdate, toBase64, fromBase64, UPDATE_FORMAT} from '@plastic-io/graph-crdt';
import type {ChatMessage} from './store';

/** Each admitted message contributes an independent Y.Map entry. Independent
 * updates have no predecessor dependency, so replicas can receive any page or
 * a live message first, then converge as missing history arrives. The sender
 * and interruption fields are stamped/validated before creating this update. */
export function encodeMessage(message: ChatMessage): string {
    const doc = new Y.Doc();
    // HEAD's conditional commit assigns a unique sequence within this room.
    // Use it as this one-entry writer ID; random 32-bit IDs per message would
    // eventually collide in a long-lived conversation. Uncommitted attempts
    // never leave the server, and every retry reuses the committed bytes.
    doc.clientID = message.seq;
    try {doc.getMap('messages').set(message.id, message); return toBase64(encodeState(doc));}
    finally {doc.destroy();}
}
export function messagesFrom(payload: string): ChatMessage[] {
    const doc = new Y.Doc();
    try {
        applyUpdate(doc, fromBase64(payload));
        return [...doc.getMap<ChatMessage>('messages').values()].sort((a, b) => a.seq - b.seq);
    } finally {doc.destroy();}
}
export function mergePayloads(payloads: string[], stateVector?: string) {
    const empty = new Y.Doc();
    const merged = payloads.length ? mergeUpdates(payloads.map(fromBase64)) : encodeState(empty);
    empty.destroy();
    return {payload: toBase64(stateVector ? diffUpdate(merged, fromBase64(stateVector)) : merged), updateFormat: UPDATE_FORMAT};
}
