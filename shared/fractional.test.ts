import {describe, expect, it} from "vitest";

import {isValidKey, keyBetween, keysBetween} from "./fractional";

describe("keyBetween", () => {
    it("starts an empty list at the first positive integer", () => {
        expect(keyBetween(null, null)).toBe("a0");
    });

    it("always lands strictly between its neighbours", () => {
        const cases: [string | null, string | null][] = [
            [null, "a0"],
            ["a0", null],
            ["a0", "a1"],
            ["a0", "a0V"],
            ["a0", "a05"],
            ["Zz", "a0"],
            ["az", null],
            ["a0V", "a1"],
            [null, "Zz"],
        ];
        for (const [before, after] of cases) {
            const key = keyBetween(before, after);
            expect(isValidKey(key), key).toBe(true);
            if (before !== null) expect(key > before, `${key} > ${before}`).toBe(true);
            if (after !== null) expect(key < after, `${key} < ${after}`).toBe(true);
        }
    });

    it("keeps a list ordered through thousands of random insertions", () => {
        let seed = 7;
        const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const keys: string[] = [];
        for (let i = 0; i < 3_000; i++) {
            const index = Math.floor(random() * (keys.length + 1));
            keys.splice(index, 0, keyBetween(keys[index - 1] ?? null, keys[index] ?? null));
        }
        const sorted = [...keys].sort();
        expect(keys).toEqual(sorted);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys.every(isValidKey)).toBe(true);
    });

    it("stays short when every new shape goes on top — the common case", () => {
        let key = keyBetween(null, null);
        for (let i = 0; i < 10_000; i++) key = keyBetween(key, null);
        expect(key.length).toBeLessThanOrEqual(4);
    });

    it("stays short when shapes keep being sent to the back", () => {
        let key = keyBetween(null, null);
        for (let i = 0; i < 10_000; i++) key = keyBetween(null, key);
        expect(key.length).toBeLessThanOrEqual(4);
    });

    it("refuses keys out of order or malformed", () => {
        expect(() => keyBetween("a1", "a0")).toThrow();
        expect(() => keyBetween("a0", "a0")).toThrow();
        expect(() => keyBetween("a00", null)).toThrow(); // trailing zero in the fraction
        expect(() => keyBetween("a!", null)).toThrow();
        expect(() => keyBetween("V", null)).toThrow(); // head says six characters
    });
});

describe("keysBetween", () => {
    it("returns ascending keys inside the gap", () => {
        const keys = keysBetween("a0", "a1", 25);
        expect(keys).toHaveLength(25);
        expect([...keys].sort()).toEqual(keys);
        expect(keys.every((key) => key > "a0" && key < "a1")).toBe(true);
    });
});
