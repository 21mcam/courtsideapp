// Tenant-selectable accent presets. Each maps the --brand-* CSS
// variables (RGB triplets, straight from the Tailwind palette) that
// tailwind.config.js exposes as the `brand` color scale.
//
// Keys must match the `theme_accent` CHECK constraint on `tenants`
// (db/migrations/019_tenant_theme.sql).

export const DEFAULT_ACCENT = 'indigo';

export const ACCENTS = {
  indigo: {
    label: 'Indigo',
    swatch: '#4f46e5',
    vars: {
      50: '238 242 255', 100: '224 231 255', 200: '199 210 254',
      300: '165 180 252', 400: '129 140 248', 500: '99 102 241',
      600: '79 70 229', 700: '67 56 202', 800: '55 48 163', 900: '49 46 129',
    },
  },
  sky: {
    label: 'Sky',
    swatch: '#0284c7',
    vars: {
      50: '240 249 255', 100: '224 242 254', 200: '186 230 253',
      300: '125 211 252', 400: '56 189 248', 500: '14 165 233',
      600: '2 132 199', 700: '3 105 161', 800: '7 89 133', 900: '12 74 110',
    },
  },
  emerald: {
    label: 'Emerald',
    swatch: '#059669',
    vars: {
      50: '236 253 245', 100: '209 250 229', 200: '167 243 208',
      300: '110 231 183', 400: '52 211 153', 500: '16 185 129',
      600: '5 150 105', 700: '4 120 87', 800: '6 95 70', 900: '6 78 59',
    },
  },
  violet: {
    label: 'Violet',
    swatch: '#7c3aed',
    vars: {
      50: '245 243 255', 100: '237 233 254', 200: '221 214 254',
      300: '196 181 253', 400: '167 139 250', 500: '139 92 246',
      600: '124 58 237', 700: '109 40 217', 800: '91 33 182', 900: '76 29 149',
    },
  },
  rose: {
    label: 'Rose',
    swatch: '#e11d48',
    vars: {
      50: '255 241 242', 100: '255 228 230', 200: '254 205 211',
      300: '253 164 175', 400: '251 113 133', 500: '244 63 94',
      600: '225 29 72', 700: '190 18 60', 800: '159 18 57', 900: '136 19 55',
    },
  },
  slate: {
    label: 'Slate',
    swatch: '#0f172a',
    vars: {
      50: '248 250 252', 100: '241 245 249', 200: '226 232 240',
      300: '203 213 225', 400: '148 163 184', 500: '100 116 139',
      600: '51 65 85', 700: '30 41 59', 800: '15 23 42', 900: '2 6 23',
    },
  },
  // Black & green (first user: Momentum Sports Training). Green
  // through 600 (buttons/links), near-black 800/900 so dark surfaces
  // read black rather than forest.
  court: {
    label: 'Court',
    swatch: '#16a34a',
    vars: {
      50: '240 253 244', 100: '220 252 231', 200: '187 247 208',
      300: '134 239 172', 400: '74 222 128', 500: '34 197 94',
      600: '22 163 74', 700: '21 128 61', 800: '20 44 30', 900: '10 22 15',
    },
  },
};

export function applyAccent(key) {
  const accent = ACCENTS[key] || ACCENTS[DEFAULT_ACCENT];
  const root = document.documentElement;
  for (const [step, rgb] of Object.entries(accent.vars)) {
    root.style.setProperty(`--brand-${step}`, rgb);
  }
}
