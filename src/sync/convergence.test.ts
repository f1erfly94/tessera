import {describe, expect, it} from "vitest";

import {applyChange, type Doc, type Op} from "../../shared/doc";
import {keyBetween} from "../../shared/fractional";
import type {ClientMessage, ServerMessage} from "../../shared/protocol";
import {RoomCore} from "../../shared/room-core";
import {handleChange, welcomeMessages} from "../../shared/room-server";
import {compareShapes, type Shape, type ShapePatch} from "../../shared/shape";
import {SyncClient} from "./sync-client";

/**
 * Several clients editing one board through a hostile network: messages arrive
 * late and in random interleavings (but in order per connection, like a real
 * WebSocket), connections drop with messages in flight, and the room refuses
 * changes once it is full. At the end, once everyone is back and every message
 * is delivered, every client must see exactly the server's board.
 *
 * Along the way it also checks the invariant the whole design rests on: a
 * client's view always equals the server's board it knows about plus its own
 * pending changes replayed on top — the optimistic shortcuts never drift.
 */

const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** JSON with sorted keys, so two equal shapes built in different orders compare equal. */
const canonical = (doc: ReadonlyMap<string, Shape>) =>
    JSON.stringify(
        [...doc.values()]
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((shape) => Object.fromEntries(Object.entries(shape).sort(([a], [b]) => (a < b ? -1 : 1)))),
    );

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Connection {
    id: string;
    client: SimClient;
    toServer: ClientMessage[];
    toClient: ServerMessage[];
    ready: boolean;
}

interface SimClient {
    sync: SyncClient;
    connection: Connection | null;
    created: number;
    /** Recent events, printed when an assertion about this client fails. */
    trace: string[];
}

const log = (client: SimClient, event: string) => {
    client.trace.push(event);
    if (client.trace.length > 40) client.trace.shift();
};

const describeMessage = (message: ClientMessage | ServerMessage) =>
    message.type === "change"
        ? `change ${"seq" in message ? `#${message.seq} ` : ""}${message.change.client}/${message.change.n} ${JSON.stringify(message.change.ops)}`
        : message.type === "snapshot"
          ? `snapshot ${message.shapes.map((shape) => shape.id).join(",")}`
          : JSON.stringify(message);

const COLORS = ["#111111", "#e03131", "#2f9e44", "#1971c2"];

