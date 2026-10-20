import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  build: { target: "es2022", sourcemap: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
