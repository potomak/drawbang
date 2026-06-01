// Single hydration channel for every Lambda-rendered surface that ships
// edge-cached SSR markup containing stateful values: like counts +
// viewer-liked state, viewer-bookmarked state, follower/following
// counts + viewer-follows state, profile pictures.
//
// On DOMContentLoaded:
//   1. Walk the page once, collect every drawing id (from
//      [data-like-target] + [data-bookmark-target]) and every username
//      (from [data-follow-target] + [data-profile-username] +
//      [data-profile-picture-username]).
//   2. Fire one GET /hydrate?drawings=…&users=… (no-store). When the
//      viewer has a session, the Bearer JWT is attached and viewer_*
//      fields populate; otherwise they're null and the relevant DOM
//      updates are skipped.
//   3. Walk again, stamp each element. One DOM pass.
//
// MutationObserver re-runs the walk for newly-appended subtrees
// (infinite scroll). To keep the URL small under infinite scroll, the
// observer only sends the diff against an already-hydrated cache of
// (drawing id, username) tuples.
//
// All read-side state lives here. The per-action scripts
// (like.js / follow.js / bookmark.js) own only their click handlers.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangHydrateInit) return;
  window.__drawbangHydrateInit = true;

  var JWT_KEY = "drawbang:jwt";
  var BATCH_MAX = 100; // matches DynamoDB BatchGetItem cap

  // Stamps so we don't re-apply or re-fetch the same target on
  // observer-driven passes.
  var seenDrawings = Object.create(null);
  var seenUsers = Object.create(null);

  function token() {
    try { return localStorage.getItem(JWT_KEY) || null; } catch (e) { return null; }
  }

  function authHeaders(t) {
    return t ? { Authorization: "Bearer " + t } : {};
  }

  // -- Collection -------------------------------------------------------------
  function collect(root) {
    var drawings = [];
    var users = [];
    function addDrawing(id) {
      if (!id || seenDrawings[id]) return;
      seenDrawings[id] = true;
      drawings.push(id);
    }
    function addUser(un) {
      if (!un || seenUsers[un]) return;
      seenUsers[un] = true;
      users.push(un);
    }
    var nodes = root.querySelectorAll(
      "[data-like-target],[data-bookmark-target],[data-follow-target],[data-profile-username],[data-profile-picture-username]",
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      addDrawing(el.getAttribute("data-like-target"));
      addDrawing(el.getAttribute("data-bookmark-target"));
      addUser(el.getAttribute("data-follow-target"));
      addUser(el.getAttribute("data-profile-username"));
      addUser(el.getAttribute("data-profile-picture-username"));
    }
    return { drawings: drawings, users: users };
  }

  // -- Fetch ------------------------------------------------------------------
  function fetchHydrate(drawings, users, t) {
    var params = [];
    if (drawings.length) params.push("drawings=" + encodeURIComponent(drawings.join(",")));
    if (users.length) params.push("users=" + encodeURIComponent(users.join(",")));
    if (!params.length) return Promise.resolve(null);
    return fetch("/hydrate?" + params.join("&"), { headers: authHeaders(t) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; });
  }

  // -- Apply ------------------------------------------------------------------
  function apply(data) {
    if (!data) return;
    if (data.drawings) applyDrawings(data.drawings);
    if (data.users) applyUsers(data.users);
  }

  function applyDrawings(map) {
    for (var id in map) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
      var d = map[id];
      // Like counts on every [data-like-count] inside a button targeting this id.
      var likeBtns = document.querySelectorAll('[data-like-target="' + cssEscape(id) + '"]');
      for (var i = 0; i < likeBtns.length; i++) {
        var countEl = likeBtns[i].querySelector("[data-like-count]");
        if (countEl && typeof d.like_count === "number") {
          countEl.textContent = String(Math.max(0, d.like_count));
        }
        if (d.viewer_liked === true) {
          likeBtns[i].setAttribute("aria-pressed", "true");
        }
      }
      if (d.viewer_bookmarked === true) {
        var bms = document.querySelectorAll('[data-bookmark-target="' + cssEscape(id) + '"]');
        for (var j = 0; j < bms.length; j++) {
          bms[j].setAttribute("aria-pressed", "true");
        }
      }
    }
  }

  function applyUsers(map) {
    var viewerUn = viewerUsername();
    for (var un in map) {
      if (!Object.prototype.hasOwnProperty.call(map, un)) continue;
      var u = map[un];
      // Follower / following counts on profile pages.
      if (typeof u.follower_count === "number") {
        var fEls = document.querySelectorAll('[data-profile-username="' + cssEscape(un) + '"] [data-follower-count]');
        for (var i = 0; i < fEls.length; i++) {
          fEls[i].textContent = String(Math.max(0, u.follower_count));
        }
      }
      if (typeof u.following_count === "number") {
        var gEls = document.querySelectorAll('[data-profile-username="' + cssEscape(un) + '"] [data-following-count]');
        for (var j = 0; j < gEls.length; j++) {
          gEls[j].textContent = String(Math.max(0, u.following_count));
        }
      }
      // Follow buttons: filled state + reveal. Hide self-targeted ones.
      var fbtns = document.querySelectorAll('[data-follow-target="' + cssEscape(un) + '"]');
      for (var k = 0; k < fbtns.length; k++) {
        var btn = fbtns[k];
        if (viewerUn && viewerUn === un) {
          // Self — Drawbang doesn't let you follow yourself. Leave hidden.
          continue;
        }
        btn.hidden = false;
        if (u.viewer_follows === true) {
          btn.setAttribute("aria-pressed", "true");
          var label = btn.querySelector(".follow-label");
          if (label) label.textContent = "Following";
        } else if (u.viewer_follows === false) {
          btn.setAttribute("aria-pressed", "false");
          var lab = btn.querySelector(".follow-label");
          if (lab) lab.textContent = "Follow";
        }
        // viewer_follows === null → logged out; leave label as SSR'd ("Follow").
      }
      // Profile picture swap. Walk both <img> and placeholder <span>.
      applyProfilePicture(un, u.profile_picture_drawing_id);
    }
  }

  function applyProfilePicture(username, drawing_id) {
    var els = document.querySelectorAll(
      '[data-profile-picture-username="' + cssEscape(username) + '"]',
    );
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var size = parseInt(el.getAttribute("data-profile-picture-size") || "44", 10);
      if (!Number.isFinite(size) || size < 8) size = 44;
      var isImg = el.tagName === "IMG";
      var hasPicture = drawing_id && /^[0-9a-f]{64}$/.test(drawing_id);
      if (hasPicture) {
        var expectedSrc = "/tiles/" + drawing_id + ".gif";
        if (isImg) {
          // Same element type — just update the src if it changed.
          var current = el.getAttribute("src") || "";
          if (current.indexOf(expectedSrc) === -1) el.setAttribute("src", expectedSrc);
        } else {
          // Placeholder → real <img>. Swap it.
          el.replaceWith(buildImg(username, drawing_id, size));
        }
      } else if (isImg) {
        // SSR had an img but the user cleared their picture → placeholder.
        el.replaceWith(buildPlaceholder(username, size));
      }
      // No picture + already placeholder = no-op.
    }
  }

  function buildImg(username, drawing_id, size) {
    var img = document.createElement("img");
    img.className = "profile-picture";
    img.src = "/tiles/" + drawing_id + ".gif";
    img.alt = username;
    img.width = size;
    img.height = size;
    img.loading = "lazy";
    img.setAttribute("data-profile-picture-username", username);
    img.setAttribute("data-profile-picture-size", String(size));
    return img;
  }

  function buildPlaceholder(username, size) {
    var span = document.createElement("span");
    span.className = "profile-picture profile-picture-placeholder";
    span.setAttribute("aria-hidden", "true");
    span.setAttribute("data-profile-picture-username", username);
    span.setAttribute("data-profile-picture-size", String(size));
    span.textContent = (username.charAt(0) || "?").toUpperCase();
    return span;
  }

  function viewerUsername() {
    try { return localStorage.getItem("drawbang:username") || null; } catch (e) { return null; }
  }

  // Minimal CSS attribute-selector escape: drawing ids are 64-hex and
  // usernames match /^[a-z0-9_][a-z0-9_-]{1,18}[a-z0-9_]$/, so there's
  // nothing to escape in practice. The helper documents the assumption
  // and isolates it for future-proofing.
  function cssEscape(value) {
    return String(value);
  }

  // -- Orchestration ----------------------------------------------------------
  function run(root) {
    var targets = collect(root);
    if (targets.drawings.length === 0 && targets.users.length === 0) return;
    var t = token();
    // Chunk over BATCH_MAX so a heavily-scrolled feed doesn't 400. We
    // fire one fetch per chunk in parallel and apply each as it lands.
    for (var off = 0; off < Math.max(targets.drawings.length, targets.users.length); off += BATCH_MAX) {
      var dchunk = targets.drawings.slice(off, off + BATCH_MAX);
      var uchunk = targets.users.slice(off, off + BATCH_MAX);
      fetchHydrate(dchunk, uchunk, t).then(apply);
    }
  }

  function startObserver() {
    if (typeof MutationObserver !== "function") return;
    var pending = false;
    var mo = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0) {
          if (pending) return;
          pending = true;
          // Microtask: coalesce a burst of insertions into one pass.
          Promise.resolve().then(function () {
            pending = false;
            run(document);
          });
          return;
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    run(document);
    startObserver();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
