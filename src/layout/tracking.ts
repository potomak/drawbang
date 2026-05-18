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

export function renderAnalytics(): string {
  return `<!-- Google tag (gtag.js) -->
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
