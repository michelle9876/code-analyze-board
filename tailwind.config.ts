import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "var(--color-ink)",
        canvas: "var(--color-canvas)",
        panel: "var(--color-panel)",
        line: "var(--color-line)",
        accent: "var(--color-accent)",
        accentWarm: "var(--color-accent-warm)",
        accentSoft: "var(--color-accent-soft)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)"
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"]
      },
      boxShadow: {
        halo: "0 30px 80px rgba(8, 25, 50, 0.12)",
        card: "0 12px 32px rgba(17, 27, 44, 0.08)"
      },
      backgroundImage: {
        grid: "linear-gradient(rgba(26,44,74,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(26,44,74,0.08) 1px, transparent 1px)"
      }
    }
  },
  plugins: []
};

export default config;
