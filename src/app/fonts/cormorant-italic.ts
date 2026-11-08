import localFont from "next/font/local";

/*
 * The public site's Cormorant Garamond Medium Italic, kept here as the display font is (see cormorant.ts): Google's
 * 500 italic files, one per script by its unicode-range, only Latin preloaded. site.css lists their families in
 * --font-site-italic.
 */

const cormorantItalicLatin = localFont({
  src: "./cormorant-garamond/italic-latin.woff2",
  weight: "500",
  style: "italic",
  display: "swap",
  adjustFontFallback: false,
  variable: "--font-cormorant-italic-latin",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const cormorantItalicLatinExt = localFont({
  src: "./cormorant-garamond/italic-latin-ext.woff2",
  weight: "500",
  style: "italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-italic-latin-ext",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

const cormorantItalicVietnamese = localFont({
  src: "./cormorant-garamond/italic-vietnamese.woff2",
  weight: "500",
  style: "italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-italic-vietnamese",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB",
    },
  ],
});

const cormorantItalicCyrillic = localFont({
  src: "./cormorant-garamond/italic-cyrillic.woff2",
  weight: "500",
  style: "italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-italic-cyrillic",
  declarations: [{ prop: "unicode-range", value: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116" }],
});

const cormorantItalicCyrillicExt = localFont({
  src: "./cormorant-garamond/italic-cyrillic-ext.woff2",
  weight: "500",
  style: "italic",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-cormorant-italic-cyrillic-ext",
  declarations: [{ prop: "unicode-range", value: "U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F" }],
});

/** The classes that set each script's family variable, for the site's frame. */
export const cormorantItalicVariables = [cormorantItalicLatin, cormorantItalicLatinExt, cormorantItalicVietnamese, cormorantItalicCyrillic, cormorantItalicCyrillicExt].map((font) => font.variable).join(" ");
