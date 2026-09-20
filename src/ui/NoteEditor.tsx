import {useEffect, useRef, useState} from "react";

import {LIMITS} from "../../shared/validate";
import type {Editor} from "../editor/editor";
import {worldToScreen} from "../editor/geometry";
import {NOTE_FONT} from "../editor/render";
import {useEditorVersion} from "./useEditor";

/**
 * A textarea laid exactly over the note being edited, scaled with the camera.
 * The canvas draws the note's paper and skips its text while this is open;
 * every keystroke goes straight into the shared document, so others watch the
 * text appear as it is typed.
 */
export const NoteEditor = ({editor}: {editor: Editor}) => {
    useEditorVersion(editor);
    const id = editor.editing;
    const shape = id ? editor.sync.view.get(id) : undefined;
    const ref = useRef<HTMLTextAreaElement>(null);
    // Seeded once per note: while typing, our own text is the truth, even if a
    // remote write to the same note lands in between.
    const [text, setText] = useState(shape?.text ?? "");

    useEffect(() => {
        const textarea = ref.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [id]);

    if (!id || !shape) return null;

    const {zoom} = editor.camera;
    const topLeft = worldToScreen(editor.camera, {x: Math.min(shape.x, shape.x + shape.w), y: Math.min(shape.y, shape.y + shape.h)});

    return (
        <textarea
            ref={ref}
            className="note-editor"
            aria-label="Note text"
            value={text}
            // The room refuses a longer note, so the typing stops here rather
            // than in a change that could never be applied.
            maxLength={LIMITS.text}
            spellCheck
            style={{
                left: topLeft.x,
                top: topLeft.y,
                width: Math.abs(shape.w) * zoom,
                height: Math.abs(shape.h) * zoom,
                padding: 14 * zoom,
                font: NOTE_FONT,
                fontSize: 16 * zoom,
            }}
            onChange={(event) => {
                setText(event.target.value);
                editor.setNoteText(id, event.target.value);
            }}
            onBlur={() => editor.stopEditing()}
        />
    );
};
