import type {CSSProperties} from "react";

import {type Editor, PALETTE, STROKE_WIDTHS} from "../editor/editor";
import {BackIcon, BackwardIcon, CopyIcon, ForwardIcon, FrontIcon, TrashIcon} from "./icons";
import {useEditorVersion} from "./useEditor";

const WIDTH_LABELS = ["Thin", "Medium", "Thick"];

/**
 * Colour, fill, stroke width and layer order — for the selection, or for the
 * next shape when a drawing tool is active.
 */
export const StylePanel = ({editor}: {editor: Editor}) => {
    useEditorVersion(editor);

    const selected = editor.selectedShapes();
    const drawing = editor.tool !== "select" && editor.tool !== "hand";
    if (!drawing && selected.length === 0) return null;

    const reference = selected[0];
    const stroke = reference ? (reference.type === "note" ? matchNote(reference.fill) : reference.stroke) : editor.style.stroke;
    const width = reference && reference.type !== "note" ? reference.strokeWidth : editor.style.strokeWidth;
    const fillable = selected.length > 0 ? selected.some((shape) => shape.type === "rect" || shape.type === "ellipse") : editor.tool === "rect" || editor.tool === "ellipse";
    const filled = reference ? reference.fill !== null && reference.type !== "note" : editor.style.fill !== null;
    const stroked = selected.length > 0 ? selected.some((shape) => shape.type !== "note") : editor.tool !== "note";

    return (
        <aside className="panel style-panel" aria-label="Style">
            <fieldset>
                <legend>Colour</legend>
                <div className="swatches">
                    {PALETTE.map((entry) => (
                        <button
                            key={entry.stroke}
                            type="button"
                            className="swatch"
                            style={{"--swatch": entry.stroke} as CSSProperties}
                            aria-pressed={stroke === entry.stroke}
                            aria-label={colorName(entry.stroke)}
                            title={colorName(entry.stroke)}
                            onClick={() => editor.setStroke(entry.stroke)}
                        />
                    ))}
                </div>
            </fieldset>

            {fillable && (
                <fieldset>
                    <legend>Fill</legend>
                    <div className="segmented">
                        <button type="button" aria-pressed={!filled} onClick={() => editor.setFilled(false)}>
                            None
                        </button>
                        <button type="button" aria-pressed={filled} onClick={() => editor.setFilled(true)}>
                            Tint
                        </button>
                    </div>
                </fieldset>
            )}

            {stroked && (
                <fieldset>
                    <legend>Stroke</legend>
                    <div className="segmented">
                        {STROKE_WIDTHS.map((value, index) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={width === value}
                                aria-label={WIDTH_LABELS[index]}
                                title={WIDTH_LABELS[index]}
                                onClick={() => editor.setStrokeWidth(value)}
                            >
                                <span className="width-sample" style={{height: value}} aria-hidden="true" />
                            </button>
                        ))}
                    </div>
                </fieldset>
            )}

            {selected.length > 0 && (
                <fieldset>
                    <legend>Layer</legend>
                    <div className="button-row">
                        <button type="button" className="icon-button" aria-label="Bring to front (Shift+])" title="Bring to front — Shift+]" onClick={() => editor.reorder("front")}>
                            <FrontIcon />
                        </button>
                        <button type="button" className="icon-button" aria-label="Bring forward (])" title="Bring forward — ]" onClick={() => editor.reorder("forward")}>
                            <ForwardIcon />
                        </button>
                        <button type="button" className="icon-button" aria-label="Send backward ([)" title="Send backward — [" onClick={() => editor.reorder("backward")}>
                            <BackwardIcon />
                        </button>
                        <button type="button" className="icon-button" aria-label="Send to back (Shift+[)" title="Send to back — Shift+[" onClick={() => editor.reorder("back")}>
                            <BackIcon />
                        </button>
                    </div>
                </fieldset>
            )}

            {selected.length > 0 && (
                <fieldset>
                    <legend>
                        {selected.length} selected
                    </legend>
                    <div className="button-row">
                        <button type="button" className="icon-button" aria-label="Duplicate (Ctrl+D)" title="Duplicate — Ctrl+D" onClick={() => editor.duplicateSelection()}>
                            <CopyIcon />
                        </button>
                        <button type="button" className="icon-button danger" aria-label="Delete (Delete)" title="Delete — Delete" onClick={() => editor.deleteSelection()}>
                            <TrashIcon />
                        </button>
                    </div>
                </fieldset>
            )}
        </aside>
    );
};

const NAMES: Record<string, string> = {
    "#1e1e1e": "Black",
    "#e03131": "Red",
    "#f08c00": "Orange",
    "#2f9e44": "Green",
    "#1971c2": "Blue",
    "#9c36b5": "Violet",
};

const colorName = (stroke: string) => NAMES[stroke] ?? stroke;

/** A note's colour is its pastel background; map it back to the swatch it came from. */
const matchNote = (fill: string | null) => PALETTE.find((entry) => entry.pastel === fill)?.stroke ?? PALETTE[2]!.stroke;
