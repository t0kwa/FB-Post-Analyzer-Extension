// content.js - v4: container-based scanning (accurate text + URL pairing)

console.log('[FB-KW] Content script loaded');

let allFoundPosts = [];
let seenKeys = new Set();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[FB-KW] Message:', request.action);

  if (request.action === 'PING') {
    sendResponse({ alive: true, postsFound: allFoundPosts.length });
    return true;
  }

  if (request.action === 'SEARCH_KEYWORD') {
    try {
      if (!request.isAutoScan) {
        allFoundPosts = [];
        seenKeys = new Set();
      }
      const results = searchPosts(request.keyword);
      sendResponse(results);
    } catch (e) {
      console.error('[FB-KW] Error:', e);
      sendResponse({ posts: allFoundPosts, scanned: 0, error: e.message });
    }
    return true;
  }

  if (request.action === 'SCROLL_DOWN') {
    window.scrollBy(0, 800);
    setTimeout(() => sendResponse({ done: true }), 500);
    return true;
  }

  if (request.action === 'GET_ACCUMULATED') {
    sendResponse({ posts: allFoundPosts, count: allFoundPosts.length });
    return true;
  }

  if (request.action === 'CLEAR_ACCUMULATED') {
    allFoundPosts = [];
    seenKeys = new Set();
    sendResponse({ done: true });
    return true;
  }
});

function searchPosts(keyword) {
  const keywordLower = keyword.toLowerCase();
  const containers = getPostContainers();
  let newCount = 0;

  for (const container of containers) {
    const text = (container.innerText || '').trim();
    if (!text || text.length < 20) continue;
    if (!text.toLowerCase().includes(keywordLower)) continue;

    const url = getPermalink(container);
    const key = url || normalizeForKey(text);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const reactions = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*(?:reactions|likes?)/i);
    const comments = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*comments?/i);
    const shares = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*shares?/i);

    const snippet = text.length > 200 ? text.slice(0, 200) + '...' : text;

    const post = {
      snippet: snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      reactions,
      comments,
      shares,
      url: url || window.location.href
    };

    allFoundPosts.push(post);
    newCount++;
  }

  return {
    posts: allFoundPosts,
    scanned: containers.length,
    newPosts: newCount,
    total: allFoundPosts.length
  };
}

// Get top-level post containers only (skip nested/quoted posts inside them)
function getPostContainers() {
  const all = Array.from(document.querySelectorAll('[role="article"]'));
  return all.filter(el => {
    const text = el.innerText || '';
    if (text.trim().length < 20) return false;
    // drop if nested inside another article we already matched
    return !all.some(other => other !== el && other.contains(el));
  });
}

// Find the permalink from anchors *inside the same container* as the matched text
function getPermalink(container) {
  const anchors = Array.from(container.querySelectorAll('a[href]'));
  const patterns = [
    /\/permalink\.php\?story_fbid=/i,
    /\/story\.php\?story_fbid=/i,
    /\/groups\/[^\/]+\/permalink\/[^\/\?\s]+/i,
    /\/[^\/]+\/posts\/[^\/\?\s]+/i,
    /\/[^\/]+\/videos\/[^\/\?\s]+/i,
    /\/[^\/]+\/photos\/[^\/\?\s]+/i,
    /\/reel\/[^\/\?\s]+/i,
    /\/watch\/\?v=/i
  ];

  let fallback = null;

  for (const a of anchors) {
    const href = a.href;
    if (!href || !href.includes('facebook.com')) continue;

    for (const p of patterns) {
      if (!p.test(href)) continue;
      const clean = stripTracking(href);
      // Timestamp links (the real permalink) usually have an aria-label
      // or wrap an <abbr>/<time>-like element with the post date
      if (a.getAttribute('aria-label') || a.querySelector('abbr')) {
        return clean;
      }
      if (!fallback) fallback = clean;
    }
  }

  return fallback;
}

function stripTracking(href) {
  return href.split('&__tn__')[0].split('&__cft__')[0].split('?__tn__')[0];
}

function normalizeForKey(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function extractMetric(text, regex) {
  const match = text.match(regex);
  if (match) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (match[1].toLowerCase().includes('k')) return Math.round(num * 1000);
    if (match[1].toLowerCase().includes('m')) return Math.round(num * 1000000);
    return Math.round(num);
  }
  return 0;
}

console.log('[FB-KW] Ready');