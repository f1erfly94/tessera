import {type Box, isVectorShape, type Shape, shapeBounds} from "../../shared/shape";
import {boxesIntersect, type Camera, handlePositions, inflate, worldToScreen} from "./geometry";

/**
 * Canvas 2D rendering of the board.
 *
 * A pure function of its input, called only when something changed. What keeps
 * it fast at thousands of shapes — every item here was measured, see /bench:
 *
 * - shapes outside the viewport are skipped with one box test each;
 * - shapes smaller than about a pixel on screen are drawn as a single dot;
 * - pen strokes and note text layout are computed once per version of a shape
 *   and cached by object identity (shapes are immutable, so a new object is the
 *   only thing that can invalidate them);
 * - no shadows or filters, which cost per pixel on every frame;
 * - with many shapes on screen, rectangles lose their rounded corners —
 *   `roundRect` alone costs several times what `strokeRect` does;
 * - note text becomes grey bars ("greeking") when it is small or plentiful:
 *   `fillText` under a zoom that changes every frame rasterises every glyph
 *   again at every new size;
 * - past BATCH_THRESHOLD visible shapes, strokes and fills of the same style
 *   are merged into one path each (see `drawBatched`).
 */

/**
 * Above this many visible shapes, draw in batches. Every separate fill() or
 * stroke() is its own operation for the GPU process: at 10,000 shapes that is
 * 25–90 ms a frame of rasterisation even when the JavaScript takes 2–9 ms.
 */
export const BATCH_THRESHOLD = 800;
/** Above this many visible shapes, rectangles are drawn square-cornered. */
const FAST_RECTS_THRESHOLD = 300;
/** Above this many visible notes, their text is greeked even when legible. */
const GLYPH_NOTES_LIMIT = 150;

export interface PeerView {
    id: string;
    name: string;
    color: string;
    /** Smoothed screen-space position, or null when off the board. */
    cursor: {x: number; y: number} | null;
    selection: string[];
}

export interface Scene {
    camera: Camera;
    width: number;
    height: number;
    dpr: number;
    shapes: readonly Shape[];
    doc: ReadonlyMap<string, Shape>;
    selection: ReadonlySet<string>;
    hover: string | null;
    editing: string | null;
    marquee: Box | null;
    peers: readonly PeerView[];
    showHandles: boolean;
}

export interface RenderStats {
    drawn: number;
    batched: boolean;
}

