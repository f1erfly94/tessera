import {describe, expect, it} from "vitest";

import type {Op} from "../../shared/doc";
import type {ClientMessage, ServerMessage} from "../../shared/protocol";
import type {Shape} from "../../shared/shape";
import {LIMITS} from "../../shared/validate";
import {SyncClient} from "./sync-client";

const rect = (id: string, x = 0): Shape => ({
    id,
    type: "rect",
    x,
    y: 0,
    w: 10,
    h: 10,
    stroke: "#000000",
    fill: null,
    strokeWidth: 2,
    z: "a0",
});

/** A client connected to a fake server that has already sent it `shapes`. */
const connectedClient = (shapes: Shape[] = [], options: {lastApplied?: number; seq?: number} = {}) => {
    const sent: ClientMessage[] = [];
    const client = new SyncClient({clientId: "me", name: "Me", color: "#123456"});
    client.connected((message) => sent.push(message));
    client.receive({type: "snapshot", shapes});
    client.receive({type: "welcome", seq: options.seq ?? 0, lastApplied: options.lastApplied ?? 0, you: "p1", peers: []});
    return {client, sent};
};

/** A change from someone else, as the server relays it. */
const remote = (seq: number, n: number, ops: Op[]): ServerMessage => ({type: "change", seq, change: {client: "other", n, ops}});

