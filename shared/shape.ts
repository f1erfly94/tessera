export const SHAPE_TYPES = ["rect", "ellipse", "line", "arrow", "pen", "note"] as const;
export type ShapeType = (typeof SHAPE_TYPES)[number];

/**
 * One object on the board.
 *
 * Every field is a plain value so that any single one can be set on its own —
 * the unit of conflict is a property, not a shape: if one person recolours a
 * rectangle while another moves it, both changes survive.
 */
export interface Shape {
    id: string;
    type: ShapeType;
    /** Top-left corner in world units. For a line or an arrow: the start point. */
    x: number;
    y: number;
    /** Size in world units. For a line or an arrow: the vector to the end point, so it can be negative. */
    w: number;
    h: number;
    stroke: string;
    fill: string | null;
    strokeWidth: number;
    /** Fractional index: shapes paint in ascending order of this key. */
    z: string;
    /**
     * Pen strokes only: flat [x0, y0, x1, y1, …], each coordinate in 0..1 of the
     * shape's box. Normalised so that resizing a stroke changes two numbers,
     * not every point in it.
     */
    points?: number[];
    /** Sticky notes only. */
    text?: string;
}

export type ShapeProps = Omit<Shape, "id" | "type">;
export type ShapePatch = Partial<ShapeProps>;
export type ShapeProp = keyof ShapeProps;

export const SHAPE_PROPS: readonly ShapeProp[] = [
    "x",
    "y",
    "w",
    "h",
    "stroke",
    "fill",
    "strokeWidth",
    "z",
    "points",
    "text",
];

/** Lines and arrows are vectors; everything else is a box. */
export const isVectorShape = (shape: Pick<Shape, "type">) => shape.type === "line" || shape.type === "arrow";

/** Painting order: by fractional index, and by id when two keys collide. */
export const compareShapes = (a: Shape, b: Shape) =>
    a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

export interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Axis-aligned bounds in world units, with positive width and height. */
export const shapeBounds = (shape: Shape): Box => {
    const x = Math.min(shape.x, shape.x + shape.w);
    const y = Math.min(shape.y, shape.y + shape.h);
    return {x, y, w: Math.abs(shape.w), h: Math.abs(shape.h)};
};
