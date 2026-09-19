import {sameOrigin} from "../shared/origin";
import {ROOM_ID_PATTERN} from "../shared/protocol";

export {Room} from "./room";

/**
 * Everything except /api/* is the editor's static files, served by Cloudflare
 * before this code runs (see `run_worker_first` in wrangler.jsonc). This
 * handler only upgrades room sockets and hands them to the room's Durable
 * Object — one object per room id, anywhere in the world.
 */
export default {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/api/health") return Response.json({ok: true});

        const match = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
        if (!match || !ROOM_ID_PATTERN.test(match[1]!)) return new Response("Not found", {status: 404});

        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket upgrade", {status: 426});
        }
        // Browsers always send Origin on WebSocket requests. Only the site's own
        // pages may open a room socket — a page elsewhere cannot use a visitor's
        // browser to write into a board.
        if (!sameOrigin(request.headers.get("Origin"), url)) return new Response("Forbidden", {status: 403});

        const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]!));
        return room.fetch(request);
    },
} satisfies ExportedHandler<Env>;
