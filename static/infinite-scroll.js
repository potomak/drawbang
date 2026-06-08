// Shared infinite-scroll IntersectionObserver for paginated Lambda
// templates (home, gallery legacy, profile, follow lists).
//
// Convention:
//   <some-list data-infinite-list>
//     ...items...
//     <some-sentinel
//        data-infinite-sentinel
//        data-infinite-target="[data-infinite-list]"
//        data-next="/items?cursor=…"></some-sentinel>
//   </some-list>
//
// The sentinel can be a sibling of the list (gallery legacy + profile
// page); data-infinite-target is the document-wide query used to find
// the list each time a fetch lands.
//
// On intersect: fetch data-next, append the response HTML to the list,
// remove the current sentinel, then wire whatever sentinel the new
// fragment carried.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangInfiniteScrollInit) return;
  window.__drawbangInfiniteScrollInit = true;

  function wire(sentinel) {
    if (!sentinel || sentinel.dataset.wired) return;
    sentinel.dataset.wired = "1";
    var next = sentinel.dataset.next;
    var target = sentinel.dataset.infiniteTarget;
    if (!next || !target) return;
    var io = new IntersectionObserver(async function (entries) {
      if (!entries.some(function (e) { return e.isIntersecting; })) return;
      io.disconnect();
      try {
        var res = await fetch(next);
        if (!res.ok) return;
        var html = await res.text();
        var list = document.querySelector(target);
        if (list) {
          sentinel.remove();
          list.insertAdjacentHTML("beforeend", html);
        }
        var nextSentinel = document.querySelector("[data-infinite-sentinel]:not([data-wired])");
        if (nextSentinel) wire(nextSentinel);
      } catch (e) {
        // Network/decoding error — sentinel is gone; user can refresh.
      }
    }, { rootMargin: "200px" });
    io.observe(sentinel);
  }

  function init() {
    var sentinels = document.querySelectorAll("[data-infinite-sentinel]");
    for (var i = 0; i < sentinels.length; i++) wire(sentinels[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
