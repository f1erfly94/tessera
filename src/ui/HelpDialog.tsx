import {useEffect, useRef} from "react";

const SHORTCUTS: [string, string][] = [
    ["V · H", "Select · Pan"],
    ["R · O · L · A", "Rectangle · Ellipse · Line · Arrow"],
    ["P · N", "Pen · Sticky note"],
    ["Space + drag", "Pan"],
    ["Scroll · Ctrl + scroll", "Pan · Zoom"],
    ["Shift while drawing", "Square, circle or 45° line"],
    ["Double-click / Enter", "Edit a note"],
    ["Ctrl + Z · Ctrl + Shift + Z", "Undo · Redo (only your own changes)"],
    ["Ctrl + D · Delete", "Duplicate · Delete"],
    ["] · [", "Bring forward · Send backward"],
    ["Shift + ] · Shift + [", "Bring to front · Send to back"],
    ["Arrows", "Nudge (Shift: 10 units)"],
    ["Shift + 1 · Shift + 0", "Fit everything · 100%"],
];

/** A native <dialog>: focus trapping, Escape and the backdrop come with it. */
export const HelpDialog = ({open, onClose}: {open: boolean; onClose: () => void}) => {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    return (
        <dialog ref={ref} className="panel help-dialog" aria-labelledby="help-title" onClose={onClose}>
            <h2 id="help-title">Keyboard shortcuts</h2>
            <dl>
                {SHORTCUTS.map(([keys, action]) => (
                    <div key={keys} className="shortcut-row">
                        <dt>
                            <kbd>{keys}</kbd>
                        </dt>
                        <dd>{action}</dd>
                    </div>
                ))}
            </dl>
            <p className="help-note">
                Everything you do syncs live to everyone with the link. Conflicts resolve per property: if you move
                a shape while someone recolours it, both changes stay.
            </p>
            <button type="button" className="primary-button" onClick={onClose}>
                Got it
            </button>
        </dialog>
    );
};
