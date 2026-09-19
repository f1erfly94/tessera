import {defineConfig} from "vitest/config";

// Separate from vite.config.ts on purpose: the unit tests cover pure logic
// (the document model, the sync engine, geometry) and need neither React nor workerd.
export default defineConfig({
    test: {
        environment: "node",
        include: ["shared/**/*.test.ts", "src/**/*.test.ts", "worker/**/*.test.ts"],
    },
});
