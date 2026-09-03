// Minimal CDP driver: navigate a page target, wait for load, screenshot.
// Usage: bun /tmp/cdp.js <wsUrl> <url> <outPng>
const [wsUrl, url, out] = process.argv.slice(2);
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error("ws open failed"));
});
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  } else if (m.method === "Page.loadEventFired" && onLoad) {
    onLoad();
  }
};
let onLoad = null;
await send("Page.enable");
const loaded = new Promise((r) => {
  onLoad = r;
});
await send("Page.navigate", { url });
await Promise.race([loaded, new Promise((r) => setTimeout(r, 15000))]);
await new Promise((r) => setTimeout(r, 1200));
const shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(out, Buffer.from(shot.data, "base64"));
const evaled = await send("Runtime.evaluate", {
  expression:
    "document.title + ' | ' + location.href + ' | status:' + (document.querySelector('h1,p')?.textContent?.slice(0,80) || '')",
  returnByValue: true,
});
console.log(evaled.result.value);
ws.close();
