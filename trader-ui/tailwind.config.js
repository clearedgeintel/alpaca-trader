/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        base: '#0a0b0d',
        surface: '#111318',
        elevated: '#1a1d24',
        border: '#1e2228',
        'text-primary': '#e8eaf0',
        'text-muted': '#9ca3af',
        'text-dim': '#6b7280',
        'accent-blue': '#3b82f6',
        'accent-green': '#22c55e',
        'accent-red': '#ef4444',
        'accent-amber': '#f59e0b',
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Fira Code'", 'monospace'],
        ui: ["'DM Sans'", 'sans-serif'],
      },
      keyframes: {
        'flash-green': {
          '0%': { backgroundColor: 'rgba(34, 197, 94, 0.2)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0.2)' },
          '100%': { backgroundColor: 'transparent' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'flash-green': 'flash-green 800ms ease-out',
        'flash-red': 'flash-red 800ms ease-out',
        pulse: 'pulse 2s ease-in-out infinite',
        shimmer: 'shimmer 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
