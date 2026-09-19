import {describe, expect, it} from "vitest";

import {applyChange, applyOp, type Doc, invertOps, type Op} from "./doc";
import type {Shape} from "./shape";

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

describe("applyOp", () => {
    it("ignores a second create of the same id", () => {
        const doc: Doc = new Map();
        expect(applyOp(doc, {t: "create", shape: rect("a", 1)})).toBe(true);
        expect(applyOp(doc, {t: "create", shape: rect("a", 2)})).toBe(false);
        expect(doc.get("a")?.x).toBe(1);
    });

    it("lets an edit that lost the race with a delete disappear", () => {
        const doc: Doc = new Map([["a", rect("a")]]);
        applyOp(doc, {t: "delete", id: "a"});
        expect(applyOp(doc, {t: "update", id: "a", patch: {x: 5}})).toBe(false);
        expect(doc.has("a")).toBe(false);
    });

    it("replaces shapes instead of mutating them", () => {
        const original = rect("a");
        const doc: Doc = new Map([["a", original]]);
        applyOp(doc, {t: "update", id: "a", patch: {x: 5}});
        expect(original.x).toBe(0);
        expect(doc.get("a")).not.toBe(original);
    });
});

describe("invertOps", () => {
    it("undoes a mixed batch exactly, including edits to shapes it created", () => {
        const doc: Doc = new Map([
            ["a", rect("a", 1)],
            ["b", rect("b", 2)],
        ]);
        const before = new Map(doc);
        const ops: Op[] = [
            {t: "create", shape: rect("c", 3)},
            {t: "update", id: "c", patch: {x: 30}},
            {t: "update", id: "a", patch: {x: 10, stroke: "#ff0000"}},
            {t: "delete", id: "b"},
        ];
        const inverse = invertOps(doc, ops);
        applyChange(doc, {client: "x", n: 1, ops});
        applyChange(doc, {client: "x", n: 2, ops: inverse});
        expect(doc).toEqual(before);
    });

    it("skips what cannot be undone because it is already gone", () => {
        const doc: Doc = new Map();
        expect(invertOps(doc, [{t: "update", id: "missing", patch: {x: 1}}])).toEqual([]);
    });
});