export const SELECTION_COLOR = "#4263eb";
const NOTE_FONT_SIZE = 16;
const NOTE_PADDING = 14;
const NOTE_LINE_HEIGHT = NOTE_FONT_SIZE * 1.4;
const NOTE_TEXT_COLOR = "#212529";
const GREEK_COLOR = "rgba(33, 37, 41, 0.28)";
const NOTE_SHADOW = "rgba(0, 0, 0, 0.08)";
const DEFAULT_NOTE_FILL = "#fff3bf";
export const NOTE_FONT = `${NOTE_FONT_SIZE}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

type TextMode = "none" | "greek" | "glyphs";

interface NoteLine {
    text: string;
    width: number;
}

const penPaths = new WeakMap<Shape, Path2D>();
const noteLines = new WeakMap<Shape, NoteLine[]>();

const penPath = (shape: Shape): Path2D => {
    const cached = penPaths.get(shape);
    if (cached) return cached;
    const points = shape.points ?? [];
    const path = new Path2D();
    const at = (index: number) => ({x: points[index * 2]! * shape.w, y: points[index * 2 + 1]! * shape.h});
    const count = points.length / 2;
    if (count > 0) {
        const first = at(0);
        path.moveTo(first.x, first.y);
        if (count === 1) path.lineTo(first.x + 0.01, first.y);
        // Quadratic curves through midpoints: smooth, and still passes near every sample.
        for (let index = 1; index < count - 1; index++) {
            const current = at(index);
            const next = at(index + 1);
            path.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
        }
        if (count > 1) {
            const last = at(count - 1);
            path.lineTo(last.x, last.y);
        }
    }
    penPaths.set(shape, path);
    return path;
};

/** Greedy word wrap, measured once per note version. */
const wrapNote = (ctx: CanvasRenderingContext2D, shape: Shape): NoteLine[] => {
    const cached = noteLines.get(shape);
    if (cached) return cached;
    ctx.save();
    ctx.font = NOTE_FONT;
    const maxWidth = Math.max(10, Math.abs(shape.w) - NOTE_PADDING * 2);
    const lines: NoteLine[] = [];
    for (const paragraph of (shape.text ?? "").split("\n")) {
        let line = "";
        for (const word of paragraph.split(/(\s+)/)) {
            const candidate = line + word;
            if (line && ctx.measureText(candidate).width > maxWidth) {
                const text = line.trimEnd();
                lines.push({text, width: ctx.measureText(text).width});
                line = word.trimStart();
            } else {
                line = candidate;
            }
        }
        lines.push({text: line, width: ctx.measureText(line).width});
    }
    ctx.restore();
    noteLines.set(shape, lines);
    return lines;
};

const textModeFor = (zoom: number, visibleNotes: number): TextMode => {
    const screenSize = NOTE_FONT_SIZE * zoom;
    if (screenSize < 2) return "none";
    if (screenSize < 7 || visibleNotes > GLYPH_NOTES_LIMIT) return "greek";
    return "glyphs";
};

/** The lines of a note that fit inside it, with their positions. */
const fittingLines = (ctx: CanvasRenderingContext2D, note: Shape) => {
    const {x, y, w, h} = shapeBounds(note);
    const lines = wrapNote(ctx, note);
    const result: {line: NoteLine; x: number; y: number; maxWidth: number}[] = [];
    for (let index = 0; index < lines.length; index++) {
        const lineY = y + NOTE_PADDING + index * NOTE_LINE_HEIGHT;
        if (lineY + NOTE_LINE_HEIGHT > y + h) break;
        result.push({line: lines[index]!, x: x + NOTE_PADDING, y: lineY, maxWidth: w - NOTE_PADDING * 2});
    }
    return result;
};

const drawNoteText = (ctx: CanvasRenderingContext2D, note: Shape, mode: TextMode) => {
    if (mode === "none" || !note.text) return;
    if (mode === "greek") {
        ctx.fillStyle = GREEK_COLOR;
        for (const {line, x, y, maxWidth} of fittingLines(ctx, note)) {
            if (line.width > 0) ctx.fillRect(x, y + NOTE_LINE_HEIGHT * 0.3, Math.min(line.width, maxWidth), NOTE_LINE_HEIGHT * 0.4);
        }
        return;
    }
    const {x, y, w, h} = shapeBounds(note);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h); // a single word wider than the note must not spill out
    ctx.clip();
    ctx.fillStyle = NOTE_TEXT_COLOR;
    ctx.font = NOTE_FONT;
    ctx.textBaseline = "top";
    for (const {line, x: lineX, y: lineY} of fittingLines(ctx, note)) ctx.fillText(line.text, lineX, lineY);
    ctx.restore();
};

const arrowHead = (path: CanvasPath, shape: Shape) => {
    const angle = Math.atan2(shape.h, shape.w);
    const size = Math.max(10, shape.strokeWidth * 4);
    const tipX = shape.x + shape.w;
    const tipY = shape.y + shape.h;
    path.moveTo(tipX - size * Math.cos(angle - Math.PI / 7), tipY - size * Math.sin(angle - Math.PI / 7));
    path.lineTo(tipX, tipY);
    path.lineTo(tipX - size * Math.cos(angle + Math.PI / 7), tipY - size * Math.sin(angle + Math.PI / 7));
};

interface ShapeOptions {
    zoom: number;
    editing: boolean;
    textMode: TextMode;
    fastRects: boolean;
}

/** One shape, exactly, in painting order: used whenever there are few enough to afford it. */
const drawShape = (ctx: CanvasRenderingContext2D, shape: Shape, options: ShapeOptions) => {
    ctx.strokeStyle = shape.stroke;
    ctx.lineWidth = shape.strokeWidth;
    const {x, y, w, h} = shapeBounds(shape);

    switch (shape.type) {
        case "rect": {
            if (options.fastRects || Math.min(w, h) * options.zoom < 24) {
                if (shape.fill) {
                    ctx.fillStyle = shape.fill;
                    ctx.fillRect(x, y, w, h);
                }
                ctx.strokeRect(x, y, w, h);
                return;
            }
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, Math.min(6, w / 4, h / 4));
            if (shape.fill) {
                ctx.fillStyle = shape.fill;
                ctx.fill();
            }
            ctx.stroke();
            return;
        }
        case "ellipse": {
            ctx.beginPath();
            ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
            if (shape.fill) {
                ctx.fillStyle = shape.fill;
                ctx.fill();
            }
            ctx.stroke();
            return;
        }
        case "line":
        case "arrow": {
            ctx.beginPath();
            ctx.moveTo(shape.x, shape.y);
            ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
            if (shape.type === "arrow") arrowHead(ctx, shape);
            ctx.stroke();
            return;
        }
        case "pen": {
            ctx.save();
            ctx.translate(shape.x, shape.y);
            ctx.stroke(penPath(shape));
            ctx.restore();
            return;
        }
        case "note": {
            // A flat offset instead of a shadow: shadows are blurred per pixel, every frame.
            ctx.fillStyle = NOTE_SHADOW;
            ctx.fillRect(x + 3, y + 4, w, h);
            ctx.fillStyle = shape.fill ?? DEFAULT_NOTE_FILL;
            ctx.fillRect(x, y, w, h);
            // The live editor draws its own text on top while typing.
            if (!options.editing) drawNoteText(ctx, shape, options.textMode);
            return;
        }
    }
};

/**
 * Many shapes at once, in a handful of draw calls: one path per fill colour and
 * one per stroke colour and width, instead of one call per shape.
 *
 * The price is exact overlap order — all fills go down before all strokes. It
 * only applies when more than BATCH_THRESHOLD shapes are on screen, which means
 * zoomed far out, where shapes are a few pixels across and the difference does
 * not show. Close up, painting is per shape and exact.
 */
const drawBatched = (ctx: CanvasRenderingContext2D, shapes: readonly Shape[], zoom: number, textMode: TextMode) => {
    const fills = new Map<string, Path2D>();
    const strokes = new Map<string, Path2D>();
    const pathFor = (paths: Map<string, Path2D>, key: string) => {
        let path = paths.get(key);
        if (!path) {
            path = new Path2D();
            paths.set(key, path);
        }
        return path;
    };
    const dot = 1.5 / zoom;
    const notes: Shape[] = [];

    for (const shape of shapes) {
        const {x, y, w, h} = shapeBounds(shape);
        if (Math.max(w, h) * zoom < 1.5) {
            pathFor(fills, shape.type === "note" ? (shape.fill ?? DEFAULT_NOTE_FILL) : shape.stroke).rect(x, y, dot, dot);
            continue;
        }
        const stroke = () => pathFor(strokes, `${shape.stroke}|${shape.strokeWidth}`);
        switch (shape.type) {
            case "rect":
                if (shape.fill) pathFor(fills, shape.fill).rect(x, y, w, h);
                stroke().rect(x, y, w, h);
                break;
            case "ellipse": {
                const cx = x + w / 2;
                const cy = y + h / 2;
                for (const path of shape.fill ? [pathFor(fills, shape.fill), stroke()] : [stroke()]) {
                    path.moveTo(cx + w / 2, cy);
                    path.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
                }
                break;
            }
            case "line":
            case "arrow": {
                const path = stroke();
                path.moveTo(shape.x, shape.y);
                path.lineTo(shape.x + shape.w, shape.y + shape.h);
                if (shape.type === "arrow") arrowHead(path, shape);
                break;
            }
            case "pen":
                stroke().addPath(penPath(shape), new DOMMatrix([1, 0, 0, 1, shape.x, shape.y]));
                break;
            case "note":
                pathFor(fills, NOTE_SHADOW).rect(x + 3, y + 4, w, h);
                pathFor(fills, shape.fill ?? DEFAULT_NOTE_FILL).rect(x, y, w, h);
                if (shape.text) notes.push(shape);
                break;
        }
    }

    for (const [color, path] of fills) {
        ctx.fillStyle = color;
        ctx.fill(path);
    }
    for (const [key, path] of strokes) {
        const [color, width] = key.split("|");
        ctx.strokeStyle = color!;
        ctx.lineWidth = Number(width);
        ctx.stroke(path);
    }

    if (textMode === "greek") {
        const bars = new Path2D();
        for (const note of notes) {
            for (const {line, x, y, maxWidth} of fittingLines(ctx, note)) {
                if (line.width > 0) bars.rect(x, y + NOTE_LINE_HEIGHT * 0.3, Math.min(line.width, maxWidth), NOTE_LINE_HEIGHT * 0.4);
            }
        }
        ctx.fillStyle = GREEK_COLOR;
        ctx.fill(bars);
    } else if (textMode === "glyphs") {
        for (const note of notes) drawNoteText(ctx, note, "glyphs");
    }
};

const drawGrid = (ctx: CanvasRenderingContext2D, scene: Scene) => {
    let spacing = 24 * scene.camera.zoom;
    while (spacing < 14) spacing *= 4;
    const offsetX = -((scene.camera.x * scene.camera.zoom) % spacing);
    const offsetY = -((scene.camera.y * scene.camera.zoom) % spacing);
    ctx.fillStyle = "rgba(33, 37, 41, 0.14)";
    for (let x = offsetX; x < scene.width; x += spacing) {
        for (let y = offsetY; y < scene.height; y += spacing) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
};

const outline = (ctx: CanvasRenderingContext2D, shape: Shape, zoom: number, color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width / zoom;
    if (isVectorShape(shape)) {
        ctx.beginPath();
        ctx.moveTo(shape.x, shape.y);
        ctx.lineTo(shape.x + shape.w, shape.y + shape.h);
        ctx.stroke();
        return;
    }
    const box = inflate(shapeBounds(shape), 4 / zoom + shape.strokeWidth / 2);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
};

const drawCursor = (ctx: CanvasRenderingContext2D, peer: PeerView) => {
    if (!peer.cursor) return;
    const {x, y} = peer.cursor;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = peer.color;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 17);
    ctx.lineTo(4.5, 13);
    ctx.lineTo(8, 20);
    ctx.lineTo(10.5, 19);
    ctx.lineTo(7.2, 12);
    ctx.lineTo(12.5, 12);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.font = `600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const width = ctx.measureText(peer.name).width + 12;
    ctx.beginPath();
    ctx.roundRect(12, 20, width, 20, 6);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(peer.name, 18, 30.5);
    ctx.restore();
};

