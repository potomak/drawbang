// Submit handler for the home-hero email-capture form
// ([data-subscribe-form]). POSTs /subscribe; feedback goes through the
// shared flash (house rule — no inline error text). The hidden
// `website` input is a honeypot the server silently accepts.

(function () {
  if (typeof window === "undefined") return;
  if (window.__drawbangSubscribeInit) return;
  window.__drawbangSubscribeInit = true;

  function flash(kind, message) {
    if (typeof window.drawbangShowFlash !== "function") return;
    window.drawbangShowFlash({ kind: kind, message: message, autoDismissMs: 4000 });
  }

  function track(name, params) {
    if (typeof window.gtag !== "function") return;
    window.gtag("event", name, params);
  }

  function wire(form) {
    if (form.getAttribute("data-subscribe-wired") === "1") return;
    form.setAttribute("data-subscribe-wired", "1");
    form.addEventListener("submit", async function (ev) {
      ev.preventDefault();
      var emailInput = form.querySelector('input[name="email"]');
      var trapInput = form.querySelector('input[name="website"]');
      var button = form.querySelector('button[type="submit"]');
      var email = emailInput ? emailInput.value.trim() : "";
      if (!email) return;
      if (button) button.disabled = true;
      try {
        var res = await fetch("/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email,
            website: trapInput ? trapInput.value : "",
          }),
        });
        if (res.ok) {
          if (emailInput) emailInput.value = "";
          flash("success", "You're on the list — thanks!");
          track("subscribe_submit", {});
        } else {
          flash("error", "That email doesn't look right — try again?");
        }
      } catch (e) {
        flash("error", "Could not subscribe — try again in a moment");
      } finally {
        if (button) button.disabled = false;
      }
    });
  }

  function init() {
    var forms = document.querySelectorAll("[data-subscribe-form]");
    for (var i = 0; i < forms.length; i++) wire(forms[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
