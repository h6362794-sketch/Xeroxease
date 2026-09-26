import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/features/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // XeroxEase brand tokens (indigo-charcoal / silver / electric violet highlights)
        navy: {
          950: "#06060d",
          900: "#0a0b16",
          800: "#0f1120",
          700: "#151830",
          600: "#1d2140",
          500: "#293056",
          400: "#3b4378",
        },
        silver: {
          50: "#f6f8fb",
          100: "#e9edf3",
          200: "#d4dbe6",
          300: "#b7c2d2",
          400: "#93a3ba",
          500: "#6f839e",
        },
        accent: {
          DEFAULT: "#7c5cff",
          soft: "#a78bfa",
          muted: "#6858f0",
          glow: "rgba(124,92,255,0.35)",
        },
        surface: {
          DEFAULT: "#0d0f1a",
          raised: "#111322",
          overlay: "#161a2c",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "sans-serif"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
      },
      boxShadow: {
        glow: "0 0 24px 2px rgba(124,92,255,0.28)",
        "glow-sm": "0 0 12px 1px rgba(124,92,255,0.2)",
        card: "0 8px 30px rgba(2,8,20,0.35)",
        inset: "inset 0 1px 0 0 rgba(255,255,255,0.04)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0px)" },
          "50%": { transform: "translateY(-10px)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.6" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s linear infinite",
        float: "float 6s ease-in-out infinite",
        "fade-in": "fade-in 0.4s ease-out both",
        "pulse-soft": "pulse-soft 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
