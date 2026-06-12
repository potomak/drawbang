import { esc } from "./_escape.js";

export interface FeedItem {
  id: string;
  id_short: string;
  pub_date: string;
  // Default to the legacy single-drawing convention; canvases pass /c/ + composite.
  href?: string;
  thumb?: string;
}

export interface FeedView {
  base_url: string;
  build_date: string;
  drawings: FeedItem[];
}

export default function renderFeed(v: FeedView): string {
  const items = v.drawings
    .map((d) => {
      const link = `${v.base_url}${d.href ?? `/t/${d.id}`}`;
      const thumb = `${v.base_url}${d.thumb ?? `/tiles/${d.id}.gif`}`;
      return `    <item>
      <title>${esc(d.id_short)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${esc(d.pub_date)}</pubDate>
      <description><![CDATA[<img src="${thumb}" width="128" height="128" style="image-rendering:pixelated" />]]></description>
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Draw!</title>
    <link>${esc(v.base_url)}/</link>
    <description>Latest pixel art from Draw!</description>
    <lastBuildDate>${esc(v.build_date)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
