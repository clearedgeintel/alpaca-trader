/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        base: '#080a0d',
        surface: '#101318',
        elevated: '#171b22',
        hover: '#1d232c',
        border: '#252b35',
        'border-soft': '#1a2028',
        'text-primary': '#edf0f5',
        'text-muted': '#a4acb8',
        'text-dim': '#687282',
        'accent-blue': '#4f8cff',
        'accent-green': '#20d17d',
        'accent-red': '#ff5f68',
        'accent-amber': '#f6b44b',
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
        'slide-in': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'flash-green': 'flash-green 800ms ease-out',
        'flash-red': 'flash-red 800ms ease-out',
        pulse: 'pulse 2s ease-in-out infinite',
        shimmer: 'shimmer 1.5s ease-in-out infinite',
        'slide-in': 'slide-in 300ms ease-out',
      },
    },
  },
  plugins: [],
}
