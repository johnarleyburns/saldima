// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:sockets": fileURLToPath(
        new URL(
          "./packages/testkit/src/runtime/cloudflare-sockets-stub.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.runtime.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        // Low-level SQLite binary parser: the fixture test covers the real
        // path; the remaining branches are defensive format checks.
        "packages/gnucash/src/sqlite.ts",
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
