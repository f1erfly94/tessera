import {type Op, opTarget} from "../../shared/doc";
import {keyBetween, keysBetween} from "../../shared/fractional";
import {compareShapes, isVectorShape, SHAPE_PROPS, type Shape, shapeBounds, type ShapePatch} from "../../shared/shape";
import {type ConnectionStatus, RoomConnection} from "../sync/connection";
import {
    type Identity,
    loadIdentity,
    loadPending,
    loadSnapshot,
    randomId,
    saveIdentity,
    savePending,
    saveSnapshot,
    tabClientId,
} from "../sync/storage";
import {type DocChange, SyncClient} from "../sync/sync-client";
import {
    boxFromPoints,
    boxesIntersect,
    type Camera,
    fitCamera,
    type Handle,
    handlePositions,
    hitShape,
    normalizeStroke,
    type Point,
    resizeShape,
    screenToWorld,
    simplify,
    unionBounds,
    worldToScreen,
    zoomAt,
} from "./geometry";
import {type PeerView, renderScene} from "./render";
import {SortedShapes} from "./sorted";

export type Tool = "select" | "hand" | "rect" | "ellipse" | "line" | "arrow" | "pen" | "note";

export const TOOL_SHORTCUTS: Record<string, Tool> = {
    v: "select",
    h: "hand",
    r: "rect",
    o: "ellipse",
    l: "line",
    a: "arrow",
    p: "pen",
    n: "note",
};

export interface Style {
    stroke: string;
    fill: string | null;
    strokeWidth: number;
}

/** Stroke colours, each with the pastel used for fills and sticky notes. */
export const PALETTE: {stroke: string; pastel: string}[] = [
    {stroke: "#1e1e1e", pastel: "#e9ecef"},
    {stroke: "#e03131", pastel: "#ffe3e3"},
    {stroke: "#f08c00", pastel: "#fff3bf"},
    {stroke: "#2f9e44", pastel: "#d3f9d8"},
    {stroke: "#1971c2", pastel: "#d0ebff"},
    {stroke: "#9c36b5", pastel: "#f3d9fa"},
];

export const STROKE_WIDTHS = [2, 4, 8];

type Gesture =
    | {kind: "pan"; pointer: number; startScreen: Point; startCamera: Camera}
    | {kind: "move"; pointer: number; start: Point; originals: Shape[]; key: string}
    | {kind: "marquee"; pointer: number; start: Point; current: Point; base: Set<string>}
    | {kind: "resize"; pointer: number; handle: Handle; original: Shape; key: string}
    | {kind: "draw"; pointer: number; start: Point; id: string; key: string}
    | {kind: "pen"; pointer: number; id: string; points: Point[]; key: string}
    | {kind: "pinch"; distance: number; midpoint: Point; camera: Camera};

/** Everything an undoable action touched, as it was before. */
interface Action {
    before: Map<string, Shape | undefined>;
}

export interface EditorOptions {
    room: string;
    /** No server and no storage: the benchmark page. */
    local?: boolean;
}

const HISTORY_LIMIT = 200;
const PRESENCE_INTERVAL_MS = 50;
const FLUSH_INTERVAL_MS = 50;

const isTypingTarget = (target: EventTarget | null) =>
    target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

const sameValue = (a: unknown, b: unknown) =>
    a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]));

/**
 * The editor: tools, gestures, selection, undo, and the render loop.
 *
 * It owns the SyncClient and the socket; React only draws the chrome around the
 * canvas and reads the fields here through `subscribe`. The canvas itself is
 * repainted by `requestAnimationFrame` when — and only when — something visible
 * changed.
 */
export class Editor {
    readonly room: string;
    readonly sync: SyncClient;
    readonly local: boolean;
    identity: Identity;

    camera: Camera = {x: 0, y: 0, zoom: 1};
    tool: Tool = "select";
    selection = new Set<string>();
    style: Style = {stroke: PALETTE[0]!.stroke, fill: null, strokeWidth: STROKE_WIDTHS[0]!};
    editing: string | null = null;
    hover: string | null = null;
    status: ConnectionStatus = "connecting";
    toast: {id: number; message: string} | null = null;
    /** Latest screen-reader announcement: who joined or left, and connection changes. */
    announcement = "";
    /** Last rendered frame: shapes drawn and milliseconds spent. */
    frameStats = {drawn: 0, ms: 0};

    private connection: RoomConnection | null = null;
    private readonly sorted = new SortedShapes();
    private canvas: HTMLCanvasElement | null = null;
    private context: CanvasRenderingContext2D | null = null;
    private width = 0;
    private height = 0;
    private dpr = 1;

    private gesture: Gesture | null = null;
    private gestureCount = 0;
    private action: Action | null = null;
    private undoStack: Op[][] = [];
    private redoStack: Op[][] = [];
    private readonly pointers = new Map<number, Point>();
    private spaceHeld = false;
    private cameraTouched = false;

