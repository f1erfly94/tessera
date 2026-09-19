import {applyChange, applyOp, type Change, type Doc, type Op, opTarget} from "../../shared/doc";
import {type ClientMessage, type Peer, PROTOCOL_VERSION, type ServerMessage} from "../../shared/protocol";
import type {Shape, ShapePatch, ShapeProp} from "../../shared/shape";

/**
 * The client half of synchronisation, with no socket in it.
 *
 * Two boards are kept:
 * - `confirmed` — the server's board, as of the last change it sent;
 * - `view` — what this person sees: `confirmed` plus their own changes the
 *   server has not acknowledged yet, applied optimistically.
 *
 * Remote changes land on both. On `view`, a remote write to a property this
 * client is still waiting to hear back about is skipped: the server orders our
 * change after the remote one, so ours is what the board will end up with, and
 * showing the remote value in between would make the shape flicker back.
 */
export interface SyncClientOptions {
    clientId: string;
    name: string;
    color: string;
    /** Last change number used, so a reloaded tab never reuses one. */
    counter?: number;
    /** Unacknowledged changes from an earlier session, oldest first. */
    pending?: Change[];
    /** The last board this device saw, shown until the server's arrives. */
    cached?: Shape[];
}

export type DocChange = Set<string> | "all";

export interface SyncEvents {
    /** The visible board changed: these ids, or everything. */
    doc?: (touched: DocChange) => void;
    peers?: () => void;
    /** Pending changes changed: persist them if you want offline edits to survive a reload. */
    pending?: (pending: readonly Change[], counter: number) => void;
    /** The server refused a change of ours; it has been rolled back. */
    rejected?: (reason: string) => void;
    /** The stream from the server skipped a number: reconnect to resynchronise. */
    resync?: () => void;
}

type Mask = Map<ShapeProp | "*", number>;

export class SyncClient {
    readonly clientId: string;
    name: string;
    color: string;

    confirmed: Doc;
    view: Doc;
    seq = 0;
    /** Welcome received on the current connection. */
    synced = false;
    peers = new Map<string, Peer>();
    /** This connection's peer id, as the server named it. */
    you: string | null = null;

    private counter: number;
    private pending: Change[];
    /** How many of `pending`, from the front, went out on the current connection. */
    private sent = 0;
    /** Coalescing key of the last pending change, while it is still unsent. */
    private openKey: string | null = null;
    private masks = new Map<string, Mask>();
    private transport: ((message: ClientMessage) => void) | null = null;
    private snapshotParts: Shape[] = [];

