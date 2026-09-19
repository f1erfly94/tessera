import type {Change} from "../../shared/doc";
import type {Shape} from "../../shared/shape";

/**
 * What survives a reload, in localStorage:
 *
 * - per tab: a client id (sessionStorage — two tabs are two clients);
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

export const tabClientId = (): string => {
    const key = "tessera:client";
    const existing = read<string>(sessionStorage, key);
    if (existing) return existing;
    const id = randomId();
    write(sessionStorage, key, id);
    return id;
};

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
