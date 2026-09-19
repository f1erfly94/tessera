import type {Change} from "./doc";
import type {Peer, ServerMessage} from "./protocol";
import type {RoomCore} from "./room-core";

/**
 * What the server says in reply to a client, independent of how messages travel.
 * The Durable Object delivers these over WebSockets; the convergence tests
 * deliver them through a simulated network — both run exactly this code.
 */

/** Shapes per snapshot message: keeps every message small however big the board gets. */
export const SNAPSHOT_CHUNK = 200;

/** The board in parts, then the welcome that completes it. */
export const welcomeMessages = (core: RoomCore, client: string, you: string, peers: Peer[]): ServerMessage[] => {
    const shapes = [...core.shapes.values()];
    const messages: ServerMessage[] = [];
    for (let start = 0; start < shapes.length; start += SNAPSHOT_CHUNK) {
        messages.push({type: "snapshot", shapes: shapes.slice(start, start + SNAPSHOT_CHUNK)});
    }
    messages.push({type: "welcome", seq: core.seq, lastApplied: core.lastAppliedFor(client), you, peers});
    return messages;
};

export interface ChangeOutcome {
    /** For every connected client, the author included. */
    broadcast?: ServerMessage;
    /** Only for the author. */
    reply?: ServerMessage;
    /** Shapes whose stored copy is now stale. */
    touched: Set<string>;
}

export const handleChange = (core: RoomCore, change: Change): ChangeOutcome => {
    const result = core.receive(change);
    switch (result.status) {
        case "applied":
            return {broadcast: {type: "change", seq: result.seq, change}, touched: result.touched};
        case "duplicate":
            return {reply: {type: "duplicate", n: change.n}, touched: new Set()};
        case "rejected":
            return {reply: {type: "reject", n: change.n, reason: result.reason}, touched: new Set()};
    }
};
