import {type Box, isVectorShape, type Shape, shapeBounds} from "../../shared/shape";

export interface Point {
    x: number;
    y: number;
}

/**
 * The camera: which world point sits at the screen's top-left corner, and the
 * zoom. screen = (world - camera) * zoom.
 */
export interface Camera {
    x: number;
    y: number;
    zoom: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export const screenToWorld = (camera: Camera, point: Point): Point => ({
    x: point.x / camera.zoom + camera.x,
    y: point.y / camera.zoom + camera.y,
});

export const worldToScreen = (camera: Camera, point: Point): Point => ({
    x: (point.x - camera.x) * camera.zoom,
    y: (point.y - camera.y) * camera.zoom,
});

/** Zooms by `factor` keeping the world point under `anchor` (a screen point) where it is. */
export const zoomAt = (camera: Camera, anchor: Point, factor: number): Camera => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
    const world = screenToWorld(camera, anchor);
    return {zoom, x: world.x - anchor.x / zoom, y: world.y - anchor.y / zoom};
};

/** The camera that fits `box` into a viewport of `width` × `height`, with a margin. */
export const fitCamera = (box: Box, width: number, height: number, margin = 80): Camera => {
    const zoom = Math.min(
        1,
        Math.max(MIN_ZOOM, Math.min((width - margin * 2) / Math.max(box.w, 1), (height - margin * 2) / Math.max(box.h, 1))),
    );
    return {
        zoom,
        x: box.x + box.w / 2 - width / 2 / zoom,
        y: box.y + box.h / 2 - height / 2 / zoom,
    };
};

export const unionBounds = (boxes: Box[]): Box | null => {
    if (boxes.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const box of boxes) {
        minX = Math.min(minX, box.x);
        minY = Math.min(minY, box.y);
        maxX = Math.max(maxX, box.x + box.w);
        maxY = Math.max(maxY, box.y + box.h);
    }
    return {x: minX, y: minY, w: maxX - minX, h: maxY - minY};
};

export const boxesIntersect = (a: Box, b: Box) =>
    a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

export const boxFromPoints = (a: Point, b: Point): Box => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
});

export const inflate = (box: Box, by: number): Box => ({x: box.x - by, y: box.y - by, w: box.w + by * 2, h: box.h + by * 2});

const distanceToSegment = (p: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Pen points in world coordinates. */
export const penPoints = (shape: Shape): Point[] => {
    const points = shape.points ?? [];
    const result: Point[] = [];
    for (let index = 0; index + 1 < points.length; index += 2) {
        result.push({x: shape.x + points[index]! * shape.w, y: shape.y + points[index + 1]! * shape.h});
    }
    return result;
};

/** Whether `point` hits `shape`, with `tolerance` in world units for thin things. */
export const hitShape = (shape: Shape, point: Point, tolerance: number): boolean => {
    const reach = tolerance + shape.strokeWidth / 2;
    if (!boxesIntersect(inflate(shapeBounds(shape), reach), {x: point.x, y: point.y, w: 0, h: 0})) return false;

    switch (shape.type) {
        case "rect":
        case "note":
            return true;
        case "ellipse": {
            const rx = Math.abs(shape.w) / 2 + reach;
            const ry = Math.abs(shape.h) / 2 + reach;
            const cx = shape.x + shape.w / 2;
            const cy = shape.y + shape.h / 2;
            return ((point.x - cx) / rx) ** 2 + ((point.y - cy) / ry) ** 2 <= 1;
        }
        case "line":
        case "arrow":
            return distanceToSegment(point, shape, {x: shape.x + shape.w, y: shape.y + shape.h}) <= reach;
        case "pen": {
            const points = penPoints(shape);
            if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y) <= reach;
            for (let index = 1; index < points.length; index++) {
                if (distanceToSegment(point, points[index - 1]!, points[index]!) <= reach) return true;
            }
            return false;
        }
    }
};

/** Resize handles: eight around a box, or the two ends of a line. */
export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "start" | "end";

