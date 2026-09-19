import {useSyncExternalStore} from "react";

import type {Editor} from "../editor/editor";

/**
 * Re-renders the calling component whenever the editor reports a change. The
 * editor is a plain object; this is the only bridge between it and React.
 */
export const useEditorVersion = (editor: Editor): number =>
    useSyncExternalStore(editor.subscribe, editor.getVersion, editor.getVersion);
