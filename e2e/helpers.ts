import {type Browser, expect, type Page} from "@playwright/test";

import type {Op} from "../shared/doc";
import type {Shape} from "../shared/shape";

/** What the tests read from the page: the editor that development builds expose. */
interface TestWindow {
    __tessera: {
        status: string;
        selection: Set<string>;
        camera: {x: number; y: number; zoom: number};
        shapes: readonly Shape[];
        manualOffline: boolean;
        sync: {
            clientId: string;
            view: Map<string, Shape>;
            pendingCount: number;
            peers: Map<string, {name: string; cursor: [number, number] | null}>;
            commit: (ops: Op[]) => void;
        };
    };
}

export type Person = {page: Page; name: string};

/** A new person in a fresh browser context, on `url` or on a brand-new board. */
export const join = async (browser: Browser, url = "/"): Promise<Page> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url);
    await waitOnline(page);
    return page;
};

export const waitOnline = (page: Page) =>
    page.waitForFunction(() => (window as unknown as TestWindow).__tessera?.status === "online");

export const shapes = (page: Page) =>
    page.evaluate(() => [...(window as unknown as TestWindow).__tessera.shapes]);

export const shape = (page: Page, id: string) =>
    page.evaluate((shapeId) => (window as unknown as TestWindow).__tessera.sync.view.get(shapeId) ?? null, id);

export const selection = (page: Page) =>
    page.evaluate(() => [...(window as unknown as TestWindow).__tessera.selection]);

export const pendingCount = (page: Page) =>
    page.evaluate(() => (window as unknown as TestWindow).__tessera.sync.pendingCount);

export const clientId = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).__tessera.sync.clientId);

/**
 * Puts `count` rectangles on the board as one edit — far more operations than
 * the room takes in a single change. Drawing that many by hand would take the
 * test minutes; what is under test is what the editor does with the edit.
 */
export const addRectangles = (page: Page, count: number) =>
    page.evaluate((many) => {
        const ops = Array.from({length: many}, (_, index) => ({
            t: "create" as const,
            shape: {id: `bulk${index}`, type: "rect" as const, x: index * 4, y: 0, w: 3, h: 3, stroke: "#1e1e1e", fill: null, strokeWidth: 2, z: "a0"},
        }));
        (window as unknown as TestWindow).__tessera.sync.commit(ops);
    }, count);

/** A window the page opens itself, once its board is live. */
export const popup = async (page: Page, open: () => Promise<unknown>): Promise<Page> => {
    const [opened] = await Promise.all([page.waitForEvent("popup"), open()]);
    await waitOnline(opened);
    return opened;
};

/** Screen position of a world point on this page's camera. */
export const toScreen = (page: Page, x: number, y: number) =>
    page.evaluate(
        ([worldX, worldY]) => {
            const {camera} = (window as unknown as TestWindow).__tessera;
            return {x: (worldX! - camera.x) * camera.zoom, y: (worldY! - camera.y) * camera.zoom};
        },
        [x, y],
    );

/** Draws with a tool by dragging between two screen points; returns the new shape's id. */
export const draw = async (page: Page, toolKey: string, from: {x: number; y: number}, to: {x: number; y: number}) => {
    const before = new Set((await shapes(page)).map((item) => item.id));
    await page.keyboard.press(toolKey);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {steps: 4});
    await page.mouse.move(to.x, to.y, {steps: 4});
    await page.mouse.up();
    const created = (await shapes(page)).find((item) => !before.has(item.id));
    expect(created, "a shape was created").toBeTruthy();
    return created!.id;
};

/** Drags the shape with `id` by (dx, dy) screen pixels, grabbing it at its centre. */
export const dragShape = async (page: Page, id: string, dx: number, dy: number) => {
    await page.keyboard.press("v");
    const target = await shape(page, id);
    const centre = await toScreen(page, target!.x + target!.w / 2, target!.y + target!.h / 2);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + dx / 2, centre.y + dy / 2, {steps: 5});
    await page.mouse.move(centre.x + dx, centre.y + dy, {steps: 5});
    await page.mouse.up();
};

export const setOffline = async (page: Page, offline: boolean) => {
    await page.getByRole("button", {name: /Live|Offline|Connecting|Reconnecting/}).click();
    await page.getByRole("button", {name: offline ? "Go offline" : "Go back online"}).click();
    await page.keyboard.press("Escape");
    if (!offline) await waitOnline(page);
};

/** Resolves once both pages hold exactly the same board. */
export const expectSameBoard = async (a: Page, b: Page) => {
    await expect
        .poll(async () => JSON.stringify(await shapes(a)) === JSON.stringify(await shapes(b)), {
            message: "both people see the same board",
        })
        .toBe(true);
};