export const handlePositions = (shape: Shape): [Handle, Point][] => {
    if (isVectorShape(shape)) {
        return [
            ["start", {x: shape.x, y: shape.y}],
            ["end", {x: shape.x + shape.w, y: shape.y + shape.h}],
        ];
    }
    const {x, y, w, h} = shapeBounds(shape);
    return [
        ["nw", {x, y}],
        ["n", {x: x + w / 2, y}],
        ["ne", {x: x + w, y}],
        ["e", {x: x + w, y: y + h / 2}],
        ["se", {x: x + w, y: y + h}],
        ["s", {x: x + w / 2, y: y + h}],
        ["sw", {x, y: y + h}],
        ["w", {x, y: y + h / 2}],
    ];
};

export const MIN_SIZE = 4;

/**
 * The shape's new geometry while `handle` is dragged to `to`, from its geometry
 * at the start of the drag. Boxes keep the opposite edge fixed and stop at a
 * minimum size instead of flipping — a flipped pen stroke would need every
 * point mirrored.
 */
export const resizeShape = (original: Shape, handle: Handle, to: Point, keepRatio: boolean): Partial<Shape> => {
    if (handle === "start") return {x: to.x, y: to.y, w: original.x + original.w - to.x, h: original.y + original.h - to.y};
    if (handle === "end") return {w: to.x - original.x, h: to.y - original.y};

    const box = shapeBounds(original);
    let left = box.x;
    let top = box.y;
    let right = box.x + box.w;
    let bottom = box.y + box.h;

    if (handle.includes("w")) left = Math.min(to.x, right - MIN_SIZE);
    if (handle.includes("e")) right = Math.max(to.x, left + MIN_SIZE);
    if (handle.includes("n")) top = Math.min(to.y, bottom - MIN_SIZE);
    if (handle.includes("s")) bottom = Math.max(to.y, top + MIN_SIZE);

    if (keepRatio && box.w > 0 && box.h > 0 && handle.length === 2) {
        const ratio = box.w / box.h;
        const width = right - left;
        const height = bottom - top;
        if (width / height > ratio) {
            const adjusted = height * ratio;
            if (handle.includes("w")) left = right - adjusted;
            else right = left + adjusted;
        } else {
            const adjusted = width / ratio;
            if (handle.includes("n")) top = bottom - adjusted;
            else bottom = top + adjusted;
        }
    }
    return {x: left, y: top, w: right - left, h: bottom - top};
};

/**
 * Ramer–Douglas–Peucker: drops points that deviate from the line through their
 * neighbours by less than `tolerance`. A freehand stroke sampled at the pointer
 * rate is mostly redundant points.
 */
export const simplify = (points: Point[], tolerance: number): Point[] => {
    if (points.length <= 2) return points;
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: [number, number][] = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [first, last] = stack.pop()!;
        let farthest = -1;
        let distance = tolerance;
        for (let index = first + 1; index < last; index++) {
            const d = distanceToSegment(points[index]!, points[first]!, points[last]!);
            if (d > distance) {
                distance = d;
                farthest = index;
            }
        }
        if (farthest !== -1) {
            keep[farthest] = 1;
            stack.push([first, farthest], [farthest, last]);
        }
    }
    return points.filter((_, index) => keep[index] === 1);
};

/**
 * World points of a stroke → the shape's box and its normalised points,
 * rounded to four decimals to keep messages small.
 */
export const normalizeStroke = (points: Point[]): {x: number; y: number; w: number; h: number; points: number[]} => {
    const box = unionBounds(points.map((point) => ({x: point.x, y: point.y, w: 0, h: 0})))!;
    const w = Math.max(box.w, 1);
    const h = Math.max(box.h, 1);
    const round = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000;
    return {
        x: box.x,
        y: box.y,
        w,
        h,
        points: points.flatMap((point) => [round((point.x - box.x) / w), round((point.y - box.y) / h)]),
    };
};