    private peerCursors = new Map<string, {x: number; y: number}>();
    private knownPeers = new Map<string, string>();
    private lastPresence = 0;
    private lastCursor: [number, number] | null = null;

    private frame = 0;
    private version = 0;
    private readonly listeners = new Set<() => void>();
    private readonly connectionCleanups: (() => void)[] = [];
    private readonly canvasCleanups: (() => void)[] = [];
    private toastTimer: ReturnType<typeof setTimeout> | null = null;
    private snapshotTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(options: EditorOptions) {
        this.room = options.room;
        this.local = options.local ?? false;
        this.identity = this.local ? {name: "You", color: "#4263eb"} : loadIdentity();

        const clientId = this.local ? "local" : tabClientId();
        const saved = this.local ? {counter: 0, changes: []} : loadPending(this.room, clientId);

        this.sync = new SyncClient(
            {
                clientId,
                name: this.identity.name,
                color: this.identity.color,
                counter: saved.counter,
                pending: saved.changes,
                cached: this.local ? [] : loadSnapshot(this.room),
            },
            {
                doc: (touched) => this.onDocChange(touched),
                peers: () => this.onPeersChange(),
                pending: () => this.onPendingChange(),
                rejected: (reason) => this.showToast(reason),
                resync: () => this.connection?.reconnect(),
            },
        );
        this.sorted.reset(this.sync.view);
    }

    /**
     * Opens the room socket. Kept out of the constructor so that creating an
     * editor has no side effects: React may create one and throw it away.
     */
    connect() {
        if (this.local || this.connection) return;
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        this.connection = new RoomConnection(`${protocol}://${location.host}/api/rooms/${this.room}/ws`, this.sync, (status) => {
            this.status = status;
            this.announcement =
                status === "online" ? "Connected" : status === "offline" ? "Offline — changes are kept on this device" : "Reconnecting";
            this.emit();
        });
        const flush = setInterval(() => this.sync.flush(), FLUSH_INTERVAL_MS);
        // The queue is saved on a short debounce; a reload or a closed tab inside
        // that window must not lose the last edit.
        const persist = () => this.persistPending();
        window.addEventListener("pagehide", persist);
        this.connectionCleanups.push(
            () => window.removeEventListener("pagehide", persist),
            () => clearInterval(flush),
            () => {
                this.connection?.dispose();
                this.connection = null;
            },
        );
    }

    disconnect() {
        for (const cleanup of this.connectionCleanups.splice(0)) cleanup();
        if (this.pendingTimer) clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
        this.persistPending();
    }

    // ── React glue ───────────────────────────────────────────────────────────

    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    getVersion = () => this.version;

    private emit() {
        this.version++;
        for (const listener of this.listeners) listener();
    }

    get shapes(): readonly Shape[] {
        return this.sorted.all;
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    get manualOffline() {
        return this.connection?.manualOffline ?? false;
    }

    selectedShapes(): Shape[] {
        return [...this.selection].map((id) => this.sync.view.get(id)).filter((shape): shape is Shape => !!shape);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /** Wires the canvas up; returns the function that unwires it. */
    attach(canvas: HTMLCanvasElement): () => void {
        this.detach();
        this.canvas = canvas;
        this.context = canvas.getContext("2d");

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const first = this.width === 0;
            this.width = rect.width;
            this.height = rect.height;
            this.dpr = window.devicePixelRatio || 1;
            canvas.width = Math.round(rect.width * this.dpr);
            canvas.height = Math.round(rect.height * this.dpr);
            if (first) this.camera = {x: -rect.width / 2, y: -rect.height / 2, zoom: 1};
            if (first && this.sorted.all.length > 0) this.fitToContent();
            this.requestRender();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);
        resize();

        const on = <K extends keyof HTMLElementEventMap>(
            target: HTMLElement | Window,
            type: K,
            handler: (event: HTMLElementEventMap[K]) => void,
            options?: AddEventListenerOptions,
        ) => {
            target.addEventListener(type, handler as EventListener, options);
            this.canvasCleanups.push(() => target.removeEventListener(type, handler as EventListener, options));
        };

        on(canvas, "pointerdown", (event) => this.pointerDown(event));
        on(canvas, "pointermove", (event) => this.pointerMove(event));
        on(canvas, "pointerup", (event) => this.pointerUp(event));
        on(canvas, "pointercancel", (event) => this.pointerUp(event));
        on(canvas, "pointerleave", () => this.leaveCanvas());
        on(canvas, "dblclick", (event) => this.doubleClick(event));
        on(canvas, "wheel", (event) => this.wheel(event), {passive: false});
        on(window, "keydown", (event) => this.keyDown(event));
        on(window, "keyup", (event) => this.keyUp(event));
        this.canvasCleanups.push(() => observer.disconnect());
        return () => this.detach();
    }

    detach() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        for (const cleanup of this.canvasCleanups.splice(0)) cleanup();
        this.canvas = null;
        this.context = null;
        this.width = 0;
    }