export const renderScene = (ctx: CanvasRenderingContext2D, scene: Scene): RenderStats => {
    const {camera, dpr} = scene;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#f8f9fa";
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawGrid(ctx, scene);

    // World space from here on.
    ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, -camera.x * camera.zoom * dpr, -camera.y * camera.zoom * dpr);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const viewport: Box = {x: camera.x, y: camera.y, w: scene.width / camera.zoom, h: scene.height / camera.zoom};
    const visible: Shape[] = [];
    let visibleNotes = 0;
    for (const shape of scene.shapes) {
        if (!boxesIntersect(inflate(shapeBounds(shape), shape.strokeWidth + 12), viewport)) continue;
        visible.push(shape);
        if (shape.type === "note") visibleNotes++;
    }

    const textMode = textModeFor(camera.zoom, visibleNotes);
    const batched = visible.length > BATCH_THRESHOLD;
    if (batched) {
        drawBatched(ctx, visible, camera.zoom, textMode);
    } else {
        const dot = 1.5 / camera.zoom;
        const fastRects = visible.length > FAST_RECTS_THRESHOLD;
        for (const shape of visible) {
            const bounds = shapeBounds(shape);
            if (Math.max(bounds.w, bounds.h) * camera.zoom < 1.5) {
                ctx.fillStyle = shape.type === "note" ? (shape.fill ?? DEFAULT_NOTE_FILL) : shape.stroke;
                ctx.fillRect(bounds.x, bounds.y, dot, dot);
                continue;
            }
            drawShape(ctx, shape, {zoom: camera.zoom, editing: shape.id === scene.editing, textMode, fastRects});
        }
    }

    // Other people's selections, in their colour.
    for (const peer of scene.peers) {
        for (const id of peer.selection) {
            const shape = scene.doc.get(id);
            if (shape) outline(ctx, shape, camera.zoom, peer.color, 1.5);
        }
    }

    if (scene.hover && !scene.selection.has(scene.hover)) {
        const shape = scene.doc.get(scene.hover);
        if (shape) outline(ctx, shape, camera.zoom, SELECTION_COLOR, 1);
    }

    for (const id of scene.selection) {
        const shape = scene.doc.get(id);
        if (shape) outline(ctx, shape, camera.zoom, SELECTION_COLOR, 1.5);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (scene.showHandles && scene.selection.size === 1) {
        const shape = scene.doc.get([...scene.selection][0]!);
        if (shape) {
            ctx.fillStyle = "#ffffff";
            ctx.strokeStyle = SELECTION_COLOR;
            ctx.lineWidth = 1.5;
            for (const [, position] of handlePositions(shape)) {
                const point = worldToScreen(camera, position);
                ctx.beginPath();
                ctx.rect(point.x - 4, point.y - 4, 8, 8);
                ctx.fill();
                ctx.stroke();
            }
        }
    }

    if (scene.marquee) {
        const topLeft = worldToScreen(camera, scene.marquee);
        ctx.fillStyle = "rgba(66, 99, 235, 0.08)";
        ctx.strokeStyle = SELECTION_COLOR;
        ctx.lineWidth = 1;
        ctx.fillRect(topLeft.x, topLeft.y, scene.marquee.w * camera.zoom, scene.marquee.h * camera.zoom);
        ctx.strokeRect(topLeft.x, topLeft.y, scene.marquee.w * camera.zoom, scene.marquee.h * camera.zoom);
    }
    for (const peer of scene.peers) drawCursor(ctx, peer);

    return {drawn: visible.length, batched};
};
