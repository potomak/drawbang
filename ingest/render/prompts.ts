import { CC_GALLERY, PER_PAGE } from "../../config/constants.js";
import {
  PROMPT_SLUG_RE,
  PROMPTS_EPOCH_ET,
  etDateString,
  promptBySlug,
  promptForDate,
} from "../../config/prompts.js";
import {
  renderPromptArchive,
  renderPromptPage,
  type PromptArchiveEntry,
  type PromptPageView,
} from "../../lib/templates/prompts.js";
import { renderGalleryFragment } from "../../lib/templates/gallery.js";
import type { RenderHandlersConfig, RenderResponse } from "./shared.js";
import { buildFragmentUrl, itemFromRow, notFound } from "./shared.js";
import { decodeCursor } from "../drawing-store.js";

const MS_PER_DAY = 86_400_000;

function etDayToUtcMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function buildPromptArchiveEntries(now: Date): PromptArchiveEntry[] {
  const today = etDateString(now);
  const first = today < PROMPTS_EPOCH_ET ? today : PROMPTS_EPOCH_ET;
  const entries: PromptArchiveEntry[] = [];
  for (let ms = etDayToUtcMs(today); ms >= etDayToUtcMs(first); ms -= MS_PER_DAY) {
    const date = new Date(ms).toISOString().slice(0, 10);
    entries.push({
      date,
      prompt: promptForDate(new Date(ms + MS_PER_DAY / 2)),
      is_today: date === today,
    });
  }
  return entries;
}

export async function renderPromptsArchiveHandler(
  cfg: RenderHandlersConfig
): Promise<RenderResponse> {
  const entries = buildPromptArchiveEntries(cfg.now ? cfg.now() : new Date());
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderPromptArchive({
      entries,
      public_base_url: cfg.publicBaseUrl,
      repo_url: cfg.repoUrl,
    }),
  };
}

export async function renderPromptPageHandler(
  cfg: RenderHandlersConfig,
  slug: string
): Promise<RenderResponse> {
  if (!PROMPT_SLUG_RE.test(slug)) return notFound(cfg);
  const prompt = promptBySlug(slug);
  if (!prompt) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const page = await cfg.drawingStore.queryByPrompt(slug, { limit: perPage });
  const next = buildFragmentUrl(`/prompts/${slug}/items`, page.next_cursor);
  const view: PromptPageView = {
    prompt,
    is_today: promptForDate(cfg.now ? cfg.now() : new Date()).slug === slug,
    items: page.items.map(itemFromRow),
    top_drawing_id: page.items[0]?.drawing_id ?? null,
    public_base_url: cfg.publicBaseUrl,
    repo_url: cfg.repoUrl,
  };
  if (next) view.next_fragment_url = next;
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderPromptPage(view),
  };
}

export async function renderPromptItemsHandler(
  cfg: RenderHandlersConfig,
  slug: string,
  rawCursor: string | null
): Promise<RenderResponse> {
  if (!PROMPT_SLUG_RE.test(slug) || !promptBySlug(slug)) return notFound(cfg);
  const perPage = cfg.perPage ?? PER_PAGE;
  const cursor = decodeCursor(rawCursor) ?? undefined;
  const page = await cfg.drawingStore.queryByPrompt(slug, { limit: perPage, cursor });
  const next = buildFragmentUrl(`/prompts/${slug}/items`, page.next_cursor);
  return {
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: CC_GALLERY,
    body: renderGalleryFragment(page.items.map(itemFromRow), next),
  };
}
