import {defineConfig} from "@playwright/test";

const PORT = 5190;

/**
 * End-to-end tests run against the real stack: the Vite dev server with the
 * room Worker and its Durable Objects running in workerd. Every test drives
 * two separate browser contexts — two people — because a shared board can only
 * be tested honestly by sharing it.
 */
export default defineConfig({
    testDir: "e2e",
    timeout: 45_000,
    expect: {timeout: 10_000},
    fullyParallel: true,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [["list"], ["html", {open: "never"}]] : "list",
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: {width: 1280, height: 800},
        // Locally, the installed Chrome; in CI, Playwright's own Chromium.
        channel: process.env.CI ? undefined : "chrome",
        trace: "retain-on-failure",
    },
    webServer: {
        command: `npm run dev -- --port ${PORT} --strictPort`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
