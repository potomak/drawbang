# Handoff: simplify mockups (Option B)

## Goal

Replace the magenta-marker-detection workflow with the canonical Printify
approach: fetch the bare-product catalog images and use hand-measured
placeholder rects.

## Context (what's already done, on master at b5eb284)

- Compositor at `src/merch-preview.ts` letterboxes a centered square inside
  each placeholder rect (no more stretching). **Keep this.**
- `config/mockups.json` schema is now `placeholders: PlaceholderRect[]`
  (was a single `placeholder` object). **Keep this.**
- `test/mockup-config.test.ts` validates the new schema. **Keep this.**
- Existing JPEGs in `static/mockups/{tee,mug,sticker-sheet}.jpg` had the
  magenta marker bled-cleaned in place. They're fine as-is, but we'll
  replace them with bare catalog images for cleanliness.
- `scripts/probe-printify-catalog.ts` exists — read-only diagnostic that
  dumps every catalog field that could be a mockup or print rect.

## What you're doing

1. **Probe** — run
   `PRINTIFY_API_TOKEN=… npx tsx scripts/probe-printify-catalog.ts`.
   For each of the three blueprints (tee=6/99, mug=70/1, sticker=661/73),
   note the image URLs returned in `images[]` and pick the front-facing
   bare-product photo. Also note any per-variant image fields (the probe
   filters keys matching /image|mockup|preview|src|url|photo|render/i).
2. **Fetch images** — download the chosen URL for each blueprint to
   `static/mockups/{tee,mug,sticker-sheet}.<ext>` (use whatever extension
   Printify serves; the runtime CSS doesn't care).
3. **Measure rects by hand** — for each downloaded image, eyeball the
   print-area rect in mockup-pixel coordinates. Snap dims down to multiples
   of 16 (the test enforces this). Write into `config/mockups.json` as
   `placeholders[]`. The sticker sheet has 4 print spots (2×2 grid) — add 4
   entries. As a starting reference, the *previously detected* rects were:
   - tee: `{ x: 424, y: 354, w: 352, h: 432 }`
   - mug: `{ x: 379, y: 249, w: 448, h: 816 }`
   - sticker-sheet (front_1 only): `{ x: 74, y: 256, w: 496, h: 320 }`

   These were measured against the *marker* mockup, which Printify scales/
   crops the same way as the bare catalog mockup, so they're a decent first
   guess — but verify against the new images and adjust.
4. **Rewrite `scripts/fetch-printify-mockups.ts`** — replace the entire
   marker → upload → draft-product → poll → detect → clean pipeline with
   a small loop:
   - GET `/v1/catalog/blueprints/{id}.json`
   - pick `images[N]` (probably `images[0]`, or the one whose metadata
     matches "front"; document which index you picked and why)
   - download it, save to `static/mockups/<product>.<ext>`
   - leave `config/mockups.json` alone — placeholders are human-curated now

   The script becomes ~50 lines and needs only `catalog.read` scope.
5. **Delete the obsolete files**:
   - `scripts/magenta-clean.ts`
   - `scripts/clean-existing-mockups.ts`
   - `scripts/probe-printify-catalog.ts` (after the probe is done)
6. **Verify**:
   - `npm run typecheck`
   - `npm test`
   - `npm run dev`, open `/merch?d=<some-id>`, eyeball each card preview
     for: no magenta bleed, no stretching, sticker shows 4× the drawing.
7. **Commit on master**, push.

## Constraints (don't break)

- `mockups.json` schema stays `placeholders: PlaceholderRect[]`.
- Every placeholder's `width % 16 === 0` and `height % 16 === 0`.
- The compositor's centered-square fit is correct — don't undo it.
- `merch/printify.ts` is shared with the live order pipeline; only the
  `uploadImage` / `createProduct` / `pollMockup` calls in
  `scripts/fetch-printify-mockups.ts` go away. The merch order flow
  (`merch/dispatch.ts`) still needs all of `printify.ts`.

## Token handling

- The token has `catalog.read` only-need-here scope; passed as inline env
  var, never written to disk, never echoed back. Rotate after the work is
  done (Printify → Settings → Connections → API).

## Files at start of this task

```
config/mockups.json                          # schema = placeholders[]
src/merch-preview.ts                         # compositor (centered-square fit)
static/mockups/{tee,mug,sticker-sheet}.jpg   # to be replaced with bare catalog imgs
scripts/fetch-printify-mockups.ts            # to be largely rewritten
scripts/magenta-clean.ts                     # to delete
scripts/clean-existing-mockups.ts            # to delete
scripts/probe-printify-catalog.ts            # to delete after probe done
test/mockup-config.test.ts                   # keep
```

## Why this is simpler

- No marker upload, no draft product, no polling, no flood-fill, no JPEG
  re-encoding, no halo cleanup pass, no shared `magenta-clean` module.
- `catalog.read` scope is enough; no `products.write` needed.
- The placeholder rects are 5–8 numbers in JSON, set once by a human, and
  versioned with the rest of the config.
