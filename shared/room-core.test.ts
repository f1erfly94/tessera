import {describe, expect, it} from "vitest";

import {RoomCore} from "./room-core";
import type {Shape} from "./shape";

const rect = (id: string): Shape => ({
    id,
    type: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    stroke: "#000000",
    fill: null,
    strokeWidth: 2,
    z: "a0",
});

describe("RoomCore", () => {
    it("applies each change once, however often it is sent", () => {
        const room = new RoomCore();
        const change = {client: "c", n: 1, ops: [{t: "create" as const, shape: rect("a")}]};
        expect(room.receive(change).status).toBe("applied");
        expect(room.receive(change).status).toBe("duplicate");
        expect(room.seq).toBe(1);
        expect(room.lastAppliedFor("c")).toBe(1);
    });

    it("refuses growth past the limit but still accepts deletes", () => {
        const room = new RoomCore({maxShapes: 2, maxBytes: 1_000_000, maxClients: 10});
        room.receive({client: "c", n: 1, ops: [{t: "create", shape: rect("a")}, {t: "create", shape: rect("b")}]});

        const third = room.receive({client: "c", n: 2, ops: [{t: "create", shape: rect("x")}]});
        expect(third.status).toBe("rejected");
        expect(room.shapes.has("x")).toBe(false);

        expect(room.receive({client: "c", n: 3, ops: [{t: "delete", id: "a"}]}).status).toBe("applied");
        expect(room.receive({client: "c", n: 4, ops: [{t: "create", shape: rect("y")}]}).status).toBe("applied");
    });

    it("is all or nothing: a refused change leaves no trace", () => {
        const room = new RoomCore({maxShapes: 1, maxBytes: 1_000_000, maxClients: 10});
        const result = room.receive({
            client: "c",
            n: 1,
            ops: [{t: "create", shape: rect("a")}, {t: "create", shape: rect("b")}],
        });
        expect(result.status).toBe("rejected");
        expect(room.shapes.size).toBe(0);
        expect(room.seq).toBe(0);
        expect(room.lastAppliedFor("c")).toBe(0);
    });

    it("tracks the board's size as shapes change", () => {
        const room = new RoomCore();
        room.receive({client: "c", n: 1, ops: [{t: "create", shape: rect("a")}]});
        const size = room.bytes;
        room.receive({client: "c", n: 2, ops: [{t: "update", id: "a", patch: {stroke: "#ffffff"}}]});
        expect(room.bytes).toBe(size);
        room.receive({client: "c", n: 3, ops: [{t: "delete", id: "a"}]});
        expect(room.bytes).toBe(0);
    });

    it("forgets the least recently seen clients first", () => {
        const room = new RoomCore({maxShapes: 100, maxBytes: 1_000_000, maxClients: 2});
        for (const client of ["a", "b", "a", "c"]) {
            room.receive({client, n: room.lastAppliedFor(client) + 1, ops: [{t: "delete", id: "none"}]});
        }
        expect(room.clients().map(([client]) => client)).toEqual(["a", "c"]);
    });

    it("restores to the same state it saved", () => {
        const room = new RoomCore();
        room.receive({client: "c", n: 1, ops: [{t: "create", shape: rect("a")}]});
        const restored = RoomCore.restore({seq: room.seq, shapes: room.shapes.values(), clients: room.clients()});
        expect(restored.shapes).toEqual(room.shapes);
        expect(restored.bytes).toBe(room.bytes);
        expect(restored.receive({client: "c", n: 1, ops: [{t: "delete", id: "a"}]}).status).toBe("duplicate");
    });
});
