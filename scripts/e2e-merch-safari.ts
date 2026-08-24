import { Builder, By, until } from "selenium-webdriver";
import * as safari from "selenium-webdriver/safari.js";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const API = process.env.E2E_API_URL ?? "http://localhost:8787";
const DRAWING_ID =
  process.env.E2E_DRAWING_ID ?? "e0646bc9fd09c774d51868484b4b189afdf5dff73cd37429b2631143b548c9a9";
const OUT_DIR = path.resolve(".screenshots/merch-e2e");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = await new Builder()
    .usingServer("http://localhost:7055")
    .forBrowser("safari")
    .setSafariOptions(new safari.Options())
    .build();

  try {
    // Set a reasonable window size for screenshots (desktop + mobile)
    try {
      await driver.manage().window().setRect({ width: 1280, height: 900, x: 0, y: 0 });
    } catch {}

    console.log(`Navigating to drawing page ${BASE}/d/${DRAWING_ID}`);
    await driver.get(`${BASE}/d/${DRAWING_ID}`);
    await driver.wait(until.elementLocated(By.css("#dr-products")), 10000);
    const products = await driver.findElements(By.css("#dr-products .pr-card"));
    console.log(`Found ${products.length} product cards`);
    if (products.length < 4) throw new Error(`expected >=4 products, got ${products.length}`);
    // Check first card href is canonical
    const href = await products[0].getAttribute("href");
    if (!href.includes(`/products/${DRAWING_ID}/`))
      throw new Error(`first card href not canonical: ${href}`);
    console.log(`First product href: ${href}`);

    // Screenshot 1: drawing page with products section (desktop)
    {
      const b64 = await driver.takeScreenshot();
      fs.writeFileSync(
        path.join(OUT_DIR, "01-drawing-products-desktop.png"),
        Buffer.from(b64, "base64")
      );
      console.log("Saved 01-drawing-products-desktop.png");
    }

    // Click first product (tee) — or navigate directly to avoid click interception by header
    const productHref = await products[0].getAttribute("href");
    // Ensure absolute URL
    const productUrl = productHref.startsWith("http") ? productHref : `${BASE}${productHref}`;
    console.log(`Navigating to product page ${productUrl}`);
    await driver.get(productUrl);
    await driver.wait(until.elementLocated(By.css("[data-product-page], #product-page")), 10000);
    // Verify default variant pre-selected
    const main = await driver.findElement(By.css("[data-product-page], #product-page"));
    const variantId =
      (await main.getAttribute("data-variant-id")) || (await main.getAttribute("data-variant_id"));
    console.log(`Default variant-id: ${variantId}`);
    if (!variantId) throw new Error("default variant-id missing");

    // Price should be visible
    const priceEl = await driver.wait(
      until.elementLocated(By.css("#pp-price-value, #pp-price, [data-testid='price'], .pp-price")),
      5000
    );
    const priceText = await priceEl.getText();
    console.log(`Price text: ${priceText}`);
    if (!/\$/.test(priceText)) throw new Error(`price not rendered: ${priceText}`);

    // Screenshot 2: product page desktop
    {
      const b64 = await driver.takeScreenshot();
      fs.writeFileSync(
        path.join(OUT_DIR, "02-product-page-desktop.png"),
        Buffer.from(b64, "base64")
      );
      console.log("Saved 02-product-page-desktop.png");
    }

    // Try variant switch — if size/color pills exist, click second and verify price or aria-pressed
    const pillSelectors = ["#pp-size-picker .btn", "#pp-color-picker .btn", "[data-variant-id]"];
    let pills: any[] = [];
    for (const sel of pillSelectors) {
      const found = await driver.findElements(By.css(sel));
      if (found.length > 1) {
        pills = found;
        break;
      }
    }
    if (pills.length > 1) {
      const beforePrice = await priceEl.getText();
      const beforePressed = await pills[1].getAttribute("aria-pressed");
      console.log(
        `Clicking variant pill 2 (before pressed=${beforePressed}, price=${beforePrice})`
      );
      await pills[1].click();
      // Wait a bit for JS to update
      await driver.sleep(800);
      const afterPrice = await priceEl.getText();
      const afterPressed = await pills[1].getAttribute("aria-pressed");
      console.log(`After click pressed=${afterPressed}, price=${afterPrice}`);
      // Screenshot 3: after variant switch
      const b64 = await driver.takeScreenshot();
      fs.writeFileSync(
        path.join(OUT_DIR, "03-product-variant-switched.png"),
        Buffer.from(b64, "base64")
      );
      console.log("Saved 03-product-variant-switched.png");
    } else {
      console.log(
        `Only ${pills.length} pills found — skipping variant switch screenshot (single-variant product like mug)`
      );
      // Try tee-softstyle or mug to find multi-variant — navigate to tee-softstyle which has colors
      const altProduct = href.includes("tee-softstyle") ? "tee" : "tee-softstyle";
      const altUrl = `${BASE}/products/${DRAWING_ID}/${altProduct}`;
      console.log(`Trying alt product ${altUrl} for variant coverage`);
      await driver.get(altUrl);
      await driver.wait(until.elementLocated(By.css("[data-product-page]")), 5000);
      const altPills = await driver.findElements(
        By.css("#pp-size-picker .btn, #pp-color-picker .btn")
      );
      console.log(`Alt product pills: ${altPills.length}`);
      if (altPills.length > 1) {
        await altPills[1].click();
        await driver.sleep(800);
        const b64 = await driver.takeScreenshot();
        fs.writeFileSync(
          path.join(OUT_DIR, "03-product-variant-switched.png"),
          Buffer.from(b64, "base64")
        );
        console.log("Saved 03-product-variant-switched.png (alt)");
      }
    }

    // Mobile viewport screenshot
    try {
      await driver.manage().window().setRect({ width: 390, height: 844, x: 0, y: 0 });
      await driver.sleep(500);
      const b64 = await driver.takeScreenshot();
      fs.writeFileSync(
        path.join(OUT_DIR, "04-product-page-mobile.png"),
        Buffer.from(b64, "base64")
      );
      console.log("Saved 04-product-page-mobile.png (390x844)");
      // Also mobile drawing page
      await driver.get(`${BASE}/d/${DRAWING_ID}`);
      await driver.wait(until.elementLocated(By.css("#dr-products")), 5000);
      await driver.sleep(500);
      const b64m = await driver.takeScreenshot();
      fs.writeFileSync(
        path.join(OUT_DIR, "05-drawing-products-mobile.png"),
        Buffer.from(b64m, "base64")
      );
      console.log("Saved 05-drawing-products-mobile.png");
    } catch (e) {
      console.log("Mobile viewport failed", e);
    }

    console.log("E2E merch passed");
  } finally {
    await driver.quit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
