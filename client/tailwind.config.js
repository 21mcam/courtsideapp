/** @type {import('tailwindcss').Config} */

// `brand` resolves to CSS variables (set in index.css, overridden at
// runtime by theme.js) so the tenant can pick their accent color.
const brand = Object.fromEntries(
  [50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => [
    n,
    `rgb(var(--brand-${n}) / <alpha-value>)`,
  ]),
);

export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: { brand },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(0 0 0 / 0.04), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
};
