import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17201d",
        field: "#f3f6f1",
        mint: "#3a7d64",
        lime: "#c7df74",
        rust: "#b45436",
        sky: "#4b8fb8"
      },
      boxShadow: {
        panel: "0 14px 40px rgba(23, 32, 29, 0.08)"
      }
    },
  },
  plugins: [],
};

export default config;
