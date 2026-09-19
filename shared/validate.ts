import type {Change, Op} from "./doc";
import {isValidKey} from "./fractional";
import {SHAPE_PROPS, SHAPE_TYPES, type Shape, type ShapePatch, type ShapeType} from "./shape";

/**
 * Validation of anything that arrives from a client. The room is public — anyone
 * with the link can send it anything — so nothing reaches the document without
 * passing through here, and the limits below are what keep one tab from filling
 * a room with a million points or a megabyte of text.
 */
export const LIMITS = {
    coordinate: 10_000_000,
    size: 1_000_000,
    minStrokeWidth: 0.5,
    maxStrokeWidth: 64,
    penPoints: 1_000,
    text: 2_000,
    opsPerChange: 500,
} as const;

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteIn = (value: unknown, limit: number): value is number =>
    typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;

const validators: {[K in keyof ShapePatch]-?: (value: unknown) => boolean} = {
    x: (value) => isFiniteIn(value, LIMITS.coordinate),
    y: (value) => isFiniteIn(value, LIMITS.coordinate),
    w: (value) => isFiniteIn(value, LIMITS.size),
    h: (value) => isFiniteIn(value, LIMITS.size),
    stroke: (value) => typeof value === "string" && COLOR_PATTERN.test(value),
    fill: (value) => value === null || (typeof value === "string" && COLOR_PATTERN.test(value)),
    strokeWidth: (value) =>
        typeof value === "number" && value >= LIMITS.minStrokeWidth && value <= LIMITS.maxStrokeWidth,
    z: (value) => typeof value === "string" && isValidKey(value),
    points: (value) =>
        Array.isArray(value) &&
        value.length % 2 === 0 &&
        value.length >= 2 &&
        value.length <= LIMITS.penPoints * 2 &&
        value.every((point) => typeof point === "number" && point >= 0 && point <= 1),
    text: (value) => typeof value === "string" && value.length <= LIMITS.text,
};

/** A patch with only known properties, each of them valid. */
export const parsePatch = (value: unknown): ShapePatch | null => {
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (keys.length === 0) return null;
    for (const key of keys) {
        const check = validators[key as keyof ShapePatch];
        if (!check || !check(value[key])) return null;
    }
    return value as ShapePatch;
};

export const parseShape = (value: unknown): Shape | null => {
    if (!isRecord(value)) return null;
    const {id, type, ...props} = value;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
    if (typeof type !== "string" || !SHAPE_TYPES.includes(type as ShapeType)) return null;

    const required = ["x", "y", "w", "h", "stroke", "fill", "strokeWidth", "z"] as const;
    if (required.some((key) => !(key in props))) return null;
    if (type === "pen" && !("points" in props)) return null;
    if (type === "note" && !("text" in props)) return null;
    if (Object.keys(props).some((key) => !SHAPE_PROPS.includes(key as keyof ShapePatch))) return null;

    return parsePatch(props) ? (value as unknown as Shape) : null;
};

const parseOp = (value: unknown): Op | null => {
    if (!isRecord(value)) return null;
    switch (value.t) {
        case "create": {
            const shape = parseShape(value.shape);
            return shape ? {t: "create", shape} : null;
        }
        case "update": {
            if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) return null;
            const patch = parsePatch(value.patch);
            return patch ? {t: "update", id: value.id, patch} : null;
        }
        case "delete":
            return typeof value.id === "string" && ID_PATTERN.test(value.id) ? {t: "delete", id: value.id} : null;
        default:
            return null;
    }
};

/** A whole change, or null if any part of it is invalid — changes are atomic, so is their validation. */
export const parseChange = (value: unknown): Change | null => {
    if (!isRecord(value)) return null;
    const {client, n, ops} = value;
    if (typeof client !== "string" || !ID_PATTERN.test(client)) return null;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) return null;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.opsPerChange) return null;

    const parsed: Op[] = [];
    for (const op of ops) {
        const valid = parseOp(op);
        if (!valid) return null;
        parsed.push(valid);
    }
    return {client, n, ops: parsed};
};
