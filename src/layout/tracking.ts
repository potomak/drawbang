// Third-party tracking snippets injected into every page's <head>. Kept
// out of src/layout/chrome.ts so the chrome size budget (test/chrome.test.ts)
// tracks layout DOM bloat without being skewed by vendor-mandated tracking
// strings that we can't shrink.
//
// Two consumers:
//   - vite/plugins/chrome.ts substitutes <!--CHROME:ANALYTICS--> and
//     <!--CHROME:META-PIXEL--> on every Vite-served HTML entry.
//   - Builder templates inline ${renderAnalytics()} / ${renderMetaPixel()}
//     at the same spot in their <head>.
//
// Event-firing helpers (view_item, begin_checkout, ViewContent,
// InitiateCheckout) live in src/analytics.ts and src/meta-pixel.ts — those
// are runtime wrappers around window.gtag / window.fbq.

// Google Analytics measurement ID.
export const GA_MEASUREMENT_ID = "G-5F5HPX6QYC";

// localStorage key inspected by the pre-snippet gate below AND by the
// /privacy "Don't track me" toggle that the user clicks. Setting it to
// "1" makes the next page load disable GA + Meta Pixel completely
// (no cookies, no network requests).
export const ANALYTICS_OPT_OUT_KEY = "drawbang:analytics_opt_out";

export function renderAnalytics(): string {
  // The pre-snippet gate must run BEFORE gtag.js and pixel.js load. Both
  // libraries respect their own kill-switches when set at module init,
  // and the async scripts below haven't fetched yet at this point.
  //
  // - window['ga-disable-<MID>'] = true is the documented GA4 kill-switch:
  //   gtag.js reads it on every call and short-circuits both cookie writes
  //   and the analytics beacon.
  // - window.fbq = function(){} replaces the Pixel global with a no-op
  //   before fbevents.js can install the real one; subsequent fbq('init')
  //   / fbq('track', ...) calls become no-ops.
  //
  // Triggered by navigator.doNotTrack === '1' OR a user-set localStorage
  // flag (set by the /privacy opt-out toggle). The localStorage access is
  // wrapped in try/catch for browsers that throw under file:// or strict
  // private mode.
  return `<!-- Draw! analytics opt-out gate -->
<script>
(function () {
  var dnt = (navigator.doNotTrack === '1') || (window.doNotTrack === '1');
  var optOut = false;
  try { optOut = localStorage.getItem(${JSON.stringify(ANALYTICS_OPT_OUT_KEY)}) === '1'; } catch (e) {}
  if (dnt || optOut) {
    window[${JSON.stringify("ga-disable-" + GA_MEASUREMENT_ID)}] = true;
    window.fbq = function () {};
  }
})();
</script>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', '${GA_MEASUREMENT_ID}');
</script>`;
}

// Meta (Facebook) Pixel ID. The base snippet Meta documents also includes
// a <noscript><img> fallback for JS-disabled visitors. We drop it: Vite's
// parse5 step rejects <noscript><img> inside <head> per the HTML5 spec,
// and the editor requires JS to function — there is no JS-disabled
// audience to track.
export const META_PIXEL_ID = "2264137094389658";

export function renderMetaPixel(): string {
  return `<!-- Meta Pixel Code -->
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');
</script>
<!-- End Meta Pixel Code -->`;
}
