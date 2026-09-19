import {describe, expect, it} from "vitest";

import {parseClientMessage} from "./protocol";
import {LIMITS, parseChange, parseShape} from "./validate";

const shape = {
    id: "abc",
    type: "rect",
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    stroke: "#112233",
    fill: null,
    strokeWidth: 2,
    z: "a0",
};

describe("parseShape", () => {
    it("accepts a well-formed shape", () => {
        expect(parseShape(shape)).toEqual(shape);
    });

    it.each([
        ["an unknown type", {...shape, type: "star"}],
        ["an unknown property", {...shape, onClick: "alert(1)"}],
        ["a missing property", (({z: _z, ...rest}) => rest)(shape)],
        ["a colour that is not a hex code", {...shape, stroke: "red"}],
        ["NaN", {...shape, x: Number.NaN}],
        ["an absurd coordinate", {...shape, x: LIMITS.coordinate * 10}],
        ["a stroke width of zero", {...shape, strokeWidth: 0}],
        ["a malformed order key", {...shape, z: "a00"}],
        ["an id with a slash", {...shape, id: "a/b"}],
        ["a pen stroke without points", {...shape, type: "pen"}],
        ["a note without text", {...shape, type: "note"}],
        ["points outside the box", {...shape, type: "pen", points: [0, 0, 1.5, 1]}],
        ["too many points", {...shape, type: "pen", points: new Array(LIMITS.penPoints * 2 + 2).fill(0.5)}],
        ["too much text", {...shape, type: "note", text: "x".repeat(LIMITS.text + 1)}],
    ])("rejects %s", (_label, value) => {
        expect(parseShape(value)).toBeNull();
    });
});

describe("parseChange", () => {
    it("rejects the whole change if one operation is bad", () => {
        const change = {
            client: "c1",
            n: 1,
            ops: [
                {t: "create", shape},
                {t: "update", id: "abc", patch: {x: "1"}},
            ],
        };
        expect(parseChange(change)).toBeNull();
    });

    it("rejects patches that try to change identity", () => {
        expect(parseChange({client: "c1", n: 1, ops: [{t: "update", id: "abc", patch: {type: "note"}}]})).toBeNull();
        expect(parseChange({client: "c1", n: 1, ops: [{t: "update", id: "abc", patch: {id: "other"}}]})).toBeNull();
    });

    it("rejects empty or oversized batches and bad counters", () => {
        expect(parseChange({client: "c1", n: 1, ops: []})).toBeNull();
        expect(parseChange({client: "c1", n: 0, ops: [{t: "delete", id: "abc"}]})).toBeNull();
        expect(parseChange({client: "c1", n: 1.5, ops: [{t: "delete", id: "abc"}]})).toBeNull();
        const many = new Array(LIMITS.opsPerChange + 1).fill({t: "delete", id: "abc"});
        expect(parseChange({client: "c1", n: 1, ops: many})).toBeNull();
    });
});

describe("parseClientMessage", () => {
    it("rejects junk, wrong versions and bad presence", () => {
        expect(parseClientMessage("not json")).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "hello", v: 99, client: "c", name: "n", color: "#000000"}))).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "presence", cursor: [1, "2"], selection: []}))).toBeNull();
        expect(parseClientMessage(JSON.stringify({type: "presence", cursor: null, selection: ["a b"]}))).toBeNull();
    });

    it("trims and caps names", () => {
        const message = parseClientMessage(
            JSON.stringify({type: "hello", v: 1, client: "c", name: `  ${"x".repeat(100)}  `, color: "#abcdef"}),
        );
        expect(message?.type === "hello" && message.name.length).toBe(32);
    });
});
