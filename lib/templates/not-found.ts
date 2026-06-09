import { renderFooter, renderHeader } from "../../src/layout/chrome.js";
import { renderHtmlShell } from "./_html-shell.js";

export interface NotFoundView {
  repo_url: string;
}

export default function renderNotFound(v: NotFoundView): string {
  return renderHtmlShell({
    title: "Draw! · Not found",
    extraHead: '<meta name="robots" content="noindex" />',
    body: `    ${renderHeader({ active: "home" })}
    <main>
      <h1 class="page-title">Page not found</h1>
      <p>
        Try the <a href="/">feed</a>, or open
        <a href="/draw">the editor</a> and draw something new.
      </p>
    </main>
    ${renderFooter({ active: "home", repoUrl: v.repo_url })}`,
  });
}
