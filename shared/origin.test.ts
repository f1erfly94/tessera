import {describe, expect, it} from "vitest";

import {sameOrigin} from "./origin";

describe("sameOrigin", () => {
    const url = new URL("https://tessera.example.dev/api/rooms/abcdefgh/ws");

    it("accepts the site's own pages", () => {
        expect(sameOrigin("https://tessera.example.dev", url)).toBe(true);
    });

    it.each([
        ["another site", "https://evil.example"],
        ["a look-alike subdomain", "https://tessera.example.dev.evil.example"],
        ["another port", "https://tessera.example.dev:8443"],
        ["a sandboxed frame", "null"],
        ["garbage", "::::"],
        ["no origin at all", null],
    ])("refuses %s", (_label, origin) => {
        expect(sameOrigin(origin, url)).toBe(false);
    });
});
