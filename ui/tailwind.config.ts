import type { Config } from "tailwindcss"

/**
 * Observatory theme — aligned to the Zeroset brand layer.
 *
 * Every color token here is a thin alias for a CSS variable defined in
 * src/index.css (space-separated rgb triplets). Adjust values in the CSS, not
 * here. The semantic names (bg-*, text-*, accent, border-*) are kept stable so
 * the rest of the app never needs to change when the palette is re-skinned.
 *
 * Shared with zeroset-inc/zeroset-site: indigo accent (#5B5FD6), the cool
 * void/graphite/steel/bone neutral ramp, Satoshi (display/UI) + IBM Plex Mono,
 * sharp 0-radius corners, and hairline borders over heavy glow.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          void: "rgb(var(--bg-void) / <alpha-value>)",
          deep: "rgb(var(--bg-deep) / <alpha-value>)",
          primary: "rgb(var(--bg-primary) / <alpha-value>)",
          surface: "rgb(var(--bg-surface) / <alpha-value>)",
          "surface-hover": "rgb(var(--bg-surface-hover) / <alpha-value>)",
          elevated: "rgb(var(--bg-elevated) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          hover: "rgb(var(--accent-hover) / <alpha-value>)",
          muted: "rgb(var(--accent) / 0.15)",
          glow: "rgb(var(--accent-glow) / <alpha-value>)",
          secondary: "rgb(var(--accent-secondary) / <alpha-value>)",
          deep: "rgb(var(--accent-deep) / <alpha-value>)",
        },
        text: {
          primary: "rgb(var(--text-primary) / <alpha-value>)",
          secondary: "rgb(var(--text-secondary) / <alpha-value>)",
          muted: "rgb(var(--text-muted) / <alpha-value>)",
        },
        border: {
          // Hairline borders: bone (fg-1) at low alpha, the way zeroset does it.
          DEFAULT: "rgb(var(--text-primary) / 0.08)",
          hover: "rgb(var(--text-primary) / 0.14)",
          accent: "rgb(var(--accent) / 0.25)",
        },
        status: {
          success: "rgb(var(--status-success) / <alpha-value>)",
          error: "rgb(var(--status-error) / <alpha-value>)",
          warning: "rgb(var(--status-warning) / <alpha-value>)",
          running: "rgb(var(--accent) / <alpha-value>)",
        },
        nebula: {
          50: "rgb(238 238 252 / <alpha-value>)",
          100: "rgb(220 221 249 / <alpha-value>)",
          200: "rgb(193 195 244 / <alpha-value>)",
          300: "rgb(163 166 238 / <alpha-value>)",
          400: "rgb(133 137 230 / <alpha-value>)",
          500: "rgb(91 95 214 / <alpha-value>)",
          600: "rgb(74 78 192 / <alpha-value>)",
          700: "rgb(63 67 184 / <alpha-value>)",
          800: "rgb(44 47 128 / <alpha-value>)",
          900: "rgb(25 27 64 / <alpha-value>)",
          950: "rgb(13 14 34 / <alpha-value>)",
        },
      },
      fontFamily: {
        display: ["Satoshi", "system-ui", "sans-serif"],
        body: ["Satoshi", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        // Sharp-corner theme — rectangular surfaces carry no radius (matches
        // zeroset-site). `rounded-full` is intentionally left at the Tailwind
        // default for genuine circles (status dots, knobs, circular progress).
        sm: "0",
        DEFAULT: "0",
        md: "0",
        lg: "0",
        xl: "0",
        "2xl": "0",
        "3xl": "0",
      },
      boxShadow: {
        // Crisp 1px accent rings over soft halos — zeroset's restrained look.
        glow: "0 0 0 1px rgba(91, 95, 214, 0.12)",
        "glow-lg": "0 0 0 1px rgba(91, 95, 214, 0.18), 0 8px 32px rgba(91, 95, 214, 0.12)",
        "glow-sm": "0 0 0 1px rgba(91, 95, 214, 0.08)",
        glass: "0 8px 32px rgba(0, 0, 0, 0.5)",
        "glass-sm": "0 4px 16px rgba(0, 0, 0, 0.4)",
        float: "0 20px 60px rgba(0, 0, 0, 0.6)",
      },
      animation: {
        "fade-in": "fadeIn 0.4s ease-out",
        "slide-up": "slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-down": "slideDown 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "slide-in-right": "slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        shimmer: "shimmer 2s linear infinite",
        indeterminate: "indeterminate 1.5s ease-in-out infinite",
        "glow-pulse": "glowPulse 2s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideDown: {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        slideInRight: {
          "0%": { opacity: "0", transform: "translateX(12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        indeterminate: {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        glowPulse: {
          "0%, 100%": { boxShadow: "0 0 0 1px rgba(91, 95, 214, 0.10)" },
          "50%": { boxShadow: "0 0 0 1px rgba(91, 95, 214, 0.22)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
      },
    },
  },
  plugins: [],
}

export default config
