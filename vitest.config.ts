import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "fleet/**/*.test.ts", "test/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
