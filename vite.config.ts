import {cloudflare} from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

// One dev server for both halves: the editor through Vite, the room Worker and
// its Durable Objects inside workerd — the same runtime that serves production.
export default defineConfig({
    plugins: [react(), cloudflare()],
});
