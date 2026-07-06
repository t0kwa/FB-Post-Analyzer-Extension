// content.js
// Runs in the context of facebook.com pages. Reads whatever is already
// rendered/loaded in the DOM — it does not auto-login and never touches
// authentication. The "auto-scan" mode below scrolls the page (simulating
// what a user would do manually) and re-reads the DOM after each step.

// --- Helpers -----------------------------------------------------------

// Converts Facebook's abbreviated numbers ("1.2K", "3.4M", "856") to a number.
function parseAbbreviatedNumber(str) {
  if (!str) return 0;
  const cleaned = str.replace(/,/g, "").trim();
  const match = cleaned.match(/^([\d.]+)\s*([KkMmBb]?)/);
  if (!match) return 0;
  let num = parseFloat(match[1]);
  const suffix = match[2].toUpperCase();
  if (suffix === "K") num *= 1_000;
  if (suffix === "M") num *= 1_000_000;
  if (suffix === "B") num *= 1_000_000_000;
  return Math.round(num);
}

// Extracts the reaction count. Facebook usually exposes this via an
// aria-label like "Like: 1.2K people" or a span whose text is just a number.
function extractReactions(article) {
  const ariaCandidates = article.querySelectorAll("[aria-label]");
  for (const el of ariaCandidates) {
    const label = el.getAttribute("aria-label") || "";
    const m = label.match(/^([\d.,]+[KkMmBb]?)\s*(people|reactions)?/i);
    if (m && /reaction|like/i.test(label)) {
      return parseAbbreviatedNumber(m[1]);
    }
  }
  // Fallback: look for a span near "reactions" text
  const spans = article.querySelectorAll("span");
  for (const s of spans) {
    if (/^[\d.,]+[KkMmBb]?$/.test(s.textContent.trim())) {
      const parent = s.closest('[role="button"]');
      if (parent && /reaction|like/i.test(parent.getAttribute("aria-label") || "")) {
        return parseAbbreviatedNumber(s.textContent.trim());
      }
    }
  }
  return 0;
}

// Extracts comment / share counts from text nodes like "23 comments", "5 shares".
function extractCountByLabel(article, labelRegex) {
  const spans = article.querySelectorAll("span, div");
  for (const el of spans) {
    const text = el.textContent.trim();
    if (labelRegex.test(text) && text.length < 40) {
      const m = text.match(/([\d.,]+[KkMmBb]?)/);
      if (m) return parseAbbreviatedNumber(m[1]);
    }
  }
  return 0;
}

function getPostSnippet(article) {
  const textBlocks = article.querySelectorAll('[data-ad-preview="message"], [dir="auto"]');
  let text = "";
  for (const block of textBlocks) {
    const t = block.textContent.trim();
    if (t.length > text.length) text = t;
  }
  if (!text) text = article.textContent.trim();
  text = text.replace(/\s+/g, " ");
  return text.length > 160 ? text.slice(0, 160) + "…" : text;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Stable-ish key for dedupe across scroll iterations, since Facebook doesn't
// expose a clean post ID in the DOM.
function postKey(snippet, reactions, comments, shares) {
  return `${snippet.slice(0, 80)}|${reactions}|${comments}|${shares}`;
}

function extractPostData(article) {
  const snippet = getPostSnippet(article);
  const reactions = extractReactions(article);
  const comments = extractCountByLabel(article, /comment/i);
  const shares = extractCountByLabel(article, /share/i);
  return { snippet: escapeHtml(snippet), reactions, comments, shares };
}

// --- One-shot scan (scans only what's currently loaded) ------------------

function scanPosts(keyword) {
  const articles = Array.from(document.querySelectorAll('div[role="article"]'));
  const lowerKeyword = keyword.toLowerCase();
  const matched = [];

  for (const article of articles) {
    const rawText = article.textContent || "";
    if (!rawText.toLowerCase().includes(lowerKeyword)) continue;
    matched.push(extractPostData(article));
  }

  return { posts: matched, scanned: articles.length };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "SEARCH_KEYWORD") {
    try {
      const result = scanPosts(request.keyword);
      sendResponse(result);
    } catch (err) {
      sendResponse({ posts: [], scanned: 0, error: String(err) });
    }
  }
  return true; // keep the message channel open for async sendResponse
});

// --- Auto-scroll + collect (live, via long-lived port) -------------------
// Scrolls the page gradually, re-scans after each step, and streams newly
// found matching posts back to the popup while it's open. Stops when the
// user clicks Stop, the popup closes, the page stops growing (reached the
// bottom / Facebook stopped loading more), or a safety iteration cap is hit.

const AUTO_SCAN = {
  MAX_ITERATIONS: 80, // safety cap so it can't run forever unattended
  SCROLL_STEP: 900, // px per step
  MIN_DELAY_MS: 1200, // randomized delay range between scrolls,
  MAX_DELAY_MS: 2000, // to avoid hammering the page
  NO_GROWTH_LIMIT: 4, // consecutive no-new-content scrolls before stopping
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "AUTO_SCAN") return;

  let stopped = false;
  let keyword = "";
  let started = false;

  port.onMessage.addListener((msg) => {
    if (msg.action === "STOP") {
      stopped = true;
    } else if (msg.action === "START" && !started) {
      started = true;
      keyword = (msg.keyword || "").toLowerCase();
      runAutoScan();
    }
  });
  port.onDisconnect.addListener(() => {
    stopped = true;
  });

  async function runAutoScan() {
    const seenKeys = new Set();
    const foundPosts = [];
    let lastHeight = 0;
    let noGrowthCount = 0;

    port.postMessage({ type: "STATUS", message: "Starting scan…" });

    for (let i = 0; i < AUTO_SCAN.MAX_ITERATIONS && !stopped; i++) {
      const articles = Array.from(document.querySelectorAll('div[role="article"]'));

      for (const article of articles) {
        const rawText = (article.textContent || "").toLowerCase();
        if (!rawText.includes(keyword)) continue;

        const data = extractPostData(article);
        const key = postKey(data.snippet, data.reactions, data.comments, data.shares);
        if (seenKeys.has(key)) continue;

        seenKeys.add(key);
        foundPosts.push(data);
      }

      port.postMessage({
        type: "PROGRESS",
        posts: foundPosts,
        scanned: articles.length,
        iteration: i + 1,
      });

      if (stopped) break;

      window.scrollBy({ top: AUTO_SCAN.SCROLL_STEP, behavior: "auto" });
      const waitMs =
        AUTO_SCAN.MIN_DELAY_MS +
        Math.random() * (AUTO_SCAN.MAX_DELAY_MS - AUTO_SCAN.MIN_DELAY_MS);
      await delay(waitMs);

      const newHeight = document.body.scrollHeight;
      const reachedBottom =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;

      if (newHeight <= lastHeight && reachedBottom) {
        noGrowthCount++;
      } else {
        noGrowthCount = 0;
      }
      lastHeight = newHeight;

      if (noGrowthCount >= AUTO_SCAN.NO_GROWTH_LIMIT) {
        port.postMessage({
          type: "DONE",
          reason: "Reached the end of the loaded page.",
          posts: foundPosts,
          scanned: document.querySelectorAll('div[role="article"]').length,
        });
        return;
      }
    }

    port.postMessage({
      type: "DONE",
      reason: stopped ? "Stopped." : "Reached the scan limit for this run.",
      posts: foundPosts,
      scanned: document.querySelectorAll('div[role="article"]').length,
    });
  }
});
