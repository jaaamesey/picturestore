import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: { target: "es2022", sourcemap: true },
  // Module workers (HarfBuzz initialises with top-level await).
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
