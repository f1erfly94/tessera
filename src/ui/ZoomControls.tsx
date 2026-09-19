import type {Editor} from "../editor/editor";
import {FitIcon, MinusIcon, PlusIcon} from "./icons";
import {useEditorVersion} from "./useEditor";

export const ZoomControls = ({editor}: {editor: Editor}) => {
    useEditorVersion(editor);
    return (
        <div className="panel zoom-controls" role="group" aria-label="Zoom">
            <button type="button" className="icon-button" aria-label="Zoom out (−)" title="Zoom out — −" onClick={() => editor.zoomBy(0.8)}>
                <MinusIcon />
            </button>
            <button type="button" className="zoom-value" title="Reset to 100% — Shift+0" onClick={() => editor.resetZoom()}>
                {Math.round(editor.camera.zoom * 100)}%
            </button>
            <button type="button" className="icon-button" aria-label="Zoom in (+)" title="Zoom in — +" onClick={() => editor.zoomBy(1.25)}>
                <PlusIcon />
            </button>
            <button type="button" className="icon-button" aria-label="Fit everything (Shift+1)" title="Fit everything — Shift+1" onClick={() => editor.fitToContent()}>
                <FitIcon />
            </button>
        </div>
    );
};