describe("SyncClient", () => {
    it("does not flicker when someone else writes a property we are still sending", () => {
        const {client} = connectedClient([rect("s")]);
        client.commit([{t: "update", id: "s", patch: {x: 10}}]);
        client.flush();

        // The server ordered their write first; ours is on its way.
        client.receive(remote(1, 1, [{t: "update", id: "s", patch: {x: 5, y: 7}}]));
        expect(client.view.get("s")?.x).toBe(10); // ours, not a flash of theirs
        expect(client.view.get("s")?.y).toBe(7); // the property we did not touch arrives as normal

        client.receive({type: "change", seq: 2, change: {client: "me", n: 1, ops: [{t: "update", id: "s", patch: {x: 10}}]}});
        expect(client.confirmed.get("s")?.x).toBe(10);
        expect(client.pendingCount).toBe(0);
    });

    it("merges a drag into one change until it is sent", () => {
        const {client, sent} = connectedClient([rect("s")]);
        for (let x = 1; x <= 30; x++) client.commit([{t: "update", id: "s", patch: {x}}], "drag");
        client.flush();
        const changes = sent.filter((message) => message.type === "change");
        expect(changes).toHaveLength(1);
        expect(changes[0]?.type === "change" && changes[0].change.ops).toEqual([{t: "update", id: "s", patch: {x: 30}}]);
    });

    it("keeps offline edits and sends them once it is back", () => {
        const {client} = connectedClient([rect("s")]);
        client.disconnected();
        client.commit([{t: "update", id: "s", patch: {x: 42}}]);
        client.commit([{t: "create", shape: rect("t")}]);
        client.flush(); // nowhere to send it
        expect(client.view.get("s")?.x).toBe(42);

        const sent: ClientMessage[] = [];
        client.connected((message) => sent.push(message));
        client.receive({type: "snapshot", shapes: [rect("s")]});
        client.receive({type: "welcome", seq: 0, lastApplied: 0, you: "p2", peers: []});

        expect(client.view.get("s")?.x).toBe(42);
        expect(sent.filter((message) => message.type === "change")).toHaveLength(2);
    });

    it("does not re-send what the server applied before the connection dropped", () => {
        const {client} = connectedClient([rect("s")]);
        client.commit([{t: "update", id: "s", patch: {x: 1}}]);
        client.flush();
        client.disconnected(); // the acknowledgement is lost with the socket

        const sent: ClientMessage[] = [];
        client.connected((message) => sent.push(message));
        client.receive({type: "snapshot", shapes: [rect("s", 1)]});
        client.receive({type: "welcome", seq: 1, lastApplied: 1, you: "p2", peers: []});

        expect(sent.filter((message) => message.type === "change")).toHaveLength(0);
        expect(client.pendingCount).toBe(0);
        expect(client.view.get("s")?.x).toBe(1);
    });

    it("rolls a refused change back", () => {
        const reasons: string[] = [];
        const client = new SyncClient({clientId: "me", name: "Me", color: "#123456"}, {rejected: (reason) => reasons.push(reason)});
        client.connected(() => {});
        client.receive({type: "welcome", seq: 0, lastApplied: 0, you: "p1", peers: []});
        client.commit([{t: "create", shape: rect("big")}]);
        client.flush();
        client.receive({type: "reject", n: 1, reason: "full"});

        expect(client.view.has("big")).toBe(false);
        expect(client.pendingCount).toBe(0);
        expect(reasons).toEqual(["full"]);
    });

    it("asks to resynchronise when the stream skips a number", () => {
        let resyncs = 0;
        const client = new SyncClient({clientId: "me", name: "Me", color: "#123456"}, {resync: () => resyncs++});
        client.connected(() => {});
        client.receive({type: "welcome", seq: 3, lastApplied: 0, you: "p1", peers: []});
        client.receive(remote(5, 1, [{t: "delete", id: "x"}]));
        expect(resyncs).toBe(1);
        expect(client.seq).toBe(3);
    });

    it("divides an edit the room would refuse, and keeps its order", () => {
        const {client, sent} = connectedClient();
        const ops: Op[] = Array.from({length: 1_200}, (_, index) => ({t: "create", shape: rect(`s${index}`, index)}));
        client.commit(ops);
        client.flush();

        const changes = sent.flatMap((message) => (message.type === "change" ? [message.change] : []));
        expect(changes.length).toBeGreaterThan(1);
        expect(Math.max(...changes.map((change) => change.ops.length))).toBeLessThanOrEqual(LIMITS.opsPerChange);
        expect(changes.flatMap((change) => change.ops)).toEqual(ops); // every operation, still in order
        expect(changes.map((change) => change.n)).toEqual([...changes.map((change) => change.n)].sort((a, b) => a - b));
        expect(client.view.size).toBe(1_200);
    });

    it("still merges a drag of many shapes into one change until it is sent", () => {
        const {client, sent} = connectedClient(Array.from({length: 600}, (_, index) => rect(`s${index}`)));
        for (let x = 1; x <= 20; x++) {
            client.commit(
                Array.from({length: 600}, (_, index): Op => ({t: "update", id: `s${index}`, patch: {x}})),
                "drag",
            );
        }
        client.flush();

        // Two messages because 600 operations do not fit in one, not forty.
        const changes = sent.filter((message) => message.type === "change");
        expect(changes).toHaveLength(2);
        expect(client.view.get("s0")?.x).toBe(20);
    });

    it("drops a single operation too big to ever send, and says so", () => {
        const reasons: string[] = [];
        const client = new SyncClient({clientId: "me", name: "Me", color: "#123456"}, {rejected: (reason) => reasons.push(reason)});
        const sent: ClientMessage[] = [];
        client.connected((message) => sent.push(message));
        client.receive({type: "welcome", seq: 0, lastApplied: 0, you: "p1", peers: []});

        client.commit([{t: "create", shape: {...rect("huge"), text: "x".repeat(600_000)}}]);
        client.commit([{t: "create", shape: rect("fine")}]);
        client.flush();

        expect(sent.filter((message) => message.type === "change")).toHaveLength(1); // only the one that fits
        expect(client.view.has("huge")).toBe(false);
        expect(client.view.has("fine")).toBe(true);
        expect(client.pendingCount).toBe(1);
        expect(reasons).toHaveLength(1);
    });

    it("never reuses a change number after a reload", () => {
        const pending = [{client: "me", n: 7, ops: [{t: "delete" as const, id: "x"}]}];
        const client = new SyncClient({clientId: "me", name: "Me", color: "#123456", pending, counter: 5});
        client.commit([{t: "delete", id: "y"}]);
        expect(client.pendingChanges.map((change) => change.n)).toEqual([7, 8]);
    });
});
