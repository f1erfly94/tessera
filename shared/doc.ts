import type {Shape, ShapePatch, ShapeProp} from "./shape";

/**
 * The shared document is a map of shapes by id, and every edit to it is one of
 * three operations. The server and every client apply them with the same
 * function, so given the same operations in the same order they cannot end up
 * with different boards.
 */
export type Doc = Map<string, Shape>;

/** The part of Map that applying an operation needs, so it can also run on an overlay. */
export interface DocLike {
    get(id: string): Shape | undefined;
    has(id: string): boolean;
    set(id: string, shape: Shape): unknown;
    delete(id: string): boolean;
}

export type Op =
    | {t: "create"; shape: Shape}
    | {t: "update"; id: string; patch: ShapePatch}
    | {t: "delete"; id: string};

/**
 * An atomic batch of operations from one client. `n` counts up per client, so
 * the server can apply each change exactly once however often it is re-sent.
 */
export interface Change {
    client: string;
    n: number;
    ops: Op[];
}

/**
 * Applies one operation in place. The rules are what make the board converge:
 *
 * - creating an id that exists is a no-op, so a re-sent create cannot duplicate;
 * - updating or deleting a shape that is gone is a no-op, so an edit that loses a
 *   race with a delete simply disappears instead of resurrecting the shape.
 *
 * Shapes are replaced, never mutated, so anything caching by object identity
 * (the renderer's paths, React) sees exactly which shapes changed.
 */
export const applyOp = (doc: DocLike, op: Op): boolean => {
    switch (op.t) {
        case "create": {
            if (doc.has(op.shape.id)) return false;
            doc.set(op.shape.id, op.shape);
            return true;
        }
        case "update": {
            const shape = doc.get(op.id);
            if (!shape) return false;
            doc.set(op.id, {...shape, ...op.patch});
            return true;
        }
        case "delete":
            return doc.delete(op.id);
    }
};

/** Applies a whole change in order; returns the ids of shapes that were touched. */
export const applyChange = (doc: DocLike, change: Change): Set<string> => {
    const touched = new Set<string>();
    for (const op of change.ops) {
        if (applyOp(doc, op)) touched.add(op.t === "create" ? op.shape.id : op.id);
    }
    return touched;
};

export const opTarget = (op: Op): string => (op.t === "create" ? op.shape.id : op.id);

/** The properties an operation writes: every one for a create or delete, the patch keys for an update. */
export const opProps = (op: Op): ShapeProp[] | "all" =>
    op.t === "update" ? (Object.keys(op.patch) as ShapeProp[]) : "all";

/**
 * The operation that undoes `op`, computed against the document as it was just
 * before `op` ran. Returns null when there is nothing to undo (the shape was
 * already gone).
 */
export const invertOp = (doc: DocLike, op: Op): Op | null => {
    switch (op.t) {
        case "create":
            return {t: "delete", id: op.shape.id};
        case "delete": {
            const shape = doc.get(op.id);
            return shape ? {t: "create", shape} : null;
        }
        case "update": {
            const shape = doc.get(op.id);
            if (!shape) return null;
            const previous: Record<string, unknown> = {};
            for (const key of Object.keys(op.patch) as ShapeProp[]) previous[key] = shape[key];
            return {t: "update", id: op.id, patch: previous as ShapePatch};
        }
    }
};

/** Inverse of a list of operations: each one inverted, in reverse order. */
export const invertOps = (doc: ReadonlyMap<string, Shape>, ops: Op[]): Op[] => {
    // Invert against an overlay that moves forward op by op, so an op that edits
    // a shape created earlier in the same batch still finds it — without copying
    // a board of thousands of shapes on every drag frame.
    const scratch = new Overlay(doc);
    const inverse: Op[] = [];
    for (const op of ops) {
        const undo = invertOp(scratch, op);
        if (undo) inverse.push(undo);
        applyOp(scratch, op);
    }
    return inverse.reverse();
};

/** A copy-on-write view over a document: reads fall through, writes stay local. */
export class Overlay implements DocLike {
    private readonly changes = new Map<string, Shape | null>();

    constructor(private readonly base: ReadonlyMap<string, Shape>) {}

    get(id: string): Shape | undefined {
        const changed = this.changes.get(id);
        return changed === undefined ? this.base.get(id) : (changed ?? undefined);
    }

    has(id: string): boolean {
        return this.get(id) !== undefined;
    }

    set(id: string, shape: Shape): this {
        this.changes.set(id, shape);
        return this;
    }

    delete(id: string): boolean {
        const existed = this.has(id);
        this.changes.set(id, null);
        return existed;
    }
}
