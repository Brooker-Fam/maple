import localFont from "next/font/local";

/*
 * Cormorant Garamond, the display font, from files kept here (SIL Open Font License 1.1, cormorant-garamond/OFL.txt)
 * rather than fetched from Google Fonts at build time: Google sometimes answers with /l/font?kit= links, which Next
 * 16's Turbopack can't read, and the build fails. They're the files and rules next/font/google made: one variable file
 * per script, used at 400–700 and picked by its unicode-range, so a name with Vietnamese or Cyrillic letters still
 * draws in it, and only Latin is preloaded. next/font takes literals only, so each script is a call of its own;
 * globals.css lists their families in --font-cormorant-garamond, then the fallback sized to them.
 */

const cormorantLatin = localFont({
  src: "./cormorant-garamond/normal-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  adjustFontFallback: false,
  variable: "--font-cormorant-latin",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const cormorantLatinExt = localFont({
  src: "./cormorant-garamond/normal-latin-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-latin-ext",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

const cormorantVietnamese = localFont({
  src: "./cormorant-garamond/normal-vietnamese.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-vietnamese",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
});

const cormorantCyrillic = localFont({
  src: "./cormorant-garamond/normal-cyrillic.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-cyrillic",
  declarations: [{ prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" }],
});

const cormorantCyrillicExt = localFont({
  src: "./cormorant-garamond/normal-cyrillic-ext.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-cyrillic-ext",
  declarations: [{ prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" }],
});

/** The classes that set each script's family variable, for <html>. */
export const cormorantVariables = [cormorantLatin, cormorantLatinExt, cormorantVietnamese, cormorantCyrillic, cormorantCyrillicExt].map((font) => font.variable).join(" ");
