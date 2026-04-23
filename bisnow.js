"use strict";

const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.PROXY_TOKEN || "change-me-secret-token";

// ─────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────
let CACHE = {
  data: [],
  lastUpdated: null
};

// ─────────────────────────────────────────
// SCROLL
// ─────────────────────────────────────────
async function autoScroll(page) {
  let lastCount = 0;

  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 2500));

    const count = await page.evaluate(() =>
      document.querySelectorAll("a[href*='/news/deal-sheet/']").length
    );

    if (count === lastCount) break;
    lastCount = count;
  }
}

// ─────────────────────────────────────────
// HELPER FUNCTIONS
// ─────────────────────────────────────────
function extractCompany(text, keywords) {
  for (let k of keywords) {
    const regex = new RegExp(`([A-Z][A-Za-z&.\\s]+?)\\s${k}`, "i");
    const match = text.match(regex);
    if (match) return match[1].trim();
  }
  return null;
}

function extractAfter(text, word) {
  const regex = new RegExp(`${word}\\s([A-Z][A-Za-z&.\\s]+)`, "i");
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function extractSize(text) {
  const match = text.match(/([\d,]+)\s*(SF|square feet)/i);
  return match ? match[1].replace(/,/g, "") : null;
}

function extractPrice(text) {
  const match = text.match(/\$[\d,.]+ ?(million|billion)?/i);
  return match ? match[0] : null;
}

// ─────────────────────────────────────────
// ADVANCED DEAL PARSER
// ─────────────────────────────────────────
function extractDealsFromParagraph(text) {
  const lower = text.toLowerCase();
  const deals = [];

  // LEASE
  if (
    lower.includes("lease") ||
    lower.includes("leased") ||
    lower.includes("tenant")
  ) {
    deals.push({
      type: "Lease",
      tenant: extractCompany(text, ["leased", "signed"]),
      landlord: extractAfter(text, "from"),
      size: extractSize(text),
      price: extractPrice(text),
      details: text
    });
  }

  // SALE
  if (
    lower.includes("sold") ||
    lower.includes("acquired") ||
    lower.includes("bought")
  ) {
    deals.push({
      type: "Sale",
      buyer: extractCompany(text, ["acquired", "bought"]),
      seller: extractAfter(text, "from"),
      size: extractSize(text),
      price: extractPrice(text),
      details: text
    });
  }

  return deals;
}

// ─────────────────────────────────────────
// SCRAPER
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

  // Extract deal sheet links
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

      const structuredDeals = [];

      paragraphs.forEach(p => {
        const extracted = extractDealsFromParagraph(p);
        if (extracted.length > 0) {
          structuredDeals.push(...extracted);
        }
      });

      results.push({
        title: deal.title,
        url: deal.url,
        deals: structuredDeals
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
// API (PAGINATION)
// ─────────────────────────────────────────
app.get("/deals", checkToken, async (req, res) => {
  try {
    let offset = parseInt(req.query.offset || "0");
    let limit = parseInt(req.query.limit || "10");

    if (CACHE.data.length === 0) {
      await scrapeDeals();
    }

    const total = CACHE.data.length;

    if (offset >= total) {
      return res.json({
        total,
        offset,
        limit,
        hasMore: false,
        data: []
      });
    }

    const paginated = CACHE.data.slice(offset, offset + limit);

    res.json({
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      lastUpdated: CACHE.lastUpdated,
      data: paginated
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// REFRESH
// ─────────────────────────────────────────
app.get("/refresh", checkToken, async (req, res) => {
  await scrapeDeals();
  res.json({ message: "Data refreshed" });
});

// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});