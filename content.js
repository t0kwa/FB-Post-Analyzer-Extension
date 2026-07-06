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

// Prefer visible text where possible (innerText) but fall back to textContent.
function getVisibleText(node) {
  try {
    return (node.innerText || node.textContent || "").trim();
  } catch (e) {
    return (node.textContent || "").trim();
  }
}

function normalizeText(str) {
  return (str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

// Extracts the reaction count. Facebook usually exposes this via an
// aria-label like "Like: 1.2K people" or a span whose text is just a number.
function extractReactions(article) {
  // Look for reaction buttons with aria-label
  const reactionElements = article.querySelectorAll('[aria-label*="reaction"], [aria-label*="Like"], [aria-label*="like"]');
  for (const el of reactionElements) {
    const label = el.getAttribute('aria-label') || '';
    const match = label.match(/([\d.,]+[KkMmBb]?)/);
    if (match) return parseAbbreviatedNumber(match[1]);
  }
  
  // Look for reaction counts in text
  const text = getVisibleText(article);
  const match = text.match(/([\d.,]+[KkMmBb]?)\s*(?:reactions|likes?)\b/i);
  if (match) return parseAbbreviatedNumber(match[1]);
  
  return 0;
}

// Extracts comment / share counts from text nodes like "23 comments", "5 shares".
function extractCountByLabel(article, labelRegex) {
  const candidates = Array.from(article.querySelectorAll('[aria-label], a, button, span, div'));
  for (const el of candidates) {
    const label = el.getAttribute('aria-label') || '';
    const text = getVisibleText(el);
    const combined = `${label} ${text}`.trim();
    if (!combined || !labelRegex.test(combined)) continue;
    const match = combined.match(/([\d.,]+[KkMmBb]?)/);
    if (match) return parseAbbreviatedNumber(match[1]);
  }
  const text = getVisibleText(article);
  let match = text.match(new RegExp(`([\\d.,]+[KkMmBb]?)\\s*(?:${labelRegex.source})`, 'i'));
  if (match) return parseAbbreviatedNumber(match[1]);
  match = text.match(new RegExp(`(?:${labelRegex.source})\\s*([\\d.,]+[KkMmBb]?)`, 'i'));
  if (match) return parseAbbreviatedNumber(match[1]);
  return 0;
}

function getPostDescriptionText(article) {
  // Try multiple approaches to find the post content
  
  // Approach 1: Look for Facebook's post message containers
  const selectors = [
    'div[data-ad-preview="message"]',
    'div[data-testid="post_message"]',
    'div[dir="auto"]:not([role])',
    'span[dir="auto"]:not([role])',
    'div[data-block="true"]',
    'div[style*="text-align"]',
    '.post_content',
    '.story_body_container',
    '.userContentWrapper',
    '.userContent'
  ];
  
  for (const selector of selectors) {
    const elements = article.querySelectorAll(selector);
    for (const el of elements) {
      // Skip if inside comments, reactions, or UI elements
      if (el.closest('[role="button"], [aria-label*="Comment"], [aria-label*="Share"], [data-testid*="ufi"], [data-testid*="feedback"], [data-testid="story-subtitle"], [role="dialog"], [class*="comment"], [class*="feedback"]')) {
        continue;
      }
      
      const text = getVisibleText(el);
      if (text && text.length > 10) {
        const lowerText = text.toLowerCase();
        // Skip metadata text
        if (!lowerText.includes('comment') && 
            !lowerText.includes('share') && 
            !lowerText.includes('reaction') &&
            !lowerText.includes('like') &&
            !lowerText.includes('view more') &&
            !lowerText.includes('see more') &&
            !lowerText.includes('write a comment') &&
            !lowerText.includes('write a reply') &&
            !lowerText.includes('ago') &&
            !lowerText.includes('updated') &&
            !/^[\d,.\s]+$/.test(text)) {
          return text.trim();
        }
      }
    }
  }
  
  // Approach 2: Get all text blocks and filter
  const allElements = article.querySelectorAll('div, span, p');
  const textBlocks = [];
  
  for (const el of allElements) {
    // Skip if in UI elements
    if (el.closest('[role="button"], [aria-label*="Comment"], [aria-label*="Share"], [data-testid*="ufi"], [data-testid*="feedback"], [data-testid="story-subtitle"], [role="dialog"], [class*="comment"], [class*="feedback"]')) {
      continue;
    }
    
    const text = getVisibleText(el);
    if (!text || text.length < 20) continue;
    
    const lowerText = text.toLowerCase();
    // Skip common UI text
    if (lowerText.includes('comment') || 
        lowerText.includes('share') || 
        lowerText.includes('reaction') ||
        lowerText.includes('like') ||
        lowerText.includes('view more') ||
        lowerText.includes('see more') ||
        lowerText.includes('write a comment') ||
        lowerText.includes('write a reply') ||
        lowerText.includes('ago') ||
        lowerText.includes('updated') ||
        /^[\d,.\s]+$/.test(text)) {
      continue;
    }
    
    textBlocks.push({
      text: text.trim(),
      length: text.length,
      element: el
    });
  }
  
  // Sort by length and get the longest (likely the post content)
  if (textBlocks.length > 0) {
    textBlocks.sort((a, b) => b.length - a.length);
    return textBlocks[0].text;
  }
  
  // Approach 3: Last resort - get all visible text and try to extract
  const allText = getVisibleText(article);
  const lines = allText.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 20);
  
  // Filter out UI text
  const meaningfulLines = lines.filter(line => {
    const lower = line.toLowerCase();
    return !lower.includes('comment') && 
           !lower.includes('share') && 
           !lower.includes('reaction') &&
           !lower.includes('like') &&
           !lower.includes('view more') &&
           !lower.includes('see more') &&
           !lower.includes('write a comment') &&
           !lower.includes('write a reply') &&
           !lower.includes('ago') &&
           !lower.includes('updated') &&
           !/^[\d,.\s]+$/.test(line);
  });
  
  return meaningfulLines.length > 0 ? meaningfulLines[0] : '';
}

function getPostSnippet(article) {
  const description = getPostDescriptionText(article);
  return description ? (description.length > 160 ? description.slice(0, 160) + "…" : description) : "No description available";
}

function parseSearchTerms(keyword) {
  const normalized = normalizeText(keyword);
  if (!normalized) return [];
  const commaSeparated = normalized
    .split(/[;,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const terms = commaSeparated.length > 1 ? commaSeparated : normalized.split(/\s+/).filter(Boolean);
  return terms;
}

function getPostUrl(article) {
  // Try to find the post link
  const linkSelectors = [
    'a[href*="/posts/"]',
    'a[href*="/photos/"]',
    'a[href*="/videos/"]',
    'a[href*="/story.php"]',
    'a[href*="/groups/"]',
    'a[href*="story_fbid"]',
    'a[href*="permalink"]'
  ];
  
  for (const selector of linkSelectors) {
    const link = article.querySelector(selector);
    if (link && link.href) {
      // Make sure it's a full URL
      if (link.href.startsWith('http')) {
        return link.href;
      }
    }
  }
  
  // Look for any link with post-related text
  const anchors = article.querySelectorAll('a[href]');
  for (const anchor of anchors) {
    const href = anchor.href;
    if (/facebook\.com\/.+\/(posts|photos|videos?|story\.php|story_fbid|permalink)/i.test(href)) {
      return href;
    }
  }
  
  return window.location.href;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Stable-ish key for dedupe across scroll iterations
function postKey(article) {
  if (!article || typeof article !== "object") {
    return "text:";
  }
  
  // Try to get a unique identifier
  const pagelet = article.dataset?.pagelet || article.getAttribute?.("data-pagelet");
  if (pagelet) return `pagelet:${pagelet}`;
  
  const ft = article.getAttribute?.("data-ft");
  if (ft) return `ft:${ft}`;
  
  // Use a combination of text and URL
  const url = getPostUrl(article);
  if (url && url !== window.location.href) {
    return `url:${url}`;
  }
  
  // Fallback: use snippet
  const snippet = getVisibleText(article)
    .slice(0, 160)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (snippet) return `text:${snippet}`;
  
  return `outer:${article.outerHTML?.slice(0, 800) || ""}`;
}

function isTopLevelPost(article) {
  if (!article || !article.parentElement) return true;
  const parentPost = article.parentElement.closest(POST_SELECTOR);
  return !parentPost;
}

function extractPostData(article) {
  const rawSnippet = getPostSnippet(article);
  const reactions = extractReactions(article);
  const comments = extractCountByLabel(article, /comment/i);
  const shares = extractCountByLabel(article, /share/i);
  const url = getPostUrl(article);
  const data = {
    snippet: escapeHtml(rawSnippet),
    reactions,
    comments,
    shares,
    url
  };
  data.key = postKey(article);
  return data;
}

// --- One-shot scan (scans only what's currently loaded) ------------------

// Expanded post selectors for better Facebook compatibility
const POST_SELECTOR = [
  'article',
  '[role="article"]',
  'div[data-pagelet^="FeedUnit_"]',
  '[data-pagelet^="ProfileWallStory"]',
  'div[data-testid="post-container"]',
  'div[data-testid="fbfeed_story"]',
  'div[data-testid="story_container"]',
  '.storyContainer',
  '.postContainer',
  'div[class*="story"]',
  'div[class*="post"]'
].join(',');

const FALLBACK_POST_SELECTOR = 'article, [role="article"], [data-pagelet], div[data-testid], div[class*="story"], div[class*="post"]';

function scanPosts(keyword) {
  console.debug("FB-KW: Starting scan for keyword:", keyword);
  
  // Start with the normal post containers, then use a broader fallback if needed.
  let articles = Array.from(document.querySelectorAll(POST_SELECTOR));
  if (!articles.length) {
    articles = Array.from(document.querySelectorAll(FALLBACK_POST_SELECTOR));
  }
  
  // Remove duplicates
  articles = Array.from(new Set(articles));
  
  console.debug(`FB-KW: Found ${articles.length} candidate articles`);
  
  // Log first few articles for debugging
  for (let i = 0; i < Math.min(3, articles.length); i++) {
    const text = getVisibleText(articles[i]).slice(0, 100);
    console.debug(`FB-KW: Article ${i} preview:`, text);
  }
  
  const terms = parseSearchTerms(keyword);
  if (!terms.length) {
    console.debug("FB-KW: No search terms parsed");
    return { posts: [], scanned: articles.length };
  }
  
  console.debug("FB-KW: Search terms:", terms);
  
  const matched = [];
  const seenKeys = new Set();
  
  for (const article of articles) {
    if (!isTopLevelPost(article)) continue;
    
    const description = getPostDescriptionText(article);
    if (!description) continue;
    
    const lowerDescription = description.toLowerCase();
    const matchedTerm = terms.find((term) => lowerDescription.includes(term));
    
    if (matchedTerm) {
      console.debug(`FB-KW: Matched post with term "${matchedTerm}":`, description.slice(0, 50));
      const data = extractPostData(article);
      if (!seenKeys.has(data.key)) {
        seenKeys.add(data.key);
        matched.push(data);
      }
    }
  }
  
  console.debug(`FB-KW: Found ${matched.length} matching posts out of ${articles.length} scanned`);
  return { posts: matched, scanned: articles.length };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "PING") {
    sendResponse({ alive: true });
    return true;
  }
  if (request.action === "SEARCH_KEYWORD") {
    try {
      console.debug("FB-KW: SEARCH_KEYWORD received", request.keyword);
      const result = scanPosts(request.keyword);
      console.debug(`FB-KW: SEARCH_KEYWORD result posts=${result.posts.length} scanned=${result.scanned}`);
      sendResponse(result);
    } catch (err) {
      console.error("FB-KW: Error in SEARCH_KEYWORD", err);
      sendResponse({ posts: [], scanned: 0, error: String(err) });
    }
  }
  return true;
});

// --- Auto-scroll + collect (live, via long-lived port) -------------------

const AUTO_SCAN = {
  MAX_ITERATIONS: 80,
  SCROLL_STEP: 900,
  MIN_DELAY_MS: 1200,
  MAX_DELAY_MS: 2000,
  NO_GROWTH_LIMIT: 4,
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
    port = null;
  });
  
  async function runAutoScan() {
    const seenKeys = new Set();
    const foundPosts = [];
    let lastHeight = 0;
    let noGrowthCount = 0;
    
    try {
      port.postMessage({ type: "STATUS", message: "Starting scan…" });
    } catch (e) {
      console.debug("FB-KW: port disconnected", e);
      return;
    }
    
    for (let i = 0; i < AUTO_SCAN.MAX_ITERATIONS && !stopped; i++) {
      console.debug(`FB-KW: Auto-scan iteration ${i + 1}`);
      
      const result = scanPosts(keyword);
      let newPostsFound = 0;
      
      for (const data of result.posts) {
        if (seenKeys.has(data.key)) continue;
        seenKeys.add(data.key);
        foundPosts.push(data);
        newPostsFound++;
      }
      
      console.debug(`FB-KW: Found ${newPostsFound} new posts, total ${foundPosts.length}`);
      
      try {
        port.postMessage({
          type: "PROGRESS",
          posts: foundPosts,
          scanned: result.scanned,
          iteration: i + 1,
          newPosts: newPostsFound
        });
      } catch (e) {
        console.debug("FB-KW: port disconnected during progress", e);
        stopped = true;
        break;
      }
      
      if (stopped) break;
      
      // Scroll down
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      const waitMs = AUTO_SCAN.MIN_DELAY_MS + Math.random() * (AUTO_SCAN.MAX_DELAY_MS - AUTO_SCAN.MIN_DELAY_MS);
      await delay(waitMs);
      
      // Check if we've reached the bottom
      const newHeight = document.body.scrollHeight;
      const reachedBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 50;
      
      if (newHeight <= lastHeight && reachedBottom) {
        noGrowthCount++;
      } else {
        noGrowthCount = 0;
      }
      lastHeight = newHeight;
      
      if (noGrowthCount >= AUTO_SCAN.NO_GROWTH_LIMIT) {
        try {
          port.postMessage({
            type: "DONE",
            reason: "Reached the end of the loaded page.",
            posts: foundPosts,
            scanned: document.querySelectorAll(POST_SELECTOR).length,
          });
        } catch (e) {
          console.debug("FB-KW: port disconnected at done", e);
        }
        return;
      }
    }
    
    try {
      port.postMessage({
        type: "DONE",
        reason: stopped ? "Stopped." : "Reached the scan limit for this run.",
        posts: foundPosts,
        scanned: document.querySelectorAll(POST_SELECTOR).length,
      });
    } catch (e) {
      console.debug("FB-KW: port disconnected at final done", e);
    }
  }
});