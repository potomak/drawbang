// Pre-defined retro palettes the user can pick from in the editor. Each
// palette is padded to 16 hex entries by repeating the last color when
// the source system has fewer (ZX Spectrum, TMS 9918) — the active
// palette is always 16 slots, and we don't model transparency at the
// palette level (it's a separate pixel state).
//
// Colors extracted from /tmp/retro_palettes.png with python+PIL — see
// the body of GitHub issue #193 for the source/methodology.

import { ACTIVE_PALETTE_SIZE } from "./constants.js";

export interface RetroPalette {
  id: string;
  name: string;
  /** 16 hex colors. Anything shorter is padded by `padPalette` below. */
  colors: readonly string[];
}

function padPalette(colors: readonly string[]): readonly string[] {
  if (colors.length >= ACTIVE_PALETTE_SIZE) {
    return colors.slice(0, ACTIVE_PALETTE_SIZE);
  }
  const last = colors[colors.length - 1];
  const out = colors.slice();
  while (out.length < ACTIVE_PALETTE_SIZE) out.push(last);
  return out;
}

export const RETRO_PALETTES: readonly RetroPalette[] = [
  {
    id: "c64",
    name: "Commodore 64",
    colors: padPalette([
      "#000000", "#FFFFFF", "#A14D43", "#6AC1C8",
      "#A257A5", "#5CAD5F", "#4F449C", "#CBD689",
      "#A3683A", "#6E540B", "#CC7F76", "#636363",
      "#8B8B8B", "#9BE39D", "#8A7FCD", "#AFAFAF",
    ]),
  },
  {
    id: "vic20",
    name: "Commodore VIC-20",
    colors: padPalette([
      "#000000", "#FFFFFF", "#772D26", "#85D4DC",
      "#A85FB4", "#559E4A", "#42348B", "#BDCC71",
      "#A8734A", "#E9B287", "#B66862", "#C5FFFF",
      "#E99DF5", "#92DF87", "#7E70CA", "#FFFFB0",
    ]),
  },
  {
    id: "zx-spectrum",
    name: "ZX Spectrum",
    // 15 source colors (8 normal + 7 bright; black is shared). Padded to 16
    // by repeating Bright White — we don't model transparency at the
    // palette level.
    colors: padPalette([
      "#000000", "#0000D8", "#D80000", "#D800D8",
      "#00D800", "#00D8D8", "#D8D800", "#D8D8D8",
      "#0000FF", "#FF0000", "#FF00FF", "#00FF00",
      "#00FFFF", "#FFFF00", "#FFFFFF",
    ]),
  },
  {
    id: "ega",
    name: "EGA",
    colors: padPalette([
      "#000000", "#0000AA", "#00AA00", "#00AAAA",
      "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
      "#555555", "#5555FF", "#55FF55", "#55FFFF",
      "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF",
    ]),
  },
  {
    id: "intellivision",
    name: "Intellivision",
    colors: padPalette([
      "#0C0005", "#FFFCFF", "#A7A8A8", "#FFA600",
      "#FAEA27", "#00780F", "#6CCD30", "#002DFF",
      "#5ACBFF", "#C81A7D", "#FF3276", "#3C5800",
      "#FF3E00", "#00A720", "#BD95FF", "#C9D464",
    ]),
  },
  {
    id: "tms9918",
    name: "TMS 9918 (MSX / ColecoVision / SG-1000)",
    // 15 visible colors. Source slot 0 is transparent — not modeled at
    // the palette level — so we lead with Black and pad the 16th slot
    // with the final White.
    colors: padPalette([
      "#000000", "#21C842", "#5EDC78", "#5455ED",
      "#7D76FC", "#D4524D", "#42EBF5", "#FC5554",
      "#FF7978", "#D4C154", "#E6CE80", "#21B03B",
      "#C95BBA", "#CCCCCC", "#FFFFFF",
    ]),
  },
];
