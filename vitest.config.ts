import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mismo alias que tsconfig, para que las pruebas puedan importar modulos de la app.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
