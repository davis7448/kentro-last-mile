import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Config deliberadamente estrecha.
 *
 * Existe por un fallo concreto: un `useMemo` colocado despues de un `return` anticipado en
 * SellerView. En el PC nunca se noto (la cache tenia los datos en el primer render) y en un
 * movil sin cache tumbaba la app entera con React #310. `rules-of-hooks` lo detecta al escribirlo.
 *
 * No se activa el resto del plugin (trae las reglas del React Compiler) para que el linter siga
 * siendo util: en un archivo de 9.400 lineas, cientos de avisos equivalen a ninguno.
 */
export default [
  { ignores: [".next/**", "node_modules/**", "functions/lib/**", "public/**", "design/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } }
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Rompe la app en produccion. Nunca un aviso.
      "react-hooks/rules-of-hooks": "error",
      // Causa datos rancios, no caidas. Aviso para no bloquear el build de golpe.
      "react-hooks/exhaustive-deps": "warn"
    }
  }
];