    // ── Commands (toolbar, keyboard, panels) ─────────────────────────────────

    setTool(tool: Tool) {
        this.tool = tool;
        if (tool !== "select") this.hover = null;
        this.stopEditing();
        this.updateCursor();
        this.emit();
        this.requestRender();
    }

    setStroke(stroke: string) {
        this.style = {...this.style, stroke};
        const pastel = PALETTE.find((entry) => entry.stroke === stroke)?.pastel ?? null;
        this.applyToSelection((shape) =>
            shape.type === "note" ? {fill: pastel} : {stroke, ...(shape.fill && !isVectorShape(shape) ? {fill: pastel} : {})},
        );
    }

    setFilled(filled: boolean) {
        const pastel = PALETTE.find((entry) => entry.stroke === this.style.stroke)?.pastel ?? null;
        this.style = {...this.style, fill: filled ? pastel : null};
        this.applyToSelection((shape) =>
            shape.type === "rect" || shape.type === "ellipse"
                ? {fill: filled ? (PALETTE.find((entry) => entry.stroke === shape.stroke)?.pastel ?? pastel) : null}
                : null,
        );
    }

    setStrokeWidth(strokeWidth: number) {
        this.style = {...this.style, strokeWidth};
        this.applyToSelection((shape) => (shape.type === "note" ? null : {strokeWidth}));
    }

    deleteSelection() {
        if (this.selection.size === 0) return;
        this.commit([...this.selection].map((id) => ({t: "delete", id})));
        this.setSelection(new Set());
        this.sync.flush();
    }

    duplicateSelection() {
        const originals = this.selectedShapes().sort(compareShapes);
        if (originals.length === 0) return;
        const keys = keysBetween(this.topKey(), null, originals.length);
        const copies = originals.map((shape, index) => ({...shape, id: randomId(), x: shape.x + 24, y: shape.y + 24, z: keys[index]!}));
        this.commit(copies.map((shape) => ({t: "create", shape})));
        this.setSelection(new Set(copies.map((shape) => shape.id)));
        this.sync.flush();
    }

    selectAll() {
        this.setSelection(new Set(this.sorted.all.map((shape) => shape.id)));
    }

    /** Front, back, or one step either way — only the moved shapes get new keys. */
    reorder(direction: "front" | "back" | "forward" | "backward") {
        const selected = this.selectedShapes().sort(compareShapes);
        if (selected.length === 0) return;
        const all = this.sorted.all;
        const safeBetween = (before: string | null, after: string | null, count: number) =>
            before !== null && after !== null && before >= after ? keysBetween(before, null, count) : keysBetween(before, after, count);

        let keys: string[];
        if (direction === "front") {
            keys = safeBetween(this.topKey(), null, selected.length);
        } else if (direction === "back") {
            keys = safeBetween(null, all[0]?.z ?? null, selected.length);
        } else if (direction === "forward") {
            const topIndex = all.indexOf(selected.at(-1)!);
            const next = all.slice(topIndex + 1).find((shape) => !this.selection.has(shape.id));
            if (!next) return;
            const afterNext = all[all.indexOf(next) + 1];
            keys = safeBetween(next.z, afterNext?.z ?? null, selected.length);
        } else {
            const bottomIndex = all.indexOf(selected[0]!);
            const previous = all.slice(0, bottomIndex).reverse().find((shape) => !this.selection.has(shape.id));
            if (!previous) return;
            const beforePrevious = all[all.indexOf(previous) - 1];
            keys = safeBetween(beforePrevious?.z ?? null, previous.z, selected.length);
        }
        this.commit(selected.map((shape, index) => ({t: "update", id: shape.id, patch: {z: keys[index]!}})));
        this.sync.flush();
    }

    undo() {
        this.replayHistory(this.undoStack, this.redoStack);
    }

    redo() {
        this.replayHistory(this.redoStack, this.undoStack);
    }

    zoomBy(factor: number) {
        this.camera = zoomAt(this.camera, {x: this.width / 2, y: this.height / 2}, factor);
        this.cameraMoved();
    }

    resetZoom() {
        this.zoomBy(1 / this.camera.zoom);
    }

    fitToContent() {
        const bounds = unionBounds(this.sorted.all.map(shapeBounds));
        if (!bounds || this.width === 0) return;
        this.camera = fitCamera(bounds, this.width, this.height);
        this.cameraMoved(false);
    }

    /** For the benchmark page: put the camera exactly here. */
    setCamera(camera: Camera) {
        this.camera = camera;
        this.cameraMoved(false);
    }

    /** For the benchmark page: fill a local board in one go. */
    loadShapes(shapes: Shape[]) {
        this.sync.commit(shapes.map((shape) => ({t: "create", shape})));
    }

