import {useEffect, useRef, useState} from "react";

import {Editor} from "../editor/editor";
import {HelpDialog} from "./HelpDialog";
import {HelpIcon} from "./icons";
import {NoteEditor} from "./NoteEditor";
import {StylePanel} from "./StylePanel";
import {Toolbar} from "./Toolbar";
import {TopBar} from "./TopBar";
import {useEditorVersion} from "./useEditor";
import {ZoomControls} from "./ZoomControls";

/**
 * Tells screen-reader users what they cannot see on the canvas: who comes and
 * goes, and whether their edits are reaching anyone.
 */
const Announcer = ({editor}: {editor: Editor}) => {
    useEditorVersion(editor);
    return (
        <p className="sr-only" aria-live="polite">
            {editor.announcement}
        </p>
    );
};

const Toast = ({editor, local}: {editor: Editor; local: string | null}) => {
    useEditorVersion(editor);
    const message = local ?? editor.toast?.message;
    if (!message) return null;
    return (
        <div className="toast" role="status">
            {message}
        </div>
    );
};

const CanvasLayer = ({editor}: {editor: Editor}) => {
    const ref = useRef<HTMLCanvasElement>(null);
    useEditorVersion(editor); // keeps the shape count in the label current
    useEffect(() => (ref.current ? editor.attach(ref.current) : undefined), [editor]);
    return (
        <canvas
            ref={ref}
            className="board-canvas"
            role="img"
            aria-label={`Shared board with ${editor.shapes.length} shape${editor.shapes.length === 1 ? "" : "s"}`}
        />
    );
};

export const Board = ({room, client}: {room: string; client: string}) => {
    // Constructing an editor has no side effects; the socket opens in the effect
    // below, so the double mount React does in development never opens two.
    const [editor] = useState(() => new Editor({room, client}));
    const [helpOpen, setHelpOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    useEffect(() => {
        editor.connect();
        // Development only (tree-shaken from production): lets the end-to-end
        // tests read the board, which is otherwise pixels on a canvas.
        if (import.meta.env.DEV) (window as unknown as {__tessera?: Editor}).__tessera = editor;
        return () => editor.disconnect();
    }, [editor]);

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(null), 2_500);
        return () => clearTimeout(timer);
    }, [notice]);

    return (
        <main className="board">
            <h1 className="sr-only">Tessera board {room}</h1>
            <CanvasLayer editor={editor} />
            <NoteEditor key={editor.editing ?? "none"} editor={editor} />
            <TopBar editor={editor} onCopied={() => setNotice("Link copied — anyone with it can edit this board")} />
            <StylePanel editor={editor} />
            <div className="bottom-bar">
                <button type="button" className="panel icon-button help-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={() => setHelpOpen(true)}>
                    <HelpIcon />
                </button>
                <Toolbar editor={editor} />
                <ZoomControls editor={editor} />
            </div>
            <Toast editor={editor} local={notice} />
            <Announcer editor={editor} />
            <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
        </main>
    );
};
