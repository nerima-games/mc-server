import type { ViteUserConfig } from "vitest/config"

const config: ViteUserConfig = {
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "apps/multiplayer-shared/**/*.ts"],
      exclude: ["**/*.d.ts", "**/*.config.ts", "**/*.test.ts", "**/*.spec.ts"],
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "./coverage",
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100
      }
    }
  }
}

export default config
