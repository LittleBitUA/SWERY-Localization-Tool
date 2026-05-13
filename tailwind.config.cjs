/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── DP2 / Twin Peaks palette: aged paper, burgundy, FBI dark, forest ──
        paper: {
          50:  "#f8f1e3",
          100: "#f0e6d2",
          200: "#e6d8b8",
          300: "#d4c094",
          400: "#bea170",
        },
        case: {
          900: "#120a06",
          800: "#1a120c",
          700: "#241812",
          600: "#322319",
          500: "#42301f",
          400: "#5a4226",
        },
        burgundy: {
          900: "#3a0d12",
          700: "#5d1a22",
          500: "#8b1c2b",
          400: "#a13344",
          300: "#bb5a6a",
        },
        forest: {
          900: "#0e1f17",
          700: "#1c3a2c",
          500: "#2d5a44",
        },
        cream: {
          DEFAULT: "#f5e8d0",
          dim: "#e0d4be",
        },
      },
      fontFamily: {
        serif: ['"Crimson Text"', '"EB Garamond"', "Georgia", "serif"],
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', '"Courier New"', "monospace"],
      },
    },
  },
  plugins: [],
};
