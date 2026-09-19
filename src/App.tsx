import {ROOM_ID_PATTERN} from "../shared/protocol";
import {randomId} from "./sync/storage";
import {Bench} from "./ui/Bench";
import {Board} from "./ui/Board";

export type Route = {page: "board"; room: string} | {page: "bench"} | {page: "missing"};

/**
 * Three routes, no router: "/" opens a fresh board, "/r/<id>" is a board,
 * "/bench" is the rendering benchmark.
 *
 * Resolved once, before React renders: a fresh board's id goes into the URL
 * straight away — so the address bar is already the link to share — and doing
 * that during render would run twice in development and mint two ids.
 */
export const resolveRoute = (): Route => {
    const path = location.pathname;
    if (path === "/bench") return {page: "bench"};

    const match = /^\/r\/([^/]+)\/?$/.exec(path);
    if (match && ROOM_ID_PATTERN.test(match[1]!)) return {page: "board", room: match[1]!};

    if (path === "/" || path === "") {
        const room = randomId(10);
        history.replaceState(null, "", `/r/${room}`);
        return {page: "board", room};
    }
    return {page: "missing"};
};

export const App = ({route}: {route: Route}) => {
    if (route.page === "bench") return <Bench />;
    if (route.page === "board") return <Board room={route.room} />;
    return (
        <main className="not-found">
            <h1>No board here</h1>
            <p>This link does not point to a board.</p>
            <a className="primary-button" href="/">
                Start a new board
            </a>
        </main>
    );
};