    get viewportSize() {
        return {width: this.width, height: this.height};
    }

    setManualOffline(offline: boolean) {
        this.connection?.setManualOffline(offline);
        this.emit();
    }

    rename(name: string) {
        const trimmed = name.trim().slice(0, 32);
        if (!trimmed) return;
        this.identity = {...this.identity, name: trimmed};
        this.sync.name = trimmed;
        saveIdentity(this.identity);
        this.connection?.reconnect();
        this.emit();
    }

    // Note editing: the text box is React's; the text lives in the document.

    startEditing(id: string) {
        const shape = this.sync.view.get(id);
        if (shape?.type !== "note") return;
        this.endAction();
        this.editing = id;
        this.setSelection(new Set([id]));
        this.beginAction();
        this.emit();
        this.requestRender();
    }

    setNoteText(id: string, text: string) {
        if (this.editing !== id) return;
        this.commit([{t: "update", id, patch: {text}}], `text-${id}`);
    }

    stopEditing() {
        if (!this.editing) return;
        this.editing = null;
        this.endAction();
        this.sync.flush();
        this.emit();
        this.requestRender();
    }

    // ── Sync callbacks ───────────────────────────────────────────────────────

    private onDocChange(touched: DocChange) {
        // The SyncClient reports its first board from inside its own constructor,
        // before `this.sync` is assigned; the constructor sorts that board itself.
        if (!this.sync) return;
        if (touched === "all") this.sorted.reset(this.sync.view);
        else this.sorted.update(this.sync.view, touched);

        // Someone else deleted what we had selected or were typing into.
        const view = this.sync.view;
        const stillThere = [...this.selection].filter((id) => view.has(id));
        if (stillThere.length !== this.selection.size) this.selection = new Set(stillThere);
        if (this.editing && !view.has(this.editing)) this.editing = null;

        // The first real board of a session: show it all, unless the visitor already moved.
        if (touched === "all" && this.sync.synced && !this.cameraTouched && this.width > 0) this.fitToContent();

        if (!this.local) {
            if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
            this.snapshotTimer = setTimeout(() => saveSnapshot(this.room, this.sync.confirmed.values()), 1_500);
        }
        this.emit();
        this.requestRender();
    }

    private onPeersChange() {
        for (const id of this.peerCursors.keys()) if (!this.sync.peers.has(id)) this.peerCursors.delete(id);
        const messages: string[] = [];
        for (const [id, peer] of this.sync.peers) if (!this.knownPeers.has(id)) messages.push(`${peer.name} joined`);
        for (const [id, name] of this.knownPeers) if (!this.sync.peers.has(id)) messages.push(`${name} left`);
        this.knownPeers = new Map([...this.sync.peers].map(([id, peer]) => [id, peer.name]));
        if (messages.length > 0) this.announcement = messages.join(". ");
        this.emit();
        this.requestRender();
    }

    private onPendingChange() {
        if (this.local) return;
        // Debounced: a drag changes the queue sixty times a second.
        if (this.pendingTimer) return;
        this.pendingTimer = setTimeout(() => {
            this.pendingTimer = null;
            this.persistPending();
        }, 300);
        this.emit();
    }

    private persistPending() {
        if (this.local) return;
        savePending(this.room, this.sync.clientId, {counter: this.sync.lastCounter, changes: [...this.sync.pendingChanges]});
    }

    // ── History ──────────────────────────────────────────────────────────────

    /** Opens an undoable action; everything committed until `endAction` undoes as one step. */
    private beginAction() {
        this.action ??= {before: new Map()};
    }

    private endAction() {
        const action = this.action;
        this.action = null;
        if (!action) return;
        const inverse = this.inverseOf(action);
        if (inverse.length === 0) return;
        this.undoStack.push(inverse);
        if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
        this.redoStack = [];
        this.emit();
    }

    /** Commits ops, remembering what they overwrite so the action can be undone. */
    private commit(ops: Op[], coalesce?: string) {
        if (ops.length === 0) return;
        const standalone = !this.action;
        if (standalone) this.beginAction();
        const action = this.action!;
        for (const op of ops) {
            const id = opTarget(op);
            if (!action.before.has(id)) action.before.set(id, this.sync.view.get(id));
        }
        this.sync.commit(ops, coalesce);
        if (standalone) this.endAction();
    }

    /**
     * What undoes an action: the difference between the shapes as they were and
     * as they are. Only properties this person changed are restored, so undoing
     * a move does not also revert a colour someone else set in the meantime.
     */
    private inverseOf(action: Action): Op[] {
        const ops: Op[] = [];
        for (const [id, before] of action.before) {
            const after = this.sync.view.get(id);
            if (!before && after) ops.push({t: "delete", id});
            else if (before && !after) ops.push({t: "create", shape: before});
            else if (before && after) {
                const patch: Record<string, unknown> = {};
                for (const key of SHAPE_PROPS) {
                    if (before[key] !== undefined && !sameValue(before[key], after[key])) patch[key] = before[key];
                }
                if (Object.keys(patch).length > 0) ops.push({t: "update", id, patch: patch as ShapePatch});
            }
        }
        return ops;
    }

