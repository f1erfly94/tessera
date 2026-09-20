import type {Change} from "./doc";
import type {Shape} from "./shape";
import {ID_PATTERN, parseChange} from "./validate";

/**
 * The wire protocol, imported by both the Worker and the editor, so a message
 * one side can send is a message the other is forced to handle.
 */
export const PROTOCOL_VERSION = 1;

export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;

/** The most characters one message may carry; a bigger one costs the sender its socket. */
export const MAX_MESSAGE_CHARS = 512 * 1024;

/** Someone else in the room, as the others see them. */
export interface Peer {
    /** One per connection: the same person in two tabs is two peers. */
    id: string;
    name: string;
    color: string;
    /** World coordinates of their pointer, or null when it is off the board. */
    cursor: [number, number] | null;
    selection: string[];
}

export type ClientMessage =
    | {type: "hello"; v: number; client: string; name: string; color: string}
    | {type: "change"; change: Change}
    | {type: "presence"; cursor: [number, number] | null; selection: string[]};

/**
 * A change the room will not take, whose envelope still says which change it is.
 * That number is the difference between an answer its author can act on — a
 * `reject` it rolls back — and a nameless error it can only ignore, which would
 * leave the change queued as though it were still on its way.
 */
export interface BadChange {
    type: "bad-change";
    n: number;
}

export type ServerMessage =
    /** The board arrives in parts so no single message grows with the room. */
    | {type: "snapshot"; shapes: Shape[]}
    /** Sent after the last snapshot part: the board is complete as of `seq`. */
    | {type: "welcome"; seq: number; lastApplied: number; you: string; peers: Peer[]}
    /** A change the server applied, as number `seq`. Sent to everyone, the author included. */
    | {type: "change"; seq: number; change: Change}
    /** Only to the author: the change was refused and is not part of the board. */
    | {type: "reject"; n: number; reason: string}
    /** Only to the author: the change had already been applied earlier. */
    | {type: "duplicate"; n: number}
    | {type: "presence"; peer: Peer}
    | {type: "leave"; id: string}
    | {type: "error"; message: string};

const MAX_NAME = 32;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_SELECTION = 1_000;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const parseCursor = (value: unknown): [number, number] | null | undefined => {
    if (value === null) return null;
    if (Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)) {
        return [value[0] as number, value[1] as number];
    }
    return undefined;
};

/**
 * Parses and validates a raw client message. A change whose contents do not
 * pass comes back as a `bad-change` carrying its number; anything else
 * malformed comes back as null.
 */
export const parseClientMessage = (raw: string): ClientMessage | BadChange | null => {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof value !== "object" || value === null) return null;
    const message = value as Record<string, unknown>;

    switch (message.type) {
        case "hello": {
            const {v, client, name, color} = message;
            if (v !== PROTOCOL_VERSION) return null;
            if (typeof client !== "string" || !ID_PATTERN.test(client)) return null;
            if (typeof name !== "string" || name.trim().length === 0) return null;
            if (typeof color !== "string" || !COLOR_PATTERN.test(color)) return null;
            return {type: "hello", v, client, name: name.trim().slice(0, MAX_NAME), color};
        }
        case "change": {
            const change = parseChange(message.change);
            if (change) return {type: "change", change};
            const n = typeof message.change === "object" && message.change !== null ? (message.change as {n?: unknown}).n : undefined;
            return typeof n === "number" && Number.isSafeInteger(n) && n >= 1 ? {type: "bad-change", n} : null;
        }
        case "presence": {
            const cursor = parseCursor(message.cursor);
            const {selection} = message;
            if (cursor === undefined) return null;
            if (
                !Array.isArray(selection) ||
                selection.length > MAX_SELECTION ||
                !selection.every((id) => typeof id === "string" && ID_PATTERN.test(id))
            ) {
                return null;
            }
            return {type: "presence", cursor, selection: selection as string[]};
        }
        default:
            return null;
    }
};
