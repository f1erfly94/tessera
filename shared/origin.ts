/**
 * Whether a WebSocket request comes from the site's own pages. Browsers always
 * send Origin with a WebSocket handshake, so a missing or foreign one means a
 * page elsewhere is trying to use a visitor's browser to write into a board.
 */
export const sameOrigin = (origin: string | null, url: URL): boolean => {
    if (!origin) return false;
    try {
        return new URL(origin).host === url.host;
    } catch {
        return false; // "null" from sandboxed frames, or garbage
    }
};