    private replayHistory(from: Op[][], to: Op[][]) {
        this.stopEditing();
        const ops = from.pop();
        if (!ops) return;
        const action: Action = {before: new Map()};
        for (const op of ops) action.before.set(opTarget(op), this.sync.view.get(opTarget(op)));
        this.sync.commit(ops);
        to.push(this.inverseOf(action));
        this.setSelection(new Set(ops.map(opTarget).filter((id) => this.sync.view.has(id))));
        this.sync.flush();
    }

    // ── Pointer input ────────────────────────────────────────────────────────

    private screenPoint(event: PointerEvent | MouseEvent | WheelEvent): Point {
        const rect = this.canvas!.getBoundingClientRect();
        return {x: event.clientX - rect.left, y: event.clientY - rect.top};
    }

    private pointerDown(event: PointerEvent) {
        if (this.editing) this.stopEditing();
        this.canvas!.setPointerCapture(event.pointerId);
        const screen = this.screenPoint(event);
        this.pointers.set(event.pointerId, screen);

        if (this.pointers.size === 2) {
            // A second finger turns whatever the first one started into a pinch.
            this.cancelGesture();
            const [a, b] = [...this.pointers.values()] as [Point, Point];
            this.gesture = {
                kind: "pinch",
                distance: Math.hypot(a.x - b.x, a.y - b.y),
                midpoint: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2},
                camera: this.camera,
            };
            return;
        }
        if (this.gesture) return;

        const world = screenToWorld(this.camera, screen);
        const key = `gesture-${++this.gestureCount}`;

        if (event.button === 1 || this.tool === "hand" || this.spaceHeld) {
            this.gesture = {kind: "pan", pointer: event.pointerId, startScreen: screen, startCamera: this.camera};
            this.updateCursor();
            return;
        }
        if (event.button !== 0) return;

