import {applyChange, type Change, Overlay} from "./doc";
import type {Shape} from "./shape";

/**
 * The authoritative board of one room, with no Cloudflare in it.
 *
 * The Durable Object wraps this class with sockets and storage; the tests drive
 * it directly, next to simulated clients, to check that everyone converges. The
 * server's one job is to put changes in a single order and apply each exactly
 * once — conflict resolution is nothing more than that order.
 */
export interface RoomLimits {
    maxShapes: number;
    /** Approximate JSON size of the whole board. */
    maxBytes: number;
    /** How many clients' "last applied" counters to remember. */
    maxClients: number;
}

export const DEFAULT_ROOM_LIMITS: RoomLimits = {
    maxShapes: 3_000,
    maxBytes: 6_000_000,
    maxClients: 2_000,
};

export type ReceiveResult =
    | {status: "applied"; seq: number; touched: Set<string>}
    | {status: "duplicate"}
    | {status: "rejected"; reason: string};

export interface RoomState {
    seq: number;
    shapes: Iterable<Shape>;
    clients: Iterable<[string, number]>;
}

const sizeOf = (shape: Shape) => JSON.stringify(shape).length;

export class RoomCore {
    readonly shapes = new Map<string, Shape>();
    seq = 0;
    bytes = 0;

    /** Highest change number applied per client. Map order doubles as recency. */
    private readonly lastApplied = new Map<string, number>();
    private readonly sizes = new Map<string, number>();

    constructor(private readonly limits: RoomLimits = DEFAULT_ROOM_LIMITS) {}

    static restore(state: RoomState, limits?: RoomLimits): RoomCore {
        const room = new RoomCore(limits);
        room.seq = state.seq;
        for (const shape of state.shapes) room.put(shape);
        for (const [client, n] of state.clients) room.lastApplied.set(client, n);
        return room;
    }

    lastAppliedFor(client: string): number {
        return this.lastApplied.get(client) ?? 0;
    }

    clients(): [string, number][] {
        return [...this.lastApplied];
    }

    /**
     * Applies a change unless it was applied before or would push the room over
     * its limits. Limits only refuse growth: a change that deletes or shrinks is
     * always accepted, so a full room can still be tidied up.
     */
    receive(change: Change): ReceiveResult {
        if (change.n <= this.lastAppliedFor(change.client)) return {status: "duplicate"};

        const draft = new Overlay(this.shapes);
        const touched = applyChange(draft, change);

        let count = this.shapes.size;
        let bytes = this.bytes;
        for (const id of touched) {
            const before = this.shapes.get(id);
            const after = draft.get(id);
            if (!before && after) count++;
            if (before && !after) count--;
            bytes += (after ? sizeOf(after) : 0) - (before ? (this.sizes.get(id) ?? 0) : 0);
        }
        if (count > this.limits.maxShapes && count > this.shapes.size) {
            return {status: "rejected", reason: `This board is full (${this.limits.maxShapes} shapes).`};
        }
        if (bytes > this.limits.maxBytes && bytes > this.bytes) {
            return {status: "rejected", reason: "This board has reached its size limit."};
        }

        for (const id of touched) {
            const after = draft.get(id);
            if (after) this.put(after);
            else this.remove(id);
        }
        this.seq++;
        this.remember(change.client, change.n);
        return {status: "applied", seq: this.seq, touched};
    }

    private put(shape: Shape) {
        this.bytes -= this.sizes.get(shape.id) ?? 0;
        const size = sizeOf(shape);
        this.sizes.set(shape.id, size);
        this.bytes += size;
        this.shapes.set(shape.id, shape);
    }

    private remove(id: string) {
        this.bytes -= this.sizes.get(id) ?? 0;
        this.sizes.delete(id);
        this.shapes.delete(id);
    }

    private remember(client: string, n: number) {
        this.lastApplied.delete(client);
        this.lastApplied.set(client, n);
        while (this.lastApplied.size > this.limits.maxClients) {
            const oldest = this.lastApplied.keys().next().value;
            if (oldest === undefined) break;
            this.lastApplied.delete(oldest);
        }
    }
}
