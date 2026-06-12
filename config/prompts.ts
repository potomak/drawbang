// Daily drawing prompts (M3). Pure, isomorphic module — imported by both
// the Vite browser bundles and the Lambda bundle, so: no I/O, no deps.
// One prompt per Eastern-Time calendar day, picked by deterministic
// rotation through PROMPTS with optional dated OVERRIDES on top.

export interface Prompt {
  slug: string;
  title: string;
  blurb: string;
  // Challenge GUIDANCE only — rendered as a chip in the editor, never
  // enforced by the validator or ingest.
  rules?: {
    maxColors?: number;
    size?: number;
  };
}

// Rotation order matters: promptForDate indexes this array by
// days-since-epoch mod length.
export const PROMPTS: readonly Prompt[] = [
  { slug: "slime-bounce",   title: "Slime bounce",   blurb: "A blob of goo, mid-boing." },
  { slug: "campfire",       title: "Campfire",       blurb: "Crackling pixels, marshmallows optional." },
  { slug: "coin-spin",      title: "Coin spin",      blurb: "Shiny, spinny, extremely collectible." },
  { slug: "potion-bubble",  title: "Potion bubble",  blurb: "Something glugs in the flask. Probably fine." },
  { slug: "tiny-ghost",     title: "Tiny ghost",     blurb: "Boo, but make it adorable.", rules: { maxColors: 4 } },
  { slug: "rain-drop",      title: "Rain drop",      blurb: "Plip. Plop. Loop.", rules: { maxColors: 3 } },
  { slug: "heart-beat",     title: "Heart beat",     blurb: "Thump-thump, sixteen pixels of love." },
  { slug: "walk-cycle",     title: "Walk cycle",     blurb: "Left foot, right foot, forever." },
  { slug: "explosion",      title: "Explosion",      blurb: "Kaboom, one frame at a time." },
  { slug: "candle-flicker", title: "Candle flicker", blurb: "One small flame versus the dark.", rules: { maxColors: 4 } },
  { slug: "pick-up-item",   title: "Pick up item",   blurb: "Ding! Loot acquired." },
  { slug: "idle-blink",     title: "Idle blink",     blurb: "Just standing there... blinking." },
  { slug: "portal",         title: "Portal",         blurb: "A swirly door to who-knows-where." },
  { slug: "sword-slash",    title: "Sword slash",    blurb: "Swish! A quick arc of steel." },
  { slug: "chest-open",     title: "Chest open",     blurb: "Creak, gleam, treasure." },
  { slug: "footstep-dust",  title: "Footstep dust",  blurb: "Tiny puffs where a hero just ran." },
  { slug: "ui-cursor",      title: "UI cursor",      blurb: "Point, hover, click, repeat.", rules: { size: 8 } },
  { slug: "power-up",       title: "Power up",       blurb: "Glow up — literally." },
  { slug: "enemy-idle",     title: "Enemy idle",     blurb: "Lurking, looping, up to no good." },
  { slug: "victory-jingle", title: "Victory jingle", blurb: "Da-da-da-DAA, in picture form." },
  { slug: "community-choice", title: "Community choice", blurb: "You picked it. Now draw it." },
];

export const PROMPT_SLUG_RE = /^[a-z0-9-]{1,32}$/;

// Launch date of the prompts feature. Rotation day-numbers count from this
// ET calendar day; promptForDate still answers for earlier dates (the site
// must never lack a prompt).
export const PROMPTS_EPOCH_ET = "2026-06-15";

// Explicit per-day picks that beat the rotation, keyed by ET date string
// ("YYYY-MM-DD") → slug. This is how community-choice winners (or any
// special day) get scheduled. The shipped entry is pre-launch, so it's
// inert in production but keeps the override path exercised by tests.
export const OVERRIDES: Record<string, string> = {
  "2026-06-01": "tiny-ghost",
};

// Intl.DateTimeFormat construction is expensive; build it once. en-CA's
// default date format is ISO order (YYYY-MM-DD) and the named time zone
// keeps it DST-correct with zero dependencies.
const ET_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

export function etDateString(d: Date): string {
  return ET_DATE_FORMAT.format(d);
}

// Parse "YYYY-MM-DD" as a UTC midnight so day arithmetic is a pure
// 86_400_000 ms division — immune to the host machine's time zone.
function dateStringToUtcMs(s: string): number {
  const [y, m, day] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}

const EPOCH_UTC_MS = dateStringToUtcMs(PROMPTS_EPOCH_ET);
const MS_PER_DAY = 86_400_000;

export function promptForDate(d: Date): Prompt {
  const etDay = etDateString(d);
  const overrideSlug = OVERRIDES[etDay];
  if (overrideSlug !== undefined) {
    const override = promptBySlug(overrideSlug);
    // A bad override slug falls through to rotation rather than failing —
    // the site must never lack a prompt.
    if (override) return override;
  }
  const days = Math.round((dateStringToUtcMs(etDay) - EPOCH_UTC_MS) / MS_PER_DAY);
  // ((n % len) + len) % len keeps pre-epoch (negative) day numbers in range.
  const index = ((days % PROMPTS.length) + PROMPTS.length) % PROMPTS.length;
  return PROMPTS[index];
}

export function promptBySlug(slug: string): Prompt | null {
  return PROMPTS.find((p) => p.slug === slug) ?? null;
}
