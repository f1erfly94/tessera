import {compareShapes, type Shape} from "../../shared/shape";

/**
 * The board in painting order, kept sorted incrementally.
 *
 * Re-sorting ten thousand shapes on every frame of a drag costs milliseconds
 * the frame does not have, and a drag never changes the order anyway. So each
 * touched shape is found by binary search on its previous version and either
 * swapped in place (order key unchanged — the common case) or moved.
 */
export class SortedShapes {
    private items: Shape[] = [];
    /** The exact object currently stored for each id, needed to find it again. */
    private readonly stored = new Map<string, Shape>();

    get all(): readonly Shape[] {
        return this.items;
    }

    reset(doc: ReadonlyMap<string, Shape>) {
        this.items = [...doc.values()].sort(compareShapes);
        this.stored.clear();
        for (const shape of this.items) this.stored.set(shape.id, shape);
    }

    update(doc: ReadonlyMap<string, Shape>, touched: Iterable<string>) {
        for (const id of touched) {
            const previous = this.stored.get(id);
            const next = doc.get(id);
            if (previous === next) continue;

            if (previous && next && previous.z === next.z) {
                this.items[this.indexOf(previous)] = next;
                this.stored.set(id, next);
                continue;
            }
            if (previous) {
                this.items.splice(this.indexOf(previous), 1);
                this.stored.delete(id);
            }
            if (next) {
                this.items.splice(this.insertionPoint(next), 0, next);
                this.stored.set(id, next);
            }
        }
    }

    private indexOf(shape: Shape): number {
        let low = 0;
        let high = this.items.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const order = compareShapes(this.items[middle]!, shape);
            if (order === 0) return middle;
            if (order < 0) low = middle + 1;
            else high = middle - 1;
        }
        throw new Error(`Shape ${shape.id} is not in the sorted list`);
    }

    private insertionPoint(shape: Shape): number {
        let low = 0;
        let high = this.items.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (compareShapes(this.items[middle]!, shape) < 0) low = middle + 1;
            else high = middle;
        }
        return low;
    }
}