const simulate = (seed: number, steps: number) => {
    const random = mulberry32(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

    // Small limits, so refusals happen and get exercised.
    const core = new RoomCore({maxShapes: 40, maxBytes: 12_000, maxClients: 100});
    const connections = new Set<Connection>();
    let connectionCount = 0;
    let rejections = 0;

    const clients: SimClient[] = ["a", "b", "c", "d"].slice(0, 2 + Math.floor(random() * 3)).map((name) => {
        const sim: SimClient = {sync: null as unknown as SyncClient, connection: null, created: 0, trace: []};
        sim.sync = new SyncClient(
            {clientId: `client-${name}`, name, color: "#000000"},
            {rejected: () => rejections++},
        );
        return sim;
    });

    const connect = (client: SimClient) => {
        const connection: Connection = {id: `conn-${++connectionCount}`, client, toServer: [], toClient: [], ready: false};
        connections.add(connection);
        client.connection = connection;
        log(client, `connect ${connection.id}`);
        client.sync.connected((message) => {
            log(client, `send ${describeMessage(message)}`);
            connection.toServer.push(clone(message));
        });
    };

    const disconnect = (client: SimClient) => {
        if (!client.connection) return;
        // Anything in flight in either direction is lost with the socket.
        log(client, "disconnect");
        connections.delete(client.connection);
        client.connection = null;
        client.sync.disconnected();
    };

    const serverReceive = (connection: Connection, message: ClientMessage) => {
        if (message.type === "hello") {
            connection.ready = true;
            connection.toClient.push(...clone(welcomeMessages(core, message.client, connection.id, [])));
            return;
        }
        if (message.type !== "change") return;
        const outcome = handleChange(core, message.change);
        if (outcome.reply) connection.toClient.push(clone(outcome.reply));
        if (outcome.broadcast) {
            for (const other of connections) if (other.ready) other.toClient.push(clone(outcome.broadcast));
        }
    };

    const randomPatch = (shape: Shape, view: Doc): ShapePatch => {
        const patch: ShapePatch = {};
        if (random() < 0.5) patch.x = Math.round(random() * 1000);
        if (random() < 0.5) patch.y = Math.round(random() * 1000);
        if (random() < 0.3) patch.w = Math.round(1 + random() * 200);
        if (random() < 0.3) patch.stroke = pick(COLORS);
        if (random() < 0.2) patch.fill = random() < 0.5 ? null : pick(COLORS);
        if (random() < 0.2) {
            // Move it somewhere in the stacking order.
            const sorted = [...view.values()].sort(compareShapes).filter((other) => other.id !== shape.id);
            const index = Math.floor(random() * (sorted.length + 1));
            const before = sorted[index - 1]?.z ?? null;
            const after = sorted[index]?.z ?? null;
            patch.z = before !== null && after !== null && before >= after ? keyBetween(before, null) : keyBetween(before, after);
        }
        if (Object.keys(patch).length === 0) patch.x = shape.x + 1;
        return patch;
    };

    const edit = (client: SimClient) => {
        const view = client.sync.view;
        const shapes = [...view.values()];
        const roll = random();

        if (roll < 0.35 || shapes.length === 0) {
            const top = shapes.sort(compareShapes).at(-1)?.z ?? null;
            const shape: Shape = {
                id: `${client.sync.clientId}-${++client.created}`,
                type: "rect",
                x: Math.round(random() * 1000),
                y: Math.round(random() * 1000),
                w: 50,
                h: 50,
                stroke: pick(COLORS),
                fill: null,
                strokeWidth: 2,
                z: keyBetween(top, null),
            };
            client.sync.commit([{t: "create", shape}]);
        } else if (roll < 0.75) {
            const shape = pick(shapes);
            client.sync.commit([{t: "update", id: shape.id, patch: randomPatch(shape, view)}]);
        } else if (roll < 0.9) {
            // A drag: several updates coalesced into one change until the next flush.
            const shape = pick(shapes);
            const moves = 2 + Math.floor(random() * 4);
            for (let move = 0; move < moves; move++) {
                client.sync.commit([{t: "update", id: shape.id, patch: {x: shape.x + move, y: shape.y - move}}], "drag");
                if (random() < 0.3) client.sync.flush();
            }
        } else {
            const ops: Op[] = shapes.slice(0, 1 + Math.floor(random() * 2)).map((shape) => ({t: "delete", id: shape.id}));
            client.sync.commit(ops);
        }
    };

    const deliverOne = (): boolean => {
        const busy = [...connections].filter((connection) => connection.toServer.length || connection.toClient.length);
        if (busy.length === 0) return false;
        const connection = pick(busy);
        const toServer = connection.toServer.length > 0 && (connection.toClient.length === 0 || random() < 0.5);
        if (toServer) serverReceive(connection, connection.toServer.shift()!);
        else {
            const message = connection.toClient.shift()!;
            log(connection.client, `recv ${describeMessage(message)}`);
            connection.client.sync.receive(message);
        }
        return true;
    };

    const checkInvariant = () => {
        for (const client of clients) {
            const replay: Doc = new Map(client.sync.confirmed);
            for (const change of client.sync.pendingChanges) applyChange(replay, change);
            expect(
                canonical(client.sync.view),
                `seed ${seed}: ${client.sync.clientId} view drifted from confirmed + pending\n${client.trace.join("\n")}`,
            ).toBe(canonical(replay));
        }
    };

    clients.forEach(connect);

    for (let step = 0; step < steps; step++) {
        const client = pick(clients);
        const roll = random();
        if (roll < 0.45) deliverOne();
        else if (roll < 0.75) edit(client);
        else if (roll < 0.9) client.sync.flush();
        else if (roll < 0.95) disconnect(client);
        else if (!client.connection) connect(client);

        if (step % 5 === 0) checkInvariant();
    }

    // Everyone comes back and the network drains.
    for (const client of clients) if (!client.connection) connect(client);
    for (let round = 0; round < 1_000; round++) {
        clients.forEach((client) => client.sync.flush());
        let delivered = false;
        while (deliverOne()) delivered = true;
        if (!delivered && clients.every((client) => client.sync.pendingCount === 0)) break;
    }

    checkInvariant();
    return {core, clients, rejections};
};

describe("convergence under a hostile network", () => {
    const SEEDS = 120;

    it(`every client ends on the server's board (${SEEDS} random runs)`, () => {
        let totalRejections = 0;
        let totalShapes = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
            const {core, clients, rejections} = simulate(seed, 500);
            const expected = canonical(core.shapes);
            for (const client of clients) {
                expect(client.sync.pendingCount, `seed ${seed}: changes left unsent`).toBe(0);
                expect(canonical(client.sync.view), `seed ${seed}: ${client.sync.clientId} view`).toBe(expected);
                expect(canonical(client.sync.confirmed), `seed ${seed}: ${client.sync.clientId} confirmed`).toBe(
                    expected,
                );
                expect(client.sync.seq, `seed ${seed}: sequence`).toBe(core.seq);
            }
            totalRejections += rejections;
            totalShapes += core.shapes.size;
        }
        // The scenario is only meaningful if it exercised the hard paths.
        expect(totalRejections).toBeGreaterThan(0);
        expect(totalShapes).toBeGreaterThan(0);
    });
});
