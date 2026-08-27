import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrutalShell } from "./brutal-shell.js";
import type { GalleryItem } from "./gallery.js";

// /v2/d/<id> — Tailwind brutalist drawing page (Option A: hydrate/like/bookmark
// stay on the legacy toggle-handler.js + hydrate.js channel).
// TODO(#298): migrate hydrate/like/bookmark/follow to React islands
// (hydrated via src/hydrate-v2-drawing.tsx + BrutalShell includeHydrate)
// once the brutal UI proves stable. For now we keep the single legacy
// hydration channel to avoid diverging per-page state.

interface DrawingV2View {
  id: string;
  id_short: string;
  created_at: string;
  frames?: number;
  size: number;
  parent: { id: string; id_short: string } | null;
  author: {
    user_id: string;
    username: string;
    profile_picture_drawing_id: string | null;
  } | null;
  forks?: GalleryItem[];
  ancestors?: { id: string; id_short: string }[];
  like_count: number;
  public_base_url: string;
  repo_url: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function formatCreatedAtV2(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const month = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${day}, ${year} · ${hh}:${mm} UTC`;
}

function pixelSize(size: number): number {
  // Constant logical pixel size: 1 image pixel = 10 screen pixels.
  // 8→80, 16→160, 32→320, 64→640. Clamped to viewport via max-w-full.
  const s = Number.isFinite(size) ? Math.floor(size) : 16;
  return s * 10;
}

function ProfilePictureV2({
  drawingId,
  username,
  size,
}: {
  drawingId: string | null | undefined;
  username: string;
  size: number;
}): React.ReactNode {
  if (!drawingId || !/^[0-9a-f]{64}$/.test(drawingId)) return null;
  const px = Math.max(8, Math.floor(size));
  return (
    <img
      className="rounded-[4px] border border-black"
      src={`/tiles/${drawingId}.gif`}
      alt={username}
      width={px}
      height={px}
      loading="lazy"
      data-profile-picture-username={username}
      data-profile-picture-size={String(px)}
      style={{ imageRendering: "pixelated" as const }}
    />
  );
}

function DrawingV2Page(v: DrawingV2View) {
  const gif = `/tiles/${v.id}.gif`;
  const shareMp4 = `/tiles/${v.id}-large.mp4`;
  const created = formatCreatedAtV2(v.created_at);
  const framesSuffix =
    typeof v.frames === "number" && v.frames > 0
      ? ` · ${v.frames} ${v.frames === 1 ? "frame" : "frames"}`
      : "";
  const sizePx = pixelSize(v.size);
  const forks = v.forks ?? [];
  const ancestors = v.ancestors ?? [];
  const ogMeta = (
    <>
      <meta
        name="description"
        content="Pixel art from Draw! · Create your own at https://pixel.drawbang.com"
      />
      <link rel="canonical" href={`${v.public_base_url}/d/${v.id}`} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Draw!" />
      <meta property="og:title" content={`Drawing ${v.id_short}`} />
      <meta
        property="og:description"
        content="Pixel art from Draw! · Create your own pixel art at https://pixel.drawbang.com"
      />
      <meta property="og:url" content={`${v.public_base_url}/d/${v.id}`} />
      <meta property="og:image" content={`${v.public_base_url}/tiles/${v.id}-large.gif`} />
      <meta property="og:image:type" content="image/gif" />
      <meta property="og:image:width" content="960" />
      <meta property="og:image:height" content="960" />
      <meta property="og:video" content={`${v.public_base_url}/tiles/${v.id}-large.mp4`} />
      <meta
        property="og:video:secure_url"
        content={`${v.public_base_url}/tiles/${v.id}-large.mp4`}
      />
      <meta property="og:video:type" content="video/mp4" />
      <meta property="og:video:width" content="1080" />
      <meta property="og:video:height" content="1080" />
      <meta name="twitter:card" content="summary_large_image" />
    </>
  );

  return (
    <BrutalShell title={`Draw! · ${v.id_short}`} repoUrl={v.repo_url} extraHead={ogMeta}>
      <main
        data-tile-page
        data-drawing-id={v.id}
        data-id-short={v.id_short}
        data-author-username={v.author?.username ?? ""}
        data-public-base-url={v.public_base_url}
        className="flex flex-col gap-6 sm:gap-8"
      >
        {/* Top: art + meta — stacked on mobile, side-by-side on lg */}
        <section className="flex flex-col gap-6 lg:flex-row lg:gap-8">
          <div className="flex justify-center lg:justify-start">
            <div className="rounded-[4px] border border-black bg-[#f7f7f5] p-2 sm:p-3">
              <img
                src={gif}
                alt={`drawing ${v.id_short}`}
                width={sizePx}
                height={sizePx}
                loading="eager"
                className="block max-w-full"
                style={{ width: sizePx, height: sizePx, imageRendering: "pixelated" as const }}
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            <dl className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-5 font-mono text-pixel">
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                <dt className="min-w-[110px] font-medium text-zinc-600">Created</dt>
                <dd className="min-w-0 break-words">
                  <time dateTime={v.created_at}>{created}</time>
                  {framesSuffix}
                  <span className="text-zinc-500">
                    {" "}
                    · {v.size}×{v.size}
                  </span>
                </dd>
              </div>
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-3 sm:items-center">
                <dt className="min-w-[110px] font-medium text-zinc-600">Author</dt>
                <dd className="min-w-0">
                  {v.author ? (
                    <a
                      href={`/u/${v.author.username}`}
                      className="inline-flex items-center gap-2 underline decoration-black underline-offset-2 hover:bg-zinc-50 rounded-[4px] px-1 -mx-1"
                    >
                      <ProfilePictureV2
                        drawingId={v.author.profile_picture_drawing_id}
                        username={v.author.username}
                        size={16}
                      />
                      {v.author.username}
                    </a>
                  ) : (
                    <span>anonymous</span>
                  )}
                </dd>
              </div>
              {v.parent && (
                <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                  <dt className="min-w-[110px] font-medium text-zinc-600">Remixed from</dt>
                  <dd>
                    <a
                      href={`/d/${v.parent.id}`}
                      className="underline decoration-black underline-offset-2 hover:bg-zinc-50 rounded-[4px] px-1 -mx-1"
                    >
                      {v.parent.id_short}
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-3">
                <dt className="min-w-[110px] font-medium text-zinc-600">ID</dt>
                <dd>
                  <code className="rounded-[4px] border border-black bg-zinc-50 px-1.5 py-0.5 break-all">
                    {v.id_short}
                  </code>
                </dd>
              </div>
            </dl>

            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/draw?fork=${v.id}`}
                  id="dr-fork"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-[#00ffcc] px-4 py-2 font-mono text-pixel font-medium hover:bg-[#00ffcc]/90 active:translate-y-px"
                >
                  Remix
                </a>
                {/* Like — brutal button but preserves legacy data attrs for hydrate.js/toggle-handler.js.
                    TODO: migrate to React island (see file header). */}
                <button
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel font-medium hover:bg-zinc-50 active:translate-y-px"
                  type="button"
                  data-like-target={v.id}
                  aria-pressed="false"
                  aria-label="Like this drawing"
                >
                  <svg
                    className="like-icon"
                    viewBox="0 0 24 24"
                    width={20}
                    height={20}
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path d="M12 21s-7-4.35-7-10a4 4 0 0 1 7-2.65A4 4 0 0 1 19 11c0 5.65-7 10-7 10z" />
                  </svg>
                  <span className="like-count" data-like-count>
                    {v.like_count}
                  </span>
                </button>
                <button
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                  type="button"
                  data-bookmark-target={v.id}
                  aria-pressed="false"
                  aria-label="Bookmark this drawing"
                >
                  <svg
                    className="bookmark-icon"
                    viewBox="0 0 24 24"
                    width={18}
                    height={18}
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                  >
                    <path d="M6 3h12v18l-6-4-6 4z" />
                  </svg>
                </button>
                <a
                  href={`/merch?d=${v.id}&frame=0`}
                  id="dr-make-merch"
                  rel="nofollow noreferrer"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel font-medium hover:bg-zinc-50 active:translate-y-px"
                >
                  Make merch
                </a>
                <button
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                  id="dr-set-profile-picture"
                  type="button"
                  hidden
                >
                  Set as profile picture
                </button>
                <button
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                  id="dr-copy-link"
                  type="button"
                >
                  Copy link
                </button>
                <a
                  href={gif}
                  download
                  id="dr-download-gif"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                >
                  Download GIF
                </a>
                <a
                  href={shareMp4}
                  download
                  id="dr-download-mp4"
                  title="Square MP4 with chrome — Instagram-ready"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-4 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                >
                  Download MP4
                </a>
              </div>
              <div className="flex flex-wrap gap-2">
                <a
                  href={`https://www.threads.net/intent/post?text=${encodeURIComponent(`Pixel art from Draw! · Drawing ${v.id_short}`)}&url=${encodeURIComponent(`${v.public_base_url}/d/${v.id}`)}`}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  id="dr-share-threads"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                >
                  Share to Threads
                </a>
                <a
                  href={`https://www.reddit.com/submit?url=${encodeURIComponent(`${v.public_base_url}/d/${v.id}`)}&title=${encodeURIComponent(`Pixel art from Draw! · Drawing ${v.id_short}`)}`}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  id="dr-share-reddit"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                >
                  Share to Reddit
                </a>
                <a
                  href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(`${v.public_base_url}/d/${v.id}`)}&text=${encodeURIComponent(`Pixel art from Draw! · Drawing ${v.id_short}`)}`}
                  target="_blank"
                  rel="nofollow noopener noreferrer"
                  id="dr-share-x"
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                >
                  Share to X
                </a>
                <button
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                  id="dr-copy-embed"
                  type="button"
                >
                  Copy embed code
                </button>
                <button
                  className="inline-flex min-h-[44px] items-center justify-center rounded-[4px] border border-black bg-white px-3 py-2 font-mono text-pixel hover:bg-zinc-50 active:translate-y-px"
                  id="dr-share"
                  type="button"
                  hidden
                >
                  Share…
                </button>
              </div>
            </div>
          </div>
        </section>

        {ancestors.length > 0 && (
          <section className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-5">
            <p className="font-mono text-pixel font-medium">Remix chain</p>
            <ol className="flex flex-wrap gap-2">
              {ancestors.map((a) => (
                <li key={a.id}>
                  <a
                    href={`/d/${a.id}`}
                    aria-label={`Drawing ${a.id_short}`}
                    className="block rounded-[4px] border border-black overflow-hidden hover:opacity-80"
                  >
                    <img
                      src={`/tiles/${a.id}.gif`}
                      alt={`drawing ${a.id_short}`}
                      width={48}
                      height={48}
                      loading="lazy"
                      style={{ imageRendering: "pixelated" as const }}
                    />
                  </a>
                </li>
              ))}
              <li aria-current="page" className="rounded-[4px] border border-black overflow-hidden">
                <img
                  src={`/tiles/${v.id}.gif`}
                  alt={`this drawing, ${v.id_short}`}
                  width={48}
                  height={48}
                  style={{ imageRendering: "pixelated" as const }}
                />
              </li>
            </ol>
          </section>
        )}

        {forks.length > 0 && (
          <section className="flex flex-col gap-3 rounded-[4px] border border-black bg-white p-4 sm:p-5">
            <p className="font-mono text-pixel font-medium">Remixes · {forks.length}</p>
            <ul className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {forks.map((f) => (
                <li key={f.id}>
                  <a
                    href={f.href ?? `/d/${f.id}`}
                    aria-label={f.id_short}
                    className="block rounded-[4px] border border-black overflow-hidden bg-[#f7f7f5] hover:opacity-80"
                  >
                    <img
                      src={f.thumb ?? `/tiles/${f.id}.gif`}
                      alt=""
                      width={128}
                      height={128}
                      loading="lazy"
                      className="w-full h-auto aspect-square"
                      style={{ imageRendering: "pixelated" as const }}
                    />
                  </a>
                  {f.created_at && (
                    <time
                      dateTime={f.created_at}
                      className="mt-1 block font-mono text-pixel text-zinc-600"
                    >
                      {formatCreatedAtV2(f.created_at).split(" · ")[0]}
                    </time>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </BrutalShell>
  );
}

export default function renderDrawingV2(v: DrawingV2View): string {
  const html = renderToStaticMarkup(<DrawingV2Page {...v} />);
  return `<!doctype html>\n${html}`;
}
