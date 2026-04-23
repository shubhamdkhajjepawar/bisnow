"use strict";

const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.PROXY_TOKEN || "change-me-secret-token";

// ─────────────────────────────────────────
// IN-MEMORY CACHE (IMPORTANT)
// ─────────────────────────────────────────
let CACHE = {
  data: [],
  lastUpdated: null
};

// ─────────────────────────────────────────
// SMART SCROLL (LOAD ALL DATA)
// ─────────────────────────────────────────
async function autoScroll(page) {
  let lastCount = 0;

  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 2500));

    const count = await page.evaluate(() =>
      document.querySelectorAll("a[href*='/news/deal-sheet/']").length
    );

    console.log("Loaded:", count);

    if (count === lastCount) break;
    lastCount = count;
  }
}

// ─────────────────────────────────────────
// STRUCTURED PARSER
// ─────────────────────────────────────────
function extractDeals(text) {
  const lower = text.toLowerCase();

  let type = null;
  if (lower.includes("lease")) type = "Lease";
  if (lower.includes("sold") || lower.includes("acquired")) type = "Sale";

  if (!type) return null;

  const priceMatch = text.match(/\$[\d,.]+ ?(million|billion)?/i);
  const sizeMatch = text.match(/([\d,]+)\s*(SF|square feet)/i);

  return {
    type,
    price: priceMatch ? priceMatch[0] : null,
    size: sizeMatch ? sizeMatch[0] : null,
    details: text
  };
}

// ─────────────────────────────────────────
// SCRAPER (RUN ONCE)
// ─────────────────────────────────────────
async function scrapeDeals() {
  console.log("Running scraper...");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox"]
  });

  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 900 });

  await page.goto("https://www.bisnow.com/dallas-ft-worth", {
    waitUntil: "networkidle2"
  });

  await autoScroll(page);

  // Extract links
  const deals = await page.evaluate(() =>
    Array.from(
      new Map(
        [...document.querySelectorAll("a[href*='/news/deal-sheet/']")]
          .map(el => ({
            title: el.innerText.trim(),
            url: el.href
          }))
          .filter(d => d.title.length > 20)
          .map(d => [d.url, d])
      ).values()
    )
  );

  console.log("Total links:", deals.length);

  // Extract details
  const results = [];

  for (let deal of deals.slice(0, 40)) {
    try {
      const p = await browser.newPage();

      await p.goto(deal.url, { waitUntil: "domcontentloaded" });

      const paragraphs = await p.evaluate(() =>
        Array.from(document.querySelectorAll("p"))
          .map(p => p.innerText.trim())
          .filter(t => t.length > 60)
      );

      await p.close();

      const structured = paragraphs
        .map(extractDeals)
        .filter(d => d);

      results.push({
        title: deal.title,
        url: deal.url,
        deals: structured
      });

    } catch (e) {
      results.push({ ...deal, deals: [] });
    }
  }

  await browser.close();

  CACHE.data = results;
  CACHE.lastUpdated = new Date();

  console.log("Cache updated");

  return results;
}

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
function checkToken(req, res, next) {
  if (req.headers["x-proxy-token"] !== TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─────────────────────────────────────────
// GET DEALS (PAGINATION)
// ─────────────────────────────────────────
app.get("/deals", checkToken, async (req, res) => {
  try {
    const offset = parseInt(req.query.offset || "0");
    const limit = parseInt(req.query.limit || "10");

    // If cache empty → scrape once
    if (CACHE.data.length === 0) {
      await scrapeDeals();
    }

    const paginated = CACHE.data.slice(offset, offset + limit);

    res.json({
      total: CACHE.data.length,
      offset,
      limit,
      lastUpdated: CACHE.lastUpdated,
      data: paginated
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// MANUAL REFRESH (OPTIONAL)
// ─────────────────────────────────────────
app.get("/refresh", checkToken, async (req, res) => {
  await scrapeDeals();
  res.json({ message: "Data refreshed" });
});

// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});