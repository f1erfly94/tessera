import {expect, type Page, test} from "@playwright/test";

import {
    clientId,
    dragShape,
    draw,
    expectSameBoard,
    join,
    pendingCount,
    popup,
    selection,
    setOffline,
    shape,
    shapes,
    waitOnline,
} from "./helpers";

test("a shape drawn by one person appears for the other, with their cursor", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());

    const id = await draw(alice, "r", {x: 500, y: 450}, {x: 700, y: 600});
    await expect.poll(async () => (await shape(bob, id))?.type).toBe("rect");

    await alice.mouse.move(420, 320);
    await expect
        .poll(() => bob.evaluate(() => [...(window as never as {__tessera: {sync: {peers: Map<string, {cursor: unknown}>}}}).__tessera.sync.peers.values()].some((peer) => peer.cursor !== null)))
        .toBe(true);
    await expect(bob.getByRole("list", {name: "2 people here"})).toBeVisible();
});

// Two windows of one browser share storage, so each must still be its own
// client: under one id the room drops one window's changes as repeats of the
// other's, and each window takes the other's changes for echoes of its own.
const drawBothWays = async (a: Page, b: Page) => {
    // `draw` takes the first shape it had not seen for the one it drew, so each
    // side draws only once the other's shape has arrived.
    const rect = await draw(a, "r", {x: 450, y: 450}, {x: 600, y: 560});
    await expect.poll(async () => (await shape(b, rect))?.type).toBe("rect");
    const ellipse = await draw(b, "o", {x: 450, y: 600}, {x: 600, y: 700});
    await expect.poll(async () => (await shape(a, ellipse))?.type).toBe("ellipse");
    await expectSameBoard(a, b);
};

test("the second window is a second person, drawing both ways", async ({browser}) => {
    const first = await join(browser);
    const second = await popup(first, () => first.getByRole("button", {name: "Second window"}).click());
    expect(await clientId(second)).not.toBe(await clientId(first));
    await drawBothWays(first, second);
});

test("a copy of a tab becomes a client of its own", async ({browser}) => {
    // What "Duplicate tab" does: a new page that starts with a copy of this one's
    // sessionStorage, while this one is still open.
    const original = await join(browser);
    const copy = await popup(original, () => original.evaluate(() => void window.open(location.href)));
    expect(await clientId(copy)).not.toBe(await clientId(original));
    await drawBothWays(original, copy);

    // A reload is the same tab again: it keeps its id.
    const before = await clientId(copy);
    await copy.reload();
    await waitOnline(copy);
    expect(await clientId(copy)).toBe(before);
});

test("two people changing different properties of one shape both win", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());
    const id = await draw(alice, "r", {x: 500, y: 450}, {x: 700, y: 600});
    await expectSameBoard(alice, bob);

    // Alice recolours it while offline; Bob moves it meanwhile.
    await setOffline(alice, true);
    await alice.getByRole("button", {name: "Red", exact: true}).click();
    await dragShape(bob, id, 120, 80);
    const moved = await shape(bob, id);

    await setOffline(alice, false);
    await expectSameBoard(alice, bob);
    const merged = await shape(alice, id);
    expect(merged?.stroke).toBe("#e03131"); // Alice's colour
    expect(merged?.x).toBe(moved?.x); // Bob's position
    expect(merged?.y).toBe(moved?.y);
});

test("edits made offline merge when the connection comes back", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());
    const start = (await shapes(alice)).length;

    await setOffline(alice, true);
    await draw(alice, "o", {x: 450, y: 450}, {x: 560, y: 540});
    await draw(alice, "r", {x: 620, y: 450}, {x: 760, y: 560});
    await expect(alice.getByText("2 queued")).toBeVisible();
    await draw(bob, "l", {x: 400, y: 650}, {x: 800, y: 700});

    expect((await shapes(bob)).length).toBe(start + 1); // Alice's shapes have not arrived
    await setOffline(alice, false);

    await expectSameBoard(alice, bob);
    expect((await shapes(alice)).length).toBe(start + 3);
    expect(await pendingCount(alice)).toBe(0);
});

test("undo takes back only your own changes", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());

    const mine = await draw(alice, "r", {x: 450, y: 450}, {x: 600, y: 560});
    await expect.poll(async () => (await shape(bob, mine)) !== null).toBe(true);
    const theirs = await draw(bob, "o", {x: 700, y: 450}, {x: 820, y: 560});
    await expect.poll(async () => (await shape(alice, theirs)) !== null).toBe(true);

    await alice.keyboard.press("Control+z");
    await expect.poll(async () => (await shape(bob, mine)) === null).toBe(true);
    expect(await shape(bob, theirs)).not.toBeNull();

    await alice.keyboard.press("Control+Shift+z");
    await expect.poll(async () => (await shape(bob, mine)) !== null).toBe(true);
});

test("changes made offline survive a reload", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());

    await setOffline(alice, true);
    const id = await draw(alice, "r", {x: 500, y: 450}, {x: 650, y: 560});
    await alice.reload(); // the offline switch resets; the queued change is still on disk
    await waitOnline(alice);

    await expect.poll(async () => (await shape(bob, id))?.type).toBe("rect");
    await expectSameBoard(alice, bob);
});

test("a sticky note's text is typed live into the other browser", async ({browser}) => {
    const alice = await join(browser);
    const bob = await join(browser, alice.url());

    await draw(alice, "n", {x: 480, y: 440}, {x: 720, y: 600});
    const [id] = await selection(alice);
    await alice.keyboard.type("Ship it on Friday");
    await expect.poll(async () => (await shape(bob, id!))?.text).toBe("Ship it on Friday");
});
