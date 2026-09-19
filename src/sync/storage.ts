import type {Change} from "../../shared/doc";
import type {Shape} from "../../shared/shape";

/**
 * What survives a reload, in localStorage:
 *
 * - per tab: a client id (sessionStorage, claimed with a lock — two tabs are
 *   two clients, even when one started as a copy of the other);
 * - per tab and room: unsent changes and the change counter, so offline edits
 *   are not lost if the tab reloads before the connection comes back;
 * - per room: the last board seen, so a room opened offline is not blank.
 *
 * Every access is wrapped: storage can be full, disabled or throw in private
 * modes, and none of that may break editing.
 */

const read = <T>(storage: Storage, key: string): T | null => {
    try {
        const raw = storage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
};

const write = (storage: Storage, key: string, value: unknown) => {
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        // Full or unavailable: the edits still reach the server if we are online.
    }
};

export const randomId = (length = 12) => {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
};

const CLIENT_KEY = "tessera:client";
/** How long a page waits for its inherited id when changes are queued under it; see `claimClientId`. */
const RELOAD_PATIENCE_MS = 1_000;

/**
 * The id this page's changes carry. The room applies a change once per
 * (client, number) and tells a returning client the last number it applied.
 *
 * It lives in sessionStorage so that a reloaded page is the same client and can
 * resend whatever it never heard back about without anything applying twice.
 * But browsers also copy sessionStorage into a window opened with `window.open`
 * and into a duplicated tab, and two live pages under one id break the protocol
 * from both ends: the room takes the changes of whichever page is behind in
 * numbering for repeats and drops them, and each page takes the other's changes
 * for echoes of its own and never draws them.
 *
 * So a page also holds a lock named after its id for as long as it lives. A
 * reload finds the lock free — the page before let go of it on unloading — and
 * keeps the id; a copy finds it held by the page it was copied from, and starts
 * over as a new client.
 */
export const claimClientId = async (room: string): Promise<string> => {
    const inherited = read<string>(sessionStorage, CLIENT_KEY);
    // No Locks API outside a secure context: sessionStorage is all there is.
    if (!navigator.locks) return inherited ?? newClientId();

    if (inherited) {
        // In practice the page before a reload has let go by the time the next
        // one asks. If changes are queued under the id, give it a moment anyway
        // rather than strand them under an id nobody uses any more.
        const patience = loadPending(room, inherited).changes.length > 0 ? RELOAD_PATIENCE_MS : 0;
        if (await holdClientId(inherited, patience)) return inherited;
    }
    const id = newClientId();
    await holdClientId(id, 0);
    return id;
};

const newClientId = () => {
    const id = randomId();
    write(sessionStorage, CLIENT_KEY, id);
    return id;
};

/**
 * Takes the lock named after a client id if it is free, or comes free within
 * `patience` ms, and holds it until the page is closed, reloaded or crashes.
 */
const holdClientId = (id: string, patience: number): Promise<boolean> =>
    new Promise((resolve) => {
        const options: LockOptions = patience > 0 ? {signal: AbortSignal.timeout(patience)} : {ifAvailable: true};
        navigator.locks
            .request(`tessera:client:${id}`, options, (lock) => {
                resolve(lock !== null);
                // A promise that never settles keeps the lock for the page's lifetime.
                return lock ? new Promise<never>(() => {}) : undefined;
            })
            .catch(() => resolve(false)); // the patience ran out, or this page may not take locks
    });

interface PendingRecord {
    counter: number;
    changes: Change[];
}

const pendingKey = (room: string, client: string) => `tessera:pending:${room}:${client}`;
const snapshotKey = (room: string) => `tessera:board:${room}`;

export const loadPending = (room: string, client: string): PendingRecord =>
    read<PendingRecord>(localStorage, pendingKey(room, client)) ?? {counter: 0, changes: []};

export const savePending = (room: string, client: string, record: PendingRecord) => {
    if (record.changes.length === 0 && record.counter === 0) return;
    write(localStorage, pendingKey(room, client), record);
};

export const loadSnapshot = (room: string): Shape[] => read<Shape[]>(localStorage, snapshotKey(room)) ?? [];

export const saveSnapshot = (room: string, shapes: Iterable<Shape>) => {
    write(localStorage, snapshotKey(room), [...shapes]);
};

export interface Identity {
    name: string;
    color: string;
}

export const PEER_COLORS = ["#e03131", "#c2255c", "#9c36b5", "#6741d9", "#1971c2", "#0c8599", "#2f9e44", "#e8590c"];

const ADJECTIVES = ["Amber", "Brisk", "Calm", "Deft", "Eager", "Fleet", "Gentle", "Keen", "Lucid", "Nimble", "Quiet", "Swift"];
const ANIMALS = ["Otter", "Heron", "Lynx", "Finch", "Marten", "Ibex", "Wren", "Stoat", "Crane", "Hare", "Newt", "Kite"];

export const loadIdentity = (): Identity => {
    const saved = read<Identity>(localStorage, "tessera:identity");
    if (saved?.name && saved.color) return saved;
    const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)]!;
    const identity = {name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(PEER_COLORS)};
    write(localStorage, "tessera:identity", identity);
    return identity;
};

export const saveIdentity = (identity: Identity) => write(localStorage, "tessera:identity", identity);
