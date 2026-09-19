import {useEffect, useId, useRef, useState} from "react";

import type {Editor} from "../editor/editor";
import {LinkIcon, WindowIcon} from "./icons";
import {useEditorVersion} from "./useEditor";

const initials = (name: string) =>
    name
        .split(/\s+/)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

/**
 * Closes a popover on Escape or on a click outside it.
 *
 * Escape is caught in the capture phase and stopped there: it closes the
 * popover and nothing else. Without that, the same key press reaches the
 * editor too and clears the selection the popover was opened over.
 */
const useDismiss = (open: boolean, close: () => void) => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.stopImmediatePropagation();
            close();
        };
        const onClick = (event: PointerEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) close();
        };
        window.addEventListener("keydown", onKey, {capture: true});
        window.addEventListener("pointerdown", onClick);
        return () => {
            window.removeEventListener("keydown", onKey, {capture: true});
            window.removeEventListener("pointerdown", onClick);
        };
    }, [open, close]);
    return ref;
};

const ConnectionMenu = ({editor}: {editor: Editor}) => {
    const [open, setOpen] = useState(false);
    const ref = useDismiss(open, () => setOpen(false));
    const menuId = useId();
    const pending = editor.sync.pendingCount;
    const offline = editor.manualOffline;

    // While online the queue drains every 50 ms, so counting it would only make
    // the pill flicker during a drag; it means something only when offline.
    const showQueue = editor.status !== "online" && pending > 0;
    const label =
        editor.status === "online"
            ? "Live"
            : offline
                ? "Offline"
                : editor.status === "connecting"
                  ? "Connecting…"
                  : "Reconnecting…";

    return (
        <div className="popover-anchor" ref={ref}>
            <button
                type="button"
                className={`status-pill status-${offline ? "offline" : editor.status}`}
                aria-expanded={open}
                aria-controls={menuId}
                onClick={() => setOpen((value) => !value)}
            >
                <span className="status-dot" aria-hidden="true" />
                {label}
                {showQueue && <span className="pending-count">{pending} queued</span>}
            </button>
            {open && (
                <div className="panel popover" id={menuId}>
                    <p className="popover-title">{offline ? "You are working offline" : "Connection"}</p>
                    <p className="popover-text">
                        {offline
                            ? "Keep editing — your changes are kept on this device and merge with everyone else's when you go back online."
                            : "Changes sync to everyone in the room as you make them. Try going offline: edit, then come back and watch them merge."}
                    </p>
                    {showQueue && (
                        <p className="popover-text">
                            <strong>{pending}</strong> change{pending === 1 ? "" : "s"} waiting to be sent.
                        </p>
                    )}
                    <button type="button" className="primary-button" onClick={() => editor.setManualOffline(!offline)}>
                        {offline ? "Go back online" : "Go offline"}
                    </button>
                </div>
            )}
        </div>
    );
};

const SelfAvatar = ({editor}: {editor: Editor}) => {
    const [open, setOpen] = useState(false);
    const ref = useDismiss(open, () => setOpen(false));
    const [name, setName] = useState(editor.identity.name);
    const inputId = useId();

    return (
        <div className="popover-anchor" ref={ref}>
            <button
                type="button"
                className="avatar self"
                style={{background: editor.identity.color}}
                aria-label={`You: ${editor.identity.name}. Change your name`}
                title={`${editor.identity.name} (you)`}
                onClick={() => {
                    setName(editor.identity.name);
                    setOpen((value) => !value);
                }}
            >
                {initials(editor.identity.name)}
            </button>
            {open && (
                <form
                    className="panel popover"
                    onSubmit={(event) => {
                        event.preventDefault();
                        editor.rename(name);
                        setOpen(false);
                    }}
                >
                    <label className="popover-title" htmlFor={inputId}>
                        Your name
                    </label>
                    <input id={inputId} className="text-input" value={name} maxLength={32} autoFocus onChange={(event) => setName(event.target.value)} />
                    <button type="submit" className="primary-button">
                        Save
                    </button>
                </form>
            )}
        </div>
    );
};

export const TopBar = ({editor, onCopied}: {editor: Editor; onCopied: () => void}) => {
    useEditorVersion(editor);
    const peers = [...editor.sync.peers.values()];
    const shown = peers.slice(0, 5);

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(location.href);
            onCopied();
        } catch {
            window.prompt("Copy this link", location.href);
        }
    };

    return (
        <header className="top-bar">
            <div className="panel brand-panel">
                <a href="/" className="brand" aria-label="Tessera — start a new board">
                    <span className="brand-mark" aria-hidden="true" />
                    Tessera
                </a>
                <span className="room-code" title="Room code">
                    {editor.room}
                </span>
                <button type="button" className="text-button" onClick={copyLink}>
                    <LinkIcon />
                    Share link
                </button>
                <button
                    type="button"
                    className="text-button"
                    title="Open this board in a second window, side by side"
                    // noopener: the new window starts with storage of its own
                    // instead of a copy of this one's, client id included.
                    onClick={() => window.open(location.href, "_blank", "popup,noopener,width=960,height=720")}
                >
                    <WindowIcon />
                    Second window
                </button>
            </div>

            <div className="panel people-panel">
                <ul className="avatars" aria-label={`${peers.length + 1} ${peers.length === 0 ? "person" : "people"} here`}>
                    {shown.map((peer) => (
                        <li key={peer.id} className="avatar" style={{background: peer.color}} title={peer.name}>
                            <span aria-hidden="true">{initials(peer.name)}</span>
                            <span className="sr-only">{peer.name}</span>
                        </li>
                    ))}
                    {peers.length > shown.length && <li className="avatar more">+{peers.length - shown.length}</li>}
                </ul>
                <SelfAvatar editor={editor} />
                <ConnectionMenu editor={editor} />
            </div>
        </header>
    );
};
