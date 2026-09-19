import {keysBetween} from "../shared/fractional";
import type {Shape} from "../shared/shape";

/**
 * What a brand-new room starts with: a few notes that explain the board by
 * being on it. They are ordinary shapes — anyone can move, edit or delete them.
 */
export const welcomeShapes = (): Shape[] => {
    const notes: {text: string; x: number; y: number; fill: string}[] = [
        {
            text: "Welcome to Tessera — a board you edit together, live.\n\nCopy the link and open it anywhere: every change shows up for everyone at once.",
            x: -380,
            y: -220,
            fill: "#fff3bf",
        },
        {
            text: "Tools: V select · H pan · R rectangle · O ellipse · L line · A arrow · P pen · N note.\n\nScroll to pan, Ctrl + scroll or pinch to zoom.",
            x: 20,
            y: -220,
            fill: "#d3f9d8",
        },
        {
            text: "Try it offline: open the connection menu, go offline, keep drawing — your changes merge when you come back.",
            x: -380,
            y: 60,
            fill: "#d0ebff",
        },
    ];
    const keys = keysBetween(null, null, notes.length + 2);

    const shapes: Shape[] = notes.map((note, index) => ({
        id: `welcome-note-${index + 1}`,
        type: "note",
        x: note.x,
        y: note.y,
        w: 360,
        h: 240,
        stroke: "#343a40",
        fill: note.fill,
        strokeWidth: 1,
        z: keys[index]!,
        text: note.text,
    }));

    shapes.push(
        {
            id: "welcome-rect",
            type: "rect",
            x: 70,
            y: 90,
            w: 180,
            h: 120,
            stroke: "#1971c2",
            fill: null,
            strokeWidth: 3,
            z: keys[notes.length]!,
        },
        {
            id: "welcome-arrow",
            type: "arrow",
            x: 260,
            y: 150,
            w: 110,
            h: -40,
            stroke: "#e03131",
            fill: null,
            strokeWidth: 3,
            z: keys[notes.length + 1]!,
        },
    );
    return shapes;
};
