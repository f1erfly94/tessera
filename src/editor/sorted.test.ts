import {describe, expect, it} from "vitest";

import {keyBetween} from "../../shared/fractional";
import {compareShapes, type Shape} from "../../shared/shape";
import {SortedShapes} from "./sorted";

const shape = (id: string, z: string, x = 0): Shape => ({
    id,
    type: "rect",
    x,
    y: 0,
    w: 1,
    h: 1,
    stroke: "#000000",
    fill: null,
    strokeWidth: 1,
    z,
});

describe("SortedShapes", () => {
    it("matches a full sort after random creates, moves, reorders and deletes", () => {
        let seed = 42;
        const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const doc = new Map<string, Shape>();
        const sorted = new SortedShapes();
        sorted.reset(doc);

        for (let step = 0; step < 4_000; step++) {
            const ids = [...doc.keys()];
            const roll = random();
            let touched: string;
            if (roll < 0.4 || ids.length === 0) {
                touched = `s${step}`;
                // Deliberately collide order keys sometimes: ties break by id.
                doc.set(touched, shape(touched, random() < 0.2 ? "a0" : keyBetween("a0", null)));
            } else if (roll < 0.7) {
                touched = ids[Math.floor(random() * ids.length)]!;
                doc.set(touched, {...doc.get(touched)!, x: step});
            } else if (roll < 0.9) {
                touched = ids[Math.floor(random() * ids.length)]!;
                const keys = [...doc.values()].sort(compareShapes).map((item) => item.z);
                const index = Math.floor(random() * keys.length);
                const before = keys[index] ?? null;
                const after = keys[index + 1] ?? null;
                const z = before && after && before < after ? keyBetween(before, after) : keyBetween(before, null);
                doc.set(touched, {...doc.get(touched)!, z});
            } else {
                touched = ids[Math.floor(random() * ids.length)]!;
                doc.delete(touched);
            }
            sorted.update(doc, [touched]);
        }

        expect(sorted.all).toEqual([...doc.values()].sort(compareShapes));
    });
});
