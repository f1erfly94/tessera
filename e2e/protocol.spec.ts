import {expect, test} from "@playwright/test";

import {join, shapes} from "./helpers";

/**
 * The room is public, so the server must hold its ground against a client that
 * does not play by the rules. These talk to it over a raw socket from the page,
 * the way a hostile script would.
 */
test("the room refuses malformed, oversized and impersonated changes", async ({browser}) => {
    const page = await join(browser);
    const before = await shapes(page);

    const replies = await page.evaluate(async () => {
        const room = location.pathname.split("/")[2];
        const socket = new WebSocket(`ws://${location.host}/api/rooms/${room}/ws`);
        const received: {type: string; message?: string; n?: number}[] = [];
        socket.addEventListener("message", (event) => received.push(JSON.parse(event.data as string)));
        await new Promise((resolve) => socket.addEventListener("open", resolve));

        const send = (message: unknown) => socket.send(JSON.stringify(message));
        const shape = {id: "evil", type: "rect", x: 0, y: 0, w: 10, h: 10, stroke: "#000000", fill: null, strokeWidth: 2, z: "a0"};

        send({type: "hello", v: 1, client: "attacker", name: "Mallory", color: "#000000"});
        await new Promise((resolve) => setTimeout(resolve, 300));
        send({type: "change", change: {client: "someone-else", n: 1, ops: [{t: "create", shape}]}}); // not who we said we were
        send({type: "change", change: {client: "attacker", n: 1, ops: [{t: "create", shape: {...shape, stroke: "red"}}]}}); // invalid colour
        send({type: "change", change: {client: "attacker", n: 1, ops: [{t: "update", id: "welcome-rect", patch: {type: "note"}}]}}); // change identity
        send({type: "change", change: {client: "attacker", n: 1, ops: [{t: "create", shape: {...shape, x: Number.MAX_VALUE}}]}});
        socket.send("not json at all");
        await new Promise((resolve) => setTimeout(resolve, 500));
        socket.close();
        return received.filter((message) => message.type === "error").map((message) => message.message);
    });

    expect(replies).toEqual([
        "Change from an unknown client.",
        "Malformed message.",
        "Malformed message.",
        "Malformed message.",
        "Malformed message.",
    ]);
    // Nothing reached the board.
    await page.waitForTimeout(300);
    expect(await shapes(page)).toEqual(before);
});

