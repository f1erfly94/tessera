import {DurableObject} from "cloudflare:workers";

import {parseClientMessage, type Peer, type ServerMessage} from "../shared/protocol";
import {RoomCore} from "../shared/room-core";
import {handleChange, welcomeMessages} from "../shared/room-server";
import type {Shape} from "../shared/shape";
import {welcomeShapes} from "./welcome";

/** What each socket carries through hibernation. */
interface Attachment {
    peer: string;
    /** Set by the client's hello; until then the socket only receives, never counts as a peer. */
    client: string | null;
    name: string;
    color: string;
}

/** Changes are written to storage at most this often; see `flush`. */
const FLUSH_DELAY_MS = 1_000;
/** A room nobody has opened for this long is deleted. */
const IDLE_ROOM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONNECTIONS = 50;
const MAX_MESSAGE_CHARS = 512 * 1024;
/** Token bucket per socket: bursts of 240 messages, 120 a second sustained. */
const RATE_CAPACITY = 240;
const RATE_PER_SECOND = 120;

/**
 * One room: the authoritative board plus the sockets connected to it.
 *
 * The board lives in memory (RoomCore) and in this object's own SQLite. Every
 * message is handled to completion before the next starts — a Durable Object
 * is single-threaded — which is exactly the single ordering the sync design
 * needs, with no locks.
 *
 * Sockets use the hibernation API: when a room goes quiet the object can be
 * evicted from memory while its sockets stay open, and it is rebuilt from
 * storage on the next message.
 */
