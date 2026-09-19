import type {ServerMessage} from "../../shared/protocol";
import type {SyncClient} from "./sync-client";

export type ConnectionStatus = "connecting" | "online" | "offline";

/**
 * The socket around a SyncClient: connects, keeps the connection honest with a
 * heartbeat, and reconnects with backoff.
 *
 * It also has a manual "offline" switch. Browsers' own offline emulation does
 * not reliably cut an open WebSocket, and a visitor should be able to try the
 * offline path without unplugging anything — so going offline here closes the
 * socket and stops reconnecting until switched back.
 */
export class RoomConnection {
    status: ConnectionStatus = "connecting";
    manualOffline = false;

    private socket: WebSocket | null = null;
    private attempt = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeat: ReturnType<typeof setInterval> | null = null;
    private lastHeard = 0;
    private disposed = false;

    constructor(
        private readonly url: string,
        private readonly sync: SyncClient,
        private readonly onStatus: (status: ConnectionStatus) => void,
    ) {
        window.addEventListener("online", this.retryNow);
        this.open();
    }

    setManualOffline(offline: boolean) {
        this.manualOffline = offline;
        if (offline) {
            this.clearRetry();
            this.socket?.close(1000, "Offline by choice");
            this.dropSocket();
        } else {
            this.retryNow();
        }
    }

    /** Throws away the current socket and starts again, e.g. after a gap in the stream. */
    reconnect() {
        this.socket?.close(4000, "Resynchronising");
        this.dropSocket();
        this.retryNow();
    }

    dispose() {
        this.disposed = true;
        window.removeEventListener("online", this.retryNow);
        this.clearRetry();
        this.socket?.close(1000, "Leaving");
        this.dropSocket();
    }

    private open() {
        if (this.disposed || this.manualOffline) return;
        this.setStatus("connecting");

        const socket = new WebSocket(this.url);
        this.socket = socket;

        socket.addEventListener("open", () => {
            if (socket !== this.socket) return;
            this.attempt = 0;
            this.lastHeard = Date.now();
            this.sync.connected((message) => {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
            });
            this.startHeartbeat(socket);
        });

        socket.addEventListener("message", (event) => {
            if (socket !== this.socket) return;
            this.lastHeard = Date.now();
            if (event.data === "pong") return;
            let message: ServerMessage;
            try {
                message = JSON.parse(event.data as string) as ServerMessage;
            } catch {
                return;
            }
            this.sync.receive(message);
            if (message.type === "welcome") this.setStatus("online");
        });

        socket.addEventListener("close", () => {
            if (socket !== this.socket) return;
            this.dropSocket();
            this.scheduleRetry();
        });
    }

    private dropSocket() {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (this.socket) this.sync.disconnected();
        this.socket = null;
        if (!this.disposed) this.setStatus(this.manualOffline ? "offline" : "connecting");
    }

    /**
     * A "ping" every 20 s is answered by the room without waking it; nothing
     * heard for 45 s means the connection died without a close frame (a laptop
     * lid, a dead Wi-Fi), so give up on it rather than wait for TCP to notice.
     */
    private startHeartbeat(socket: WebSocket) {
        this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastHeard > 45_000) {
                socket.close(4001, "Heartbeat lost");
                this.dropSocket();
                this.scheduleRetry();
                return;
            }
            if (socket.readyState === WebSocket.OPEN) socket.send("ping");
        }, 20_000);
    }

    /** 0.5 s, 1 s, 2 s, 4 s, then every 8 s, each with jitter so a room's clients do not return in lockstep. */
    private scheduleRetry() {
        if (this.disposed || this.manualOffline || this.retryTimer) return;
        this.setStatus(this.attempt === 0 ? "connecting" : "offline");
        const delay = Math.min(8_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
        this.attempt++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.open();
        }, delay);
    }

    private retryNow = () => {
        if (this.disposed || this.manualOffline || this.socket) return;
        this.clearRetry();
        this.attempt = 0;
        this.open();
    };

    private clearRetry() {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
    }

    private setStatus(status: ConnectionStatus) {
        if (status === this.status) return;
        this.status = status;
        this.onStatus(status);
    }
}
