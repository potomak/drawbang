// CLI: tsx scripts/share-to-svg.ts '<share-link-or-code>' [--size N] [--background COLOR]
// Prints the SVG to stdout — pipe to a file to save:
//   tsx scripts/share-to-svg.ts 'https://drawbang.cool/#d=ABC...' > icon.svg

import { shareToSvg } from "../src/share-to-svg.js";

function main(argv: string[]): void {
  const args = argv.slice(2);
  let input: string | undefined;
  let size: number | undefined;
  let background: string | undefined;
  let mono: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--size") {
      size = Number(args[++i]);
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`--size must be a positive number, got ${args[i]}`);
      }
    } else if (a === "--background") {
      background = args[++i];
    } else if (a === "--mono") {
      mono = args[++i];
    } else if (a === "--help" || a === "-h") {
      printHelp();
      return;
    } else if (input === undefined) {
      input = a;
    } else {
      throw new Error(`unexpected extra argument: ${a}`);
    }
  }

  if (!input) {
    printHelp();
    process.exit(1);
  }

  const svg = shareToSvg(input, { size, background, mono });
  process.stdout.write(svg + "\n");
}

function printHelp(): void {
  process.stdout.write(
    "Usage: tsx scripts/share-to-svg.ts <share-link-or-code> [--size N] [--background COLOR] [--mono COLOR]\n" +
      "  --size N           SVG width/height in CSS px (default: 16, same as the bitmap)\n" +
      "  --background COLOR Fill transparent pixels with COLOR (default: leave transparent)\n" +
      "  --mono COLOR       Icon mode: drop per-pixel palette colors, fill every colored\n" +
      "                     pixel with COLOR (e.g. currentColor) via a single <g> wrapper.\n",
  );
}

main(process.argv);
