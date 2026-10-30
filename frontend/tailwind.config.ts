import type { Config } from 'tailwindcss';

/**
 * FoodFlow design tokens (see docs/DESIGN.md).
 *  paper  #FFFFFF  ·  panel #F2F5F1  ·  line #D9E0DA
 *  ink    #10261C  (banana-leaf green-black: text and dark surfaces)
 *  holud  #F7B500  (turmeric: the single accent; always carries ink text, never thin text on white)
 *  morich #C7341A  (chili: errors)  ·  dhonia #1B7F51 (success)
 * Radii are chosen per role, not one for everything: tile 14 · control 12 · card 20 · ticket 6.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1200px' } },
    extend: {
      colors: {
        background: 'hsl(0 0% 100%)',
        foreground: 'hsl(150 40% 11%)',
        panel: 'hsl(110 15% 95%)',
        card: 'hsl(0 0% 100%)',
        muted: { DEFAULT: 'hsl(110 15% 95%)', foreground: 'hsl(145 12% 31%)' },
        border: 'hsl(135 11% 86%)',
        ring: 'hsl(150 40% 11%)',
        ink: { DEFAULT: 'hsl(150 40% 11%)', foreground: 'hsl(0 0% 100%)' },
        primary: { DEFAULT: 'hsl(44 100% 48%)', foreground: 'hsl(150 40% 11%)', deep: 'hsl(41 100% 27%)', soft: 'hsl(44 100% 93%)' },
        success: { DEFAULT: 'hsl(151 65% 28%)', soft: 'hsl(145 40% 93%)' },
        warning: { DEFAULT: 'hsl(41 100% 27%)', soft: 'hsl(44 100% 93%)' },
        destructive: { DEFAULT: 'hsl(9 77% 43%)', soft: 'hsl(9 80% 96%)' },
      },
      borderRadius: { tile: '14px', control: '12px', card: '20px', ticket: '6px' },
      fontFamily: {
        display: ['"Bricolage Grotesque Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['"Hind Siliguri"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Noto Sans Bengali', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
export default config;
