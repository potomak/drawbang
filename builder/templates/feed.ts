import { esc } from "./_escape.js";

export interface FeedView {
  base_url: string;
  build_date: string;
  drawings: { id: string; id_short: string; pub_date: string }[];
  drawings_base_url: string;
}

export default function renderFeed(v: FeedView): string {
  const items = v.drawings
    .map(
      (d) => `    <item>
      <title>${esc(d.id_short)}</title>
      <link>${esc(v.base_url)}/d/${esc(d.id)}</link>
      <guid isPermaLink="true">${esc(v.base_url)}/d/${esc(d.id)}</guid>
      <pubDate>${esc(d.pub_date)}</pubDate>
      <description><![CDATA[<img src="${v.drawings_base_url}/${d.id}.gif" width="128" height="128" style="image-rendering:pixelated" />]]></description>
    </item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>drawbang</title>
    <link>${esc(v.base_url)}/</link>
    <description>Latest pixel art from drawbang</description>
    <lastBuildDate>${esc(v.build_date)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