        switch (this.tool) {
            case "select": {
                const handle = this.handleAt(screen);
                if (handle) {
                    this.beginAction();
                    this.gesture = {kind: "resize", pointer: event.pointerId, handle: handle.handle, original: handle.shape, key};
                    return;
                }
                const hit = this.shapeAt(world);
                if (hit) {
                    if (event.shiftKey) {
                        const next = new Set(this.selection);
                        if (next.has(hit.id)) next.delete(hit.id);
                        else next.add(hit.id);
                        this.setSelection(next);
                        return;
                    }
                    if (!this.selection.has(hit.id)) this.setSelection(new Set([hit.id]));
                    this.beginAction();
                    this.gesture = {kind: "move", pointer: event.pointerId, start: world, originals: this.selectedShapes(), key};
                    return;
                }
                const base = event.shiftKey ? new Set(this.selection) : new Set<string>();
                if (!event.shiftKey) this.setSelection(new Set());
                this.gesture = {kind: "marquee", pointer: event.pointerId, start: world, current: world, base};
                return;
            }

            case "pen": {
                const id = randomId();
                this.beginAction();
                const stroke = normalizeStroke([world]);
                this.commit(
                    [{t: "create", shape: {id, type: "pen", ...stroke, stroke: this.style.stroke, fill: null, strokeWidth: this.style.strokeWidth, z: keyBetween(this.topKey(), null)}}],
                    key,
                );
                this.gesture = {kind: "pen", pointer: event.pointerId, id, points: [world], key};
                return;
            }

            case "rect":
            case "ellipse":
            case "note":
            case "line":
            case "arrow": {
                const id = randomId();
                this.beginAction();
                const note = this.tool === "note";
                const pastel = PALETTE.find((entry) => entry.stroke === this.style.stroke)?.pastel ?? "#fff3bf";
                this.commit(
                    [
                        {
                            t: "create",
                            shape: {
                                id,
                                type: this.tool,
                                x: world.x,
                                y: world.y,
                                w: 0,
                                h: 0,
                                stroke: note ? "#343a40" : this.style.stroke,
                                fill: note ? (this.style.stroke === PALETTE[0]!.stroke ? "#fff3bf" : pastel) : isVectorShape({type: this.tool}) ? null : this.style.fill,
                                strokeWidth: note ? 1 : this.style.strokeWidth,
                                z: keyBetween(this.topKey(), null),
                                ...(note ? {text: ""} : {}),
                            },
                        },
                    ],
                    key,
                );
                this.gesture = {kind: "draw", pointer: event.pointerId, start: world, id, key};
                return;
            }
        }
    }

    private pointerMove(event: PointerEvent) {
        const screen = this.screenPoint(event);
        if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, screen);
        const world = screenToWorld(this.camera, screen);
        this.sendCursor(world);

        const gesture = this.gesture;
        if (!gesture) {
            if (this.tool === "select") {
                const hover = this.handleAt(screen) ? this.hover : (this.shapeAt(world)?.id ?? null);
                if (hover !== this.hover) {
                    this.hover = hover;
                    this.requestRender();
                }
            }
            this.updateCursor(screen);
            return;
        }

        switch (gesture.kind) {
            case "pinch": {
                if (this.pointers.size < 2) return;
                const [a, b] = [...this.pointers.values()] as [Point, Point];
                const midpoint = {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2};
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                const zoomed = zoomAt(gesture.camera, gesture.midpoint, distance / Math.max(gesture.distance, 1));
                this.camera = {
                    ...zoomed,
                    x: zoomed.x - (midpoint.x - gesture.midpoint.x) / zoomed.zoom,
                    y: zoomed.y - (midpoint.y - gesture.midpoint.y) / zoomed.zoom,
                };
                this.cameraMoved();
                return;
            }
            case "pan": {
                if (event.pointerId !== gesture.pointer) return;
                this.camera = {
                    ...gesture.startCamera,
                    x: gesture.startCamera.x - (screen.x - gesture.startScreen.x) / gesture.startCamera.zoom,
                    y: gesture.startCamera.y - (screen.y - gesture.startScreen.y) / gesture.startCamera.zoom,
                };
                this.cameraMoved();
                return;
            }
            case "move": {
                if (event.pointerId !== gesture.pointer) return;
                let dx = world.x - gesture.start.x;
                let dy = world.y - gesture.start.y;
                if (event.shiftKey) {
                    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
                    else dx = 0;
                }
                this.commit(
                    gesture.originals.map((shape) => ({t: "update", id: shape.id, patch: {x: shape.x + dx, y: shape.y + dy}})),
                    gesture.key,
                );
                return;
            }
            case "resize": {
                if (event.pointerId !== gesture.pointer) return;
                this.commit([{t: "update", id: gesture.original.id, patch: resizeShape(gesture.original, gesture.handle, world, event.shiftKey)}], gesture.key);
                return;
            }
            case "marquee": {
                if (event.pointerId !== gesture.pointer) return;
                gesture.current = world;
                const box = boxFromPoints(gesture.start, world);
                const next = new Set(gesture.base);
                for (const shape of this.sorted.all) if (boxesIntersect(shapeBounds(shape), box)) next.add(shape.id);
                this.setSelection(next);
                this.requestRender();
                return;
            }
            case "draw": {
                if (event.pointerId !== gesture.pointer) return;
                const shape = this.sync.view.get(gesture.id);
                if (!shape) return;
                let patch: ShapePatch;
                if (isVectorShape(shape)) {
                    let w = world.x - gesture.start.x;
                    let h = world.y - gesture.start.y;
                    if (event.shiftKey) {
                        // Snap to 45°.
                        const angle = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
                        const length = Math.hypot(w, h);
                        w = Math.cos(angle) * length;
                        h = Math.sin(angle) * length;
                    }
                    patch = {w, h};
                } else {
                    let end = world;
                    if (event.shiftKey) {
                        const size = Math.max(Math.abs(world.x - gesture.start.x), Math.abs(world.y - gesture.start.y));
                        end = {x: gesture.start.x + Math.sign(world.x - gesture.start.x || 1) * size, y: gesture.start.y + Math.sign(world.y - gesture.start.y || 1) * size};
                    }
                    patch = boxFromPoints(gesture.start, end);
                }
                this.commit([{t: "update", id: gesture.id, patch}], gesture.key);
                return;
            }
            case "pen": {
                if (event.pointerId !== gesture.pointer) return;
                const coalesced = event.getCoalescedEvents?.() ?? [];
                for (const sample of coalesced.length > 0 ? coalesced : [event]) {
                    gesture.points.push(screenToWorld(this.camera, this.screenPoint(sample)));
                }
                const points = gesture.points.length > 800 ? simplify(gesture.points, 1 / this.camera.zoom) : gesture.points;
                gesture.points = points;
                this.commit([{t: "update", id: gesture.id, patch: normalizeStroke(points)}], gesture.key);
                return;
            }
        }
    }

    private pointerUp(event: PointerEvent) {
        this.pointers.delete(event.pointerId);
        const gesture = this.gesture;
        if (!gesture) return;
        if (gesture.kind === "pinch") {
            if (this.pointers.size < 2) this.gesture = null;
            return;
        }
        if (gesture.pointer !== event.pointerId) return;
        this.gesture = null;

        switch (gesture.kind) {
            case "draw": {
                const shape = this.sync.view.get(gesture.id);
                if (shape) {
                    const tiny = Math.hypot(shape.w, shape.h) * this.camera.zoom < 6;
                    if (tiny) {
                        // A click, not a drag: drop a shape of a sensible default size.
                        const size =
                            shape.type === "note" ? {w: 240, h: 160} : isVectorShape(shape) ? {w: 160, h: 0} : {w: 160, h: 110};
                        this.commit([{t: "update", id: shape.id, patch: {x: shape.x - (isVectorShape(shape) ? 0 : size.w / 2), y: shape.y - size.h / 2, ...size}}], gesture.key);
                    }
                    this.endAction();
                }
                // Back to selecting first: switching tools closes any open note editor.
                this.setTool("select");
                if (shape) {
                    this.setSelection(new Set([shape.id]));
                    if (shape.type === "note") this.startEditing(shape.id);
                }
                break;
            }
            case "pen": {
                const simplified = simplify(gesture.points, 0.6 / this.camera.zoom);
                this.commit([{t: "update", id: gesture.id, patch: normalizeStroke(simplified.slice(0, 1_000))}], gesture.key);
                this.endAction();
                break;
            }
            case "move":
            case "resize":
                this.endAction();
                break;
            case "marquee":
                this.requestRender();
                break;
            case "pan":
                this.updateCursor();
                break;
        }
        this.sync.flush();
        // Handles hide during a drag; bring them back even if nothing else changed.
        this.requestRender();
    }

    private cancelGesture() {
        if (this.gesture && this.gesture.kind !== "pinch" && this.gesture.kind !== "pan" && this.gesture.kind !== "marquee") {
            this.endAction();
        }
        this.gesture = null;
    }

    private doubleClick(event: MouseEvent) {
        if (this.tool !== "select") return;
        const hit = this.shapeAt(screenToWorld(this.camera, this.screenPoint(event)));
        if (hit?.type === "note") this.startEditing(hit.id);
    }

    private wheel(event: WheelEvent) {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {
            // Trackpad pinches arrive as ctrl + wheel.
            this.camera = zoomAt(this.camera, this.screenPoint(event), Math.exp(-event.deltaY * 0.01));
        } else {
            const dx = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
            const dy = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
            this.camera = {...this.camera, x: this.camera.x + dx / this.camera.zoom, y: this.camera.y + dy / this.camera.zoom};
        }
        this.cameraMoved();
    }

    private leaveCanvas() {
        if (this.hover) {
            this.hover = null;
            this.requestRender();
        }
        this.lastCursor = null;
        this.sync.sendPresence(null, [...this.selection]);
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────

    private keyDown(event: KeyboardEvent) {
        if (isTypingTarget(event.target)) {
            if (event.key === "Escape" && this.editing) this.stopEditing();
            return;
        }
        const command = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();

        if (event.key === " ") {
            if (!this.spaceHeld) {
                this.spaceHeld = true;
                this.updateCursor();
            }
            event.preventDefault();
            return;
        }
        if (command && key === "z") {
            event.preventDefault();
            if (event.shiftKey) this.redo();
            else this.undo();
            return;
        }
        if (command && key === "y") {
            event.preventDefault();
            this.redo();
            return;
        }
        if (command && key === "a") {
            event.preventDefault();
            this.selectAll();
            return;
        }
        if (command && key === "d") {
            event.preventDefault();
            this.duplicateSelection();
            return;
        }
        if (command) return;

        if (event.key === "Delete" || event.key === "Backspace") {
            event.preventDefault();
            this.deleteSelection();
            return;
        }
        if (event.key === "Escape") {
            this.cancelGesture();
            if (this.tool !== "select") this.setTool("select");
            else this.setSelection(new Set());
            return;
        }
        if (event.key === "Enter" && this.selection.size === 1) {
            const [id] = this.selection;
            if (this.sync.view.get(id!)?.type === "note") {
                event.preventDefault();
                this.startEditing(id!);
            }
            return;
        }
        if (event.key.startsWith("Arrow") && this.selection.size > 0) {
            event.preventDefault();
            const step = event.shiftKey ? 10 : 1;
            const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
            const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
            this.commit(this.selectedShapes().map((shape) => ({t: "update", id: shape.id, patch: {x: shape.x + dx, y: shape.y + dy}})));
            return;
        }
        if (event.key === "]" || event.key === "}") {
            this.reorder(event.shiftKey ? "front" : "forward");
            return;
        }
        if (event.key === "[" || event.key === "{") {
            this.reorder(event.shiftKey ? "back" : "backward");
            return;
        }
        if (event.shiftKey && event.code === "Digit1") {
            this.fitToContent();
            return;
        }
        if (event.shiftKey && event.code === "Digit0") {
            this.resetZoom();
            return;
        }
        if (event.key === "+" || event.key === "=") return this.zoomBy(1.25);
        if (event.key === "-" || event.key === "_") return this.zoomBy(0.8);

        const tool = TOOL_SHORTCUTS[key];
        if (tool && !event.shiftKey && !event.altKey) this.setTool(tool);
    }

    private keyUp(event: KeyboardEvent) {
        if (event.key === " ") {
            this.spaceHeld = false;
            this.updateCursor();
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private topKey(): string | null {
        return this.sorted.all.at(-1)?.z ?? null;
    }

    private shapeAt(world: Point): Shape | null {
        const tolerance = 6 / this.camera.zoom;
        const shapes = this.sorted.all;
        for (let index = shapes.length - 1; index >= 0; index--) {
            if (hitShape(shapes[index]!, world, tolerance)) return shapes[index]!;
        }
        return null;
    }

    private handleAt(screen: Point): {shape: Shape; handle: Handle} | null {
        if (this.selection.size !== 1) return null;
        const shape = this.sync.view.get([...this.selection][0]!);
        if (!shape) return null;
        for (const [handle, position] of handlePositions(shape)) {
            const point = worldToScreen(this.camera, position);
            if (Math.abs(point.x - screen.x) <= 7 && Math.abs(point.y - screen.y) <= 7) return {shape, handle};
        }
        return null;
    }

    private applyToSelection(patchFor: (shape: Shape) => ShapePatch | null) {
        const ops: Op[] = [];
        for (const shape of this.selectedShapes()) {
            const patch = patchFor(shape);
            if (patch && Object.keys(patch).length > 0) ops.push({t: "update", id: shape.id, patch});
        }
        this.commit(ops);
        this.sync.flush();
        this.emit();
    }

    private setSelection(selection: Set<string>) {
        this.selection = selection;
        this.sync.sendPresence(this.lastCursor, [...selection]);
        this.emit();
        this.requestRender();
    }

    private sendCursor(world: Point) {
        this.lastCursor = [Math.round(world.x), Math.round(world.y)];
        const now = performance.now();
        if (now - this.lastPresence < PRESENCE_INTERVAL_MS) return;
        this.lastPresence = now;
        this.sync.sendPresence(this.lastCursor, [...this.selection]);
    }

    private cameraMoved(byVisitor = true) {
        if (byVisitor) this.cameraTouched = true;
        this.emit();
        this.requestRender();
    }

    private updateCursor(screen?: Point) {
        if (!this.canvas) return;
        let cursor = "default";
        if (this.gesture?.kind === "pan") cursor = "grabbing";
        else if (this.tool === "hand" || this.spaceHeld) cursor = "grab";
        else if (this.tool !== "select") cursor = "crosshair";
        else if (screen) {
            const handle = this.handleAt(screen)?.handle;
            if (handle === "n" || handle === "s") cursor = "ns-resize";
            else if (handle === "e" || handle === "w") cursor = "ew-resize";
            else if (handle === "nw" || handle === "se") cursor = "nwse-resize";
            else if (handle === "ne" || handle === "sw") cursor = "nesw-resize";
            else if (handle) cursor = "move";
            else if (this.hover) cursor = "move";
        }
        this.canvas.style.cursor = cursor;
    }

    private showToast(message: string) {
        this.toast = {id: Date.now(), message};
        if (this.toastTimer) clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            this.toast = null;
            this.emit();
        }, 4_000);
        this.emit();
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    requestRender() {
        if (this.frame || !this.context) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.draw();
        });
    }

    private draw() {
        const context = this.context;
        if (!context) return;

        // Other people's pointers glide towards where they last reported,
        // instead of jumping at the presence rate.
        let settling = false;
        const peers: PeerView[] = [];
        for (const peer of this.sync.peers.values()) {
            let cursor: {x: number; y: number} | null = null;
            if (peer.cursor) {
                const [targetX, targetY] = peer.cursor;
                const shown = this.peerCursors.get(peer.id) ?? {x: targetX, y: targetY};
                shown.x += (targetX - shown.x) * 0.35;
                shown.y += (targetY - shown.y) * 0.35;
                if (Math.abs(targetX - shown.x) > 0.5 || Math.abs(targetY - shown.y) > 0.5) settling = true;
                else {
                    shown.x = targetX;
                    shown.y = targetY;
                }
                this.peerCursors.set(peer.id, shown);
                cursor = worldToScreen(this.camera, shown);
            } else {
                this.peerCursors.delete(peer.id);
            }
            peers.push({id: peer.id, name: peer.name, color: peer.color, cursor, selection: peer.selection});
        }

        const started = performance.now();
        const gesture = this.gesture;
        const stats = renderScene(context, {
            camera: this.camera,
            width: this.width,
            height: this.height,
            dpr: this.dpr,
            shapes: this.sorted.all,
            doc: this.sync.view,
            selection: this.selection,
            hover: this.tool === "select" ? this.hover : null,
            editing: this.editing,
            marquee: gesture?.kind === "marquee" ? boxFromPoints(gesture.start, gesture.current) : null,
            peers,
            showHandles: this.tool === "select" && !this.editing && gesture?.kind !== "move",
        });
        this.frameStats = {drawn: stats.drawn, ms: performance.now() - started};

        if (settling) this.requestRender();
    }
}
