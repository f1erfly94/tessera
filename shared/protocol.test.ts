import {describe, expect, it} from "vitest";

import {parseClientMessage, PROTOCOL_VERSION} from "./protocol";

const shape = {id: "s", type: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000000", fill: null, strokeWidth: 2, z: "a0"};
const change = (extra: unknown) => JSON.stringify({type: "change", change: {client: "me", n: 4, ops: [extra]}});

describe("parseClientMessage", () => {
    it("takes a well-formed message", () => {
        const raw = JSON.stringify({type: "hello", v: PROTOCOL_VERSION, client: "me", name: " Ada ", color: "#1971c2"});
        expect(parseClientMessage(raw)).toEqual({type: "hello", v: PROTOCOL_VERSION, client: "me", name: "Ada", color: "#1971c2"});
        expect(parseClientMessage(change({t: "create", shape}))).toEqual({
            type: "change",
            change: {client: "me", n: 4, ops: [{t: "create", shape}]},
        });
    });

    // The room answers these by number, so the author rolls the change back
    // instead of waiting for ever on an edit that was never applied.
    it("names the change it cannot read", () => {
        expect(parseClientMessage(change({t: "create", shape: {...shape, stroke: "red"}}))).toEqual({type: "bad-change", n: 4});
        expect(parseClientMessage(change({t: "update", id: "s", patch: {w: Number.MAX_VALUE}}))).toEqual({type: "bad-change", n: 4});
        const tooMany = {type: "change", change: {client: "me", n: 9, ops: Array.from({length: 501}, () => ({t: "delete", id: "s"}))}};
        expect(parseClientMessage(JSON.stringify(tooMany))).toEqual({type: "bad-change", n: 9});
    });

    it("has nothing to say about a message with no change in it", () => {
        expect(parseClientMessage("not json at all")).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "change", change: {ops: []}}))).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "change", change: {client: "me", n: 0, ops: []}}))).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "presence", cursor: [1, "x"], selection: []}))).toBeNull();
    });
});
