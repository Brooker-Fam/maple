# Maple's mark

Maple's mark is a young sugar-maple leaf on a curved stem. The right half, past the midrib, is a shade deeper than the left, so the leaf looks gently folded in light from the left. It replaced an eleven-point leaf that read as the Canadian flag. The new leaf keeps the maple's three-point crown and lobes, softens every point with a small radius, and lets the stem curve away like a leaf that has just come off the tree. The same leaf grows on Today's tree, one for every week.

## Where it lives

- **`src/lib/brand.ts`** is the one source: the outline (`LEAF_PATH`), the shaded right half (`LEAF_SHADE_PATH`), a small copy centered on 0,0 for leaves inside other drawings (`LEAF_PATH_SMALL`), its bounds and close crop, the two gradients, and the colors around it. Change the leaf there and nowhere else.
- **`scripts/brand/leaf.ts`** draws those paths: the right half as points with corner radii, two edges that swell slightly, and the stem as a tapered curve, all mirrored down the midrib. `pnpm brand:leaf` prints them; `pnpm brand:leaf --write` puts them into `brand.ts`.
- **`scripts/brand/render.ts`** (`pnpm brand:render`) redraws every icon file from `brand.ts` with sharp. Run it after any change to the leaf or its colors and commit what it writes. The output is byte-for-byte repeatable.
- In code, `MapleMark` (`src/components/MapleMark.tsx`) draws the leaf in the site and the app, and `OgLeaf` (`src/components/site/og.tsx`) draws it on social cards. `MAPLE_LEAF_PATH` in `Hero.tsx` (the small path) serves the tree, the day dial's hand, keepsakes and the loading screen, and `art.tsx` crowns the waiting sapling with it.

## Colors

| | Light half | Shaded half |
| --- | --- | --- |
| Top (amber) | `#F4A93E` | `#E2852F` |
| Middle (55%) | `#D95B2D` | `#C2472A` |
| Stem (maple red) | `#AD3820` | `#962F1D` |

Both halves share one gradient line, from the top left of the leaf to its stem. The app icon's ground is the home page's forest, lit softly from above: `#2B5240` at the light, `#183A2B`, then `#112A1F` at the edges. The dark iPhone icon uses the night look's near-black, lit the same way.

## Using it

- On cream, white, the forest or the night look, use the two-tone leaf as it is. Where only one color will do (the themed Android icon, the notification badge, a keepsake mark), fill the outline flat (`MapleMark color=…`).
- Don't recolor the halves separately, outline the leaf, put it on a busy photo, or squash it. The illustrations may tilt it, as the story section does, but the mark beside the name stays upright.
- The smallest size is 16 px, where the crown, the side lobes and the stem all still read.
- **With the name**, "Maple" is set in Cormorant Garamond 600. The leaf is about 1.25 times the type size, 7 px from the word at the site header's size, and dropped 3 px so its body sits on the word and the stem hangs like the descender of the p (`SiteHeader.tsx`).
- Keep clear space around the leaf of at least a quarter of its width.

## Files

All of these are written by `pnpm brand:render`; don't edit them by hand.

| File | What it is |
| --- | --- |
| `public/maple-icon.svg`, `public/favicon.ico` (16, 32, 48) | The tab icon: the bare leaf, cropped close. The layouts list the `.ico` as 32x32, not "any", so Chrome still picks the SVG. |
| `public/maple-apple-touch-icon.png` (180) | The iPhone Home Screen and link previews: full square, which iOS rounds. |
| `public/maple-icon-192.png`, `-512.png` | The web app's icons for browsers and desktops: a rounded square. |
| `public/maple-icon-maskable-512.png` | Android's installed web app: full bleed, with the leaf inside the 80% safe circle. |
| `public/maple-badge.png` (96) | The status-bar badge on Android notifications (only its shape shows). |
| `ios/…/AppIcon.appiconset/AppIcon-1024*.png` | The iPhone app's icon, with dark and tinted versions (iOS 18). |
| `ios/…/MapleMark.imageset/maple-mark.svg` | The leaf on the iPhone app's offline screen. Plain paths and gradients, which Xcode's SVG support reads. |
| `android/…/mipmap-*/ic_launcher_{background,foreground,monochrome}.png` | The Android app's adaptive icon layers at each density. The leaf takes the same share of the visible 72 dp as it does on iOS, and the monochrome layer is for themed icons. |
| `android/…/drawable-nodpi/maple_leaf.png` | The leaf on the Android app's offline screen. |

## Social cards

The site's cards (`src/app/(site)/**/opengraph-image.tsx`) and the invite card (`src/app/maple/join/opengraph-image.tsx`) are drawn when the site builds. The invite card is the same for every invite: the key travels after the `#`, so nothing in it can name a family.

Two things to know about the card renderer (`next/og`):

- **Font weight:** set every line at a weight the card loads (600, or 500 italic). A line at any other weight borrows letters from both faces.
- **The "Yo" gap:** a word with the pair "Yo" in it (You're, Your) is followed by a wide gap, because the renderer measures the pair unkerned and draws it kerned. Reword it; letter spacing doesn't help.