    constructor(
        options: SyncClientOptions,
        private readonly events: SyncEvents = {},
    ) {
        this.clientId = options.clientId;
        this.name = options.name;
        this.color = options.color;
        this.counter = Math.max(options.counter ?? 0, ...(options.pending ?? []).map((change) => change.n));
        this.pending = [...(options.pending ?? [])];
        this.confirmed = new Map((options.cached ?? []).map((shape) => [shape.id, shape]));
        this.view = new Map();
        this.rebuildView();
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    get pendingChanges(): readonly Change[] {
        return this.pending;
    }

    get lastCounter(): number {
        return this.counter;
    }

    // ── Local edits ──────────────────────────────────────────────────────────

    /**
     * Applies `ops` to the view straight away and queues them for the server.
     *
     * With `coalesce`, consecutive commits under the same key merge into one
     * change for as long as it has not been sent — a drag is sixty updates a
     * second on screen but only as many messages as `flush` is called.
     */
    commit(ops: Op[], coalesce?: string): void {
        if (ops.length === 0) return;

        const last = this.pending.at(-1);
        if (coalesce && last && this.openKey === coalesce && this.pending.length > this.sent) {
            this.unmask(last);
            last.ops = mergeOps(last.ops, ops);
            this.mask(last);
        } else {
            const change: Change = {client: this.clientId, n: ++this.counter, ops};
            this.pending.push(change);
            this.mask(change);
            this.openKey = coalesce ?? null;
        }

        const touched = new Set<string>();
        for (const op of ops) if (applyOp(this.view, op)) touched.add(opTarget(op));
        this.events.doc?.(touched);
        this.events.pending?.(this.pending, this.counter);
    }

    /** Sends every queued change that has not gone out on this connection yet. */
    flush(): void {
        if (!this.transport || !this.synced) return;
        while (this.sent < this.pending.length) {
            this.transport({type: "change", change: this.pending[this.sent]!});
            this.sent++;
        }
        this.openKey = null;
    }

    sendPresence(cursor: [number, number] | null, selection: string[]): void {
        if (this.transport && this.synced) this.transport({type: "presence", cursor, selection});
    }

    // ── Transport ────────────────────────────────────────────────────────────

    connected(send: (message: ClientMessage) => void): void {
        this.transport = send;
        this.synced = false;
        this.sent = 0;
        this.snapshotParts = [];
        send({type: "hello", v: PROTOCOL_VERSION, client: this.clientId, name: this.name, color: this.color});
    }

    disconnected(): void {
        this.transport = null;
        this.synced = false;
        this.sent = 0;
        this.openKey = null;
        this.snapshotParts = [];
        this.you = null;
        if (this.peers.size > 0) {
            this.peers.clear();
            this.events.peers?.();
        }
    }

    receive(message: ServerMessage): void {
        switch (message.type) {
            case "snapshot":
                for (const shape of message.shapes) this.snapshotParts.push(shape);
                return;

            case "welcome": {
                this.confirmed = new Map(this.snapshotParts.map((shape) => [shape.id, shape]));
                this.snapshotParts = [];
                this.seq = message.seq;
                this.you = message.you;
                this.peers = new Map(message.peers.map((peer) => [peer.id, peer]));
                // Whatever the server applied before we lost the connection is already
                // in the snapshot; re-sending it would only earn a "duplicate".
                this.pending = this.pending.filter((change) => change.n > message.lastApplied);
                this.synced = true;
                this.sent = 0;
                this.rebuildView();
                this.events.peers?.();
                this.events.pending?.(this.pending, this.counter);
                this.flush();
                return;
            }

            case "change": {
                if (!this.synced) return;
                if (message.seq !== this.seq + 1) {
                    this.events.resync?.();
                    return;
                }
                this.seq = message.seq;
                applyChange(this.confirmed, message.change);

                if (message.change.client === this.clientId) {
                    // Our own change, now in its final place in the order. The view
                    // already shows it.
                    this.acknowledge(message.change.n);
                } else {
                    // Applied first, reported second: `doc?.(apply())` would skip the
                    // apply whenever nobody is listening.
                    const touched = this.applyRemote(message.change);
                    this.events.doc?.(touched);
                }
                return;
            }

            case "reject": {
                const index = this.pending.findIndex((change) => change.n === message.n);
                if (index !== -1) {
                    this.pending.splice(index, 1);
                    if (index < this.sent) this.sent--;
                    this.rebuildView();
                    this.events.pending?.(this.pending, this.counter);
                }
                this.events.rejected?.(message.reason);
                return;
            }

            case "duplicate":
                this.acknowledge(message.n);
                return;

            case "presence":
                if (message.peer.id !== this.you) {
                    this.peers.set(message.peer.id, message.peer);
                    this.events.peers?.();
                }
                return;

            case "leave":
                if (this.peers.delete(message.id)) this.events.peers?.();
                return;

            case "error":
                return;
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /** Drops every pending change up to and including `n`: the server has it. */
    private acknowledge(n: number): void {
        let dropped = 0;
        while (this.pending.length > 0 && this.pending[0]!.n <= n) {
            this.unmask(this.pending.shift()!);
            dropped++;
        }
        this.sent = Math.max(0, this.sent - dropped);
        if (dropped === 0) return;
        // More than one at once means changes were settled out of the usual
        // one-ack-per-change rhythm (a duplicate after a reconnect); rebuild
        // rather than trust that the optimistic view still matches.
        if (dropped > 1) this.rebuildView();
        this.events.pending?.(this.pending, this.counter);
    }

    /** Applies someone else's change to the view, skipping what our pending changes mask. */
    private applyRemote(change: Change): Set<string> {
        const touched = new Set<string>();
        for (const op of change.ops) {
            const id = opTarget(op);
            const mask = this.masks.get(id);

            if (op.t === "update") {
                if (mask?.has("*")) continue;
                let patch: ShapePatch = op.patch;
                if (mask) {
                    const visible: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(op.patch)) {
                        if (!mask.has(key as ShapeProp)) visible[key] = value;
                    }
                    if (Object.keys(visible).length === 0) continue;
                    patch = visible as ShapePatch;
                }
                if (applyOp(this.view, {t: "update", id, patch})) touched.add(id);
            } else if (applyOp(this.view, op)) {
                touched.add(id);
            }
        }
        return touched;
    }

    private rebuildView(): void {
        this.view = new Map(this.confirmed);
        this.masks = new Map();
        for (const change of this.pending) {
            applyChange(this.view, change);
            this.mask(change);
        }
        this.events.doc?.("all");
    }

    private mask(change: Change): void {
        this.adjustMasks(change, 1);
    }

    private unmask(change: Change): void {
        this.adjustMasks(change, -1);
    }

    private adjustMasks(change: Change, delta: 1 | -1): void {
        for (const op of change.ops) {
            if (op.t === "create") continue;
            const id = opTarget(op);
            const keys: (ShapeProp | "*")[] = op.t === "delete" ? ["*"] : (Object.keys(op.patch) as ShapeProp[]);
            let mask = this.masks.get(id);
            if (!mask) {
                if (delta < 0) continue;
                mask = new Map();
                this.masks.set(id, mask);
            }
            for (const key of keys) {
                const count = (mask.get(key) ?? 0) + delta;
                if (count > 0) mask.set(key, count);
                else mask.delete(key);
            }
            if (mask.size === 0) this.masks.delete(id);
        }
    }
}

/**
 * Appends `next` to `ops`, folding an update into the last operation on the same
 * shape when that one is an update too. Nothing after that operation touches
 * the shape, so merging it in place keeps the batch's meaning.
 */
export const mergeOps = (ops: Op[], next: Op[]): Op[] => {
    const merged = [...ops];
    for (const op of next) {
        if (op.t === "update") {
            let lastIndex = -1;
            for (let index = merged.length - 1; index >= 0; index--) {
                if (opTarget(merged[index]!) === op.id) {
                    lastIndex = index;
                    break;
                }
            }
            const previous = lastIndex === -1 ? undefined : merged[lastIndex];
            if (previous?.t === "update") {
                merged[lastIndex] = {t: "update", id: op.id, patch: {...previous.patch, ...op.patch}};
                continue;
            }
            if (previous?.t === "create") {
                merged[lastIndex] = {t: "create", shape: {...previous.shape, ...op.patch}};
                continue;
            }
        }
        merged.push(op);
    }
    return merged;
};
