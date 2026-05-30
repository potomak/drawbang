// Drawing-page (/d/<id>) client behaviour. Lifted out of the inline
// tile-page template per CLAUDE.md "UI/UX consistency" (hand-port pattern,
// same shape as chrome-toggle.js / chrome-identity.js / flash.js).
//
// Reads `drawing_id` + `author_username` from data attributes on the
// `<main data-tile-page>` element; expects /flash.js to be loaded.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangTilePageInit) return;
  window.__drawbangTilePageInit = true;

  function root() {
    return document.querySelector("[data-tile-page]");
  }

  function flash(kind, message, autoDismissMs) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: autoDismissMs });
  }

  function track(name, params) {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", name, params);
  }

  // -- Set-as-profile-picture ----------------------------------------------
  function wireSetProfilePicture(main) {
    var btn = document.getElementById("dr-set-profile-picture");
    if (!btn) return;
    var author = main.dataset.authorUsername || "";
    var drawingId = main.dataset.drawingId || "";
    if (!author || !drawingId) return;
    var current = null;
    var token = null;
    try {
      current = localStorage.getItem("drawbang:username");
      token = localStorage.getItem("drawbang:jwt");
    } catch (e) {
      // private mode — leave the button hidden, can't act anyway.
    }
    // Only reveal when the viewer is the signed-in author. Logged-out and
    // viewing-someone-else's-drawing both keep the button hidden.
    if (!current || !token || current !== author) return;
    btn.hidden = false;
    btn.addEventListener("click", function () {
      btn.disabled = true;
      fetch("/auth/profile-picture", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ drawing_id: drawingId }),
      })
        .then(function (res) {
          if (!res.ok) {
            return res.text().then(function (text) {
              var msg = "Failed to set profile picture";
              try {
                var j = JSON.parse(text);
                if (j && j.error) msg = j.error;
              } catch (e) {}
              throw new Error(msg);
            });
          }
        })
        .then(function () {
          btn.textContent = "Profile picture set";
          // Leave disabled — the page is cached so a refresh would show
          // the old state for up to its s-maxage TTL anyway.
          flash("success", "Profile picture updated. Visit your profile to see it.", 4000);
        })
        .catch(function (e) {
          btn.disabled = false;
          flash("error", (e && e.message) ? e.message : "Could not set profile picture");
        });
    });
  }

  // -- Copy link -----------------------------------------------------------
  function fallbackCopy(url) {
    var tmp = document.createElement("textarea");
    tmp.value = url;
    tmp.setAttribute("readonly", "");
    tmp.style.position = "fixed";
    tmp.style.top = "-9999px";
    document.body.appendChild(tmp);
    tmp.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(tmp);
    return ok;
  }

  function wireCopyLink() {
    var btn = document.getElementById("dr-copy-link");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      var url = window.location.href;
      var ok = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(url);
          ok = true;
        } else {
          ok = fallbackCopy(url);
        }
      } catch (e) {
        ok = fallbackCopy(url);
      }
      flash(ok ? "success" : "error", ok ? "Link copied" : "Could not copy — try long-pressing the URL", 1800);
      track("copy_share_link_click", {});
    });
  }

  // -- Web Share API (progressive enhancement) -----------------------------
  function wireWebShare(main) {
    var btn = document.getElementById("dr-share");
    if (!btn) return;
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") return;
    var idShort = main.dataset.idShort || "";
    var payload = {
      title: "Tile ID " + idShort,
      text: "Pixel art from Draw!",
      url: window.location.href,
    };
    if (typeof navigator.canShare === "function" && !navigator.canShare(payload)) return;
    btn.hidden = false;
    btn.addEventListener("click", async function () {
      track("share_click", { target: "web_share" });
      try {
        await navigator.share(payload);
      } catch (e) {
        if (e && e.name !== "AbortError") {
          flash("error", "Could not open share sheet", 1800);
        }
      }
    });
  }

  // -- Anchor-style action GA wiring ---------------------------------------
  function wireAnchorTracking(main) {
    var drawingId = main.dataset.drawingId || "";
    var anchors = [
      { id: "dr-make-merch",    event: "make_merch_click",   props: { drawing_id: drawingId } },
      { id: "dr-fork",          event: "fork_click",         props: { drawing_id: drawingId } },
      { id: "dr-share-threads", event: "share_click",        props: { target: "threads" } },
      { id: "dr-share-reddit",  event: "share_click",        props: { target: "reddit" } },
      { id: "dr-share-x",       event: "share_click",        props: { target: "x" } },
      { id: "dr-download-gif",  event: "gif_download_click", props: { source: "tile_page" } },
    ];
    for (var i = 0; i < anchors.length; i++) {
      (function (a) {
        var el = document.getElementById(a.id);
        if (!el) return;
        el.addEventListener("click", function () { track(a.event, a.props); });
      })(anchors[i]);
    }
  }

  function init() {
    var main = root();
    if (!main) return;
    wireSetProfilePicture(main);
    wireCopyLink();
    wireWebShare(main);
    wireAnchorTracking(main);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
