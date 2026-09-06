import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Todos apuntan a canales rgb en :root, para soportar opacidad (`bg-rust/10`) y para
        // que `.theme-light` invierta el tema por subarbol sin tocar una sola clase.
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        panel: "rgb(var(--c-panel) / <alpha-value>)",
        field: "rgb(var(--c-field) / <alpha-value>)",
        fg: "rgb(var(--c-fg) / <alpha-value>)",
        "ink-70": "rgb(var(--c-fg2) / <alpha-value>)",
        "ink-60": "rgb(var(--c-muted) / <alpha-value>)",
        acid: "rgb(var(--c-acid) / <alpha-value>)",
        deep: "rgb(var(--c-deep) / <alpha-value>)",
        rust: "rgb(var(--c-danger) / <alpha-value>)",
        "on-danger": "rgb(var(--c-on-danger) / <alpha-value>)",
        info: "rgb(var(--c-info) / <alpha-value>)",
        sky: "rgb(var(--c-info) / <alpha-value>)",
        // alias historicos que siguen usados en el monolito
        mint: "rgb(var(--c-ok) / <alpha-value>)",
        lime: "rgb(var(--c-acid) / <alpha-value>)",
        verde: "rgb(var(--c-ok) / <alpha-value>)",
        manila: "rgb(var(--c-field) / <alpha-value>)",
        hivis: "rgb(var(--c-acid) / <alpha-value>)"
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        display: ["var(--font-display)", "var(--font-sans)", "sans-serif"]
      },
      boxShadow: {
        panel: "0 14px 40px rgba(23, 32, 29, 0.08)"
      }
    },
  },
  plugins: [],
};

export default config;
