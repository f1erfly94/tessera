import type {ReactNode} from "react";

import type {Editor, Tool} from "../editor/editor";
import {
    ArrowIcon,
    EllipseIcon,
    HandIcon,
    LineIcon,
    NoteIcon,
    PenIcon,
    RectIcon,
    RedoIcon,
    SelectIcon,
    UndoIcon,
} from "./icons";
import {useEditorVersion} from "./useEditor";

const TOOLS: {tool: Tool; label: string; shortcut: string; icon: ReactNode}[] = [
    {tool: "select", label: "Select", shortcut: "V", icon: <SelectIcon />},
    {tool: "hand", label: "Pan", shortcut: "H", icon: <HandIcon />},
    {tool: "rect", label: "Rectangle", shortcut: "R", icon: <RectIcon />},
    {tool: "ellipse", label: "Ellipse", shortcut: "O", icon: <EllipseIcon />},
    {tool: "line", label: "Line", shortcut: "L", icon: <LineIcon />},
    {tool: "arrow", label: "Arrow", shortcut: "A", icon: <ArrowIcon />},
    {tool: "pen", label: "Pen", shortcut: "P", icon: <PenIcon />},
    {tool: "note", label: "Sticky note", shortcut: "N", icon: <NoteIcon />},
];

export const Toolbar = ({editor}: {editor: Editor}) => {
    useEditorVersion(editor);

    return (
        <div className="panel toolbar" role="toolbar" aria-label="Tools">
            {TOOLS.map(({tool, label, shortcut, icon}) => (
                <button
                    key={tool}
                    type="button"
                    className="icon-button"
                    aria-pressed={editor.tool === tool}
                    aria-label={`${label} (${shortcut})`}
                    title={`${label} — ${shortcut}`}
                    onClick={() => editor.setTool(tool)}
                >
                    {icon}
                    <span className="shortcut" aria-hidden="true">
                        {shortcut}
                    </span>
                </button>
            ))}
            <span className="divider" aria-hidden="true" />
            <button
                type="button"
                className="icon-button"
                aria-label="Undo (Ctrl+Z)"
                title="Undo — Ctrl+Z"
                disabled={!editor.canUndo}
                onClick={() => editor.undo()}
            >
                <UndoIcon />
            </button>
            <button
                type="button"
                className="icon-button"
                aria-label="Redo (Ctrl+Shift+Z)"
                title="Redo — Ctrl+Shift+Z"
                disabled={!editor.canRedo}
                onClick={() => editor.redo()}
            >
                <RedoIcon />
            </button>
        </div>
    );
};