export class Room extends DurableObject<Env> {
    private core: RoomCore;
    private readonly dirtyShapes = new Set<string>();
    private readonly dirtyClients = new Set<string>();
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** Pointers and selections are ephemeral: memory only, gone after hibernation. */
    private readonly presence = new Map<string, Pick<Peer, "cursor" | "selection">>();
    private readonly buckets = new WeakMap<WebSocket, {tokens: number; at: number}>();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        const sql = ctx.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS shapes (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        sql.exec("CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, n INTEGER NOT NULL, seen INTEGER NOT NULL)");
        sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

        const seq = sql.exec<{value: string}>("SELECT value FROM meta WHERE key = 'seq'").toArray()[0];
        const shapes = sql
            .exec<{data: string}>("SELECT data FROM shapes")
            .toArray()
            .map((row) => JSON.parse(row.data) as Shape);
        const clients = sql
            .exec<{id: string; n: number}>("SELECT id, n FROM clients ORDER BY seen")
            .toArray()
            .map((row): [string, number] => [row.id, row.n]);
        this.core = RoomCore.restore({seq: seq ? Number(seq.value) : 0, shapes, clients});

        if (!seq) this.seed();
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    async fetch(request: Request): Promise<Response> {
        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket upgrade", {status: 426});
        }
        if (this.ctx.getWebSockets().length >= MAX_CONNECTIONS) {
            return new Response("This room is full", {status: 503});
        }

        const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({
            peer: crypto.randomUUID().slice(0, 8),
            client: null,
            name: "",
            color: "#000000",
        } satisfies Attachment);

        // Every visit pushes the room's expiry back.
        await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_TTL_MS);
        return new Response(null, {status: 101, webSocket: client});
    }

    async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
        if (typeof raw !== "string") return this.send(ws, {type: "error", message: "Binary messages are not supported."});
        if (raw.length > MAX_MESSAGE_CHARS) return ws.close(1009, "Message too big");
        if (!this.allow(ws)) return this.send(ws, {type: "error", message: "Too many messages — slow down."});

        const message = parseClientMessage(raw);
        if (!message) return this.send(ws, {type: "error", message: "Malformed message."});
        const attachment = ws.deserializeAttachment() as Attachment;

        switch (message.type) {
            case "hello": {
                attachment.client = message.client;
                attachment.name = message.name;
                attachment.color = message.color;
                ws.serializeAttachment(attachment);
                // Board and welcome go out in one synchronous run: no change can
                // slip in between the snapshot and the sequence number it is at.
                for (const reply of welcomeMessages(this.core, message.client, attachment.peer, this.peers(ws))) {
                    this.send(ws, reply);
                }
                this.broadcast({type: "presence", peer: this.peerOf(attachment)}, ws);
                return;
            }

            case "change": {
                // A client may only send changes under the id it said hello with;
                // otherwise it could advance someone else's counter and silently
                // swallow their next edits.
                if (attachment.client !== message.change.client) {
                    return this.send(ws, {type: "error", message: "Change from an unknown client."});
                }
                const outcome = handleChange(this.core, message.change);
                if (outcome.reply) this.send(ws, outcome.reply);
                if (outcome.broadcast) {
                    this.broadcast(outcome.broadcast);
                    for (const id of outcome.touched) this.dirtyShapes.add(id);
                    this.dirtyClients.add(message.change.client);
                    this.scheduleFlush();
                }
                return;
            }

            case "presence": {
                if (!attachment.client) return;
                this.presence.set(attachment.peer, {cursor: message.cursor, selection: message.selection});
                this.broadcast({type: "presence", peer: this.peerOf(attachment)}, ws);
                return;
            }
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        this.leave(ws);
        try {
            ws.close(code, reason);
        } catch {
            // Already closed.
        }
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        this.leave(ws);
    }

    async alarm(): Promise<void> {
        if (this.ctx.getWebSockets().length > 0) {
            await this.ctx.storage.setAlarm(Date.now() + IDLE_ROOM_TTL_MS);
            return;
        }
        await this.ctx.storage.deleteAll();
        this.core = new RoomCore();
        this.dirtyShapes.clear();
        this.dirtyClients.clear();
    }

    // ── Internals ────────────────────────────────────────────────────────────

    private seed() {
        const shapes = welcomeShapes();
        this.core.receive({client: "welcome", n: 1, ops: shapes.map((shape) => ({t: "create", shape}))});
        for (const shape of shapes) this.dirtyShapes.add(shape.id);
        this.flush();
    }

    private leave(ws: WebSocket) {
        const attachment = ws.deserializeAttachment() as Attachment | null;
        if (!attachment) return;
        this.presence.delete(attachment.peer);
        if (attachment.client) this.broadcast({type: "leave", id: attachment.peer}, ws);
        const others = this.ctx.getWebSockets().filter((socket) => socket !== ws);
        if (others.length === 0) this.flush();
    }

    /**
     * Writes what changed since the last flush.
     *
     * Write-behind rather than write-through: a drag is dozens of changes a
     * second to the same shape, and writing each one would spend the free
     * tier's daily row writes in minutes. Batching per second collapses them
     * into one row per shape. The price is that a crash can lose up to a second
     * of edits the clients were already told about — acceptable for a
     * whiteboard, and why the timer is short. The pending timer also keeps the
     * object from hibernating with unwritten changes.
     */
    private scheduleFlush() {
        this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    }

    private flush() {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (this.dirtyShapes.size === 0 && this.dirtyClients.size === 0) return;

        const sql = this.ctx.storage.sql;
        this.ctx.storage.transactionSync(() => {
            for (const id of this.dirtyShapes) {
                const shape = this.core.shapes.get(id);
                if (shape) {
                    sql.exec(
                        "INSERT INTO shapes (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
                        id,
                        JSON.stringify(shape),
                    );
                } else {
                    sql.exec("DELETE FROM shapes WHERE id = ?", id);
                }
            }
            for (const client of this.dirtyClients) {
                sql.exec(
                    "INSERT INTO clients (id, n, seen) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n, seen = excluded.seen",
                    client,
                    this.core.lastAppliedFor(client),
                    this.core.seq,
                );
            }
            sql.exec(
                "INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                String(this.core.seq),
            );
            // Keep the de-duplication table as bounded as the in-memory one.
            sql.exec(
                "DELETE FROM clients WHERE id NOT IN (SELECT id FROM clients ORDER BY seen DESC LIMIT 2000)",
            );
        });
        this.dirtyShapes.clear();
        this.dirtyClients.clear();
    }

    private allow(ws: WebSocket): boolean {
        const now = Date.now();
        const bucket = this.buckets.get(ws) ?? {tokens: RATE_CAPACITY, at: now};
        bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * RATE_PER_SECOND);
        bucket.at = now;
        this.buckets.set(ws, bucket);
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }

    private peerOf(attachment: Attachment): Peer {
        const presence = this.presence.get(attachment.peer);
        return {
            id: attachment.peer,
            name: attachment.name,
            color: attachment.color,
            cursor: presence?.cursor ?? null,
            selection: presence?.selection ?? [],
        };
    }

    private peers(except: WebSocket): Peer[] {
        return this.ctx
            .getWebSockets()
            .filter((ws) => ws !== except)
            .map((ws) => ws.deserializeAttachment() as Attachment)
            .filter((attachment) => attachment.client !== null)
            .map((attachment) => this.peerOf(attachment));
    }

    private send(ws: WebSocket, message: ServerMessage) {
        try {
            ws.send(JSON.stringify(message));
        } catch {
            // The socket closed under us; its close handler cleans up.
        }
    }

    /** To every socket that has said hello, optionally skipping one. */
    private broadcast(message: ServerMessage, except?: WebSocket) {
        const data = JSON.stringify(message);
        for (const ws of this.ctx.getWebSockets()) {
            if (ws === except) continue;
            const attachment = ws.deserializeAttachment() as Attachment | null;
            if (!attachment?.client) continue;
            try {
                ws.send(data);
            } catch {
                // Closing; ignore.
            }
        }
    }
}
