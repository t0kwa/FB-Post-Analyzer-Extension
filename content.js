// content.js - Accumulates posts during auto-scroll

console.log('[FB-KW] Content script loaded');

// Store all found posts
let allFoundPosts = [];
let seenPosts = new Set();
let currentKeyword = '';
let isScanning = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[FB-KW] Message:', request.action);
  
  if (request.action === 'PING') {
    sendResponse({ alive: true, postsFound: allFoundPosts.length });
    return true;
  }
  
  if (request.action === 'SEARCH_KEYWORD') {
    try {
      // Reset when doing a new search
      if (!request.isAutoScan) {
        allFoundPosts = [];
        seenPosts = new Set();
        currentKeyword = request.keyword;
      }
      
      const results = searchPosts(request.keyword, request.isAutoScan);
      sendResponse(results);
    } catch (e) {
      console.error('[FB-KW] Error:', e);
      sendResponse({ posts: [], scanned: 0, error: e.message });
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
    seenPosts = new Set();
    sendResponse({ done: true });
    return true;
  }
});

// Search posts - accumulates results
function searchPosts(keyword, isAutoScan = false) {
  console.log('[FB-KW] Searching for:', keyword, 'Auto:', isAutoScan);
  console.log('[FB-KW] Already found:', allFoundPosts.length, 'posts');
  
  const keywordLower = keyword.toLowerCase();
  const newResults = [];
  
  // Get all text nodes
  const textNodes = getAllTexts();
  console.log('[FB-KW] Found', textNodes.length, 'text nodes');
  
  // Get JSON data
  const jsonData = getAllJSONData();
  console.log('[FB-KW] Found', jsonData.length, 'JSON objects');
  
  // Process text nodes
  for (const text of textNodes) {
    if (!text || text.length < 20) continue;
    if (!text.toLowerCase().includes(keywordLower)) continue;
    
    const lower = text.toLowerCase();
    if (lower.includes('comment') || 
        lower.includes('share') || 
        lower.includes('reaction') ||
        lower.includes('like') ||
        lower.includes('view more') ||
        lower.includes('see more') ||
        lower.includes('write a') ||
        lower.includes('ago') ||
        lower.includes('loading') ||
        /^[\d,.\s]+$/.test(text)) {
      continue;
    }
    
    // Check if already seen
    const key = text.slice(0, 150);
    if (seenPosts.has(key)) continue;
    seenPosts.add(key);
    
    const element = findElementWithText(text);
    let url = window.location.href;
    
    if (element) {
      const postUrl = findPostUrl(element);
      if (postUrl) url = postUrl;
    }
    
    const fullText = element ? (element.innerText || element.textContent || '') : text;
    const reactions = extractMetric(fullText, /([\d.,]+[KkMmBb]?)\s*(?:reactions|likes?)/i);
    const comments = extractMetric(fullText, /([\d.,]+[KkMmBb]?)\s*comments?/i);
    const shares = extractMetric(fullText, /([\d.,]+[KkMmBb]?)\s*shares?/i);
    
    const snippet = text.length > 160 ? text.slice(0, 160) + '...' : text;
    
    const post = {
      snippet: snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      reactions: reactions,
      comments: comments,
      shares: shares,
      url: url
    };
    
    newResults.push(post);
    allFoundPosts.push(post);
  }
  
  // Process JSON data
  for (const data of jsonData) {
    const text = extractTextFromJSON(data);
    if (!text || text.length < 20) continue;
    if (!text.toLowerCase().includes(keywordLower)) continue;
    
    const key = text.slice(0, 150);
    if (seenPosts.has(key)) continue;
    seenPosts.add(key);
    
    let url = window.location.href;
    const urlMatch = text.match(/https?:\/\/[^\s"]+facebook\.com[^\s"]+/);
    if (urlMatch) {
      url = urlMatch[0];
    }
    
    const reactions = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*(?:reactions|likes?)/i);
    const comments = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*comments?/i);
    const shares = extractMetric(text, /([\d.,]+[KkMmBb]?)\s*shares?/i);
    
    const snippet = text.length > 160 ? text.slice(0, 160) + '...' : text;
    
    const post = {
      snippet: snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
      reactions: reactions,
      comments: comments,
      shares: shares,
      url: url
    };
    
    newResults.push(post);
    allFoundPosts.push(post);
  }
  
  console.log('[FB-KW] New posts found:', newResults.length);
  console.log('[FB-KW] Total accumulated:', allFoundPosts.length);
  
  // Return ALL accumulated posts
  return { 
    posts: allFoundPosts,  // Return ALL posts, not just new ones
    scanned: textNodes.length + jsonData.length,
    newPosts: newResults.length,
    total: allFoundPosts.length
  };
}

// Get all text nodes
function getAllTexts() {
  const texts = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        if (node.parentElement.tagName === 'SCRIPT' || 
            node.parentElement.tagName === 'STYLE' ||
            node.parentElement.tagName === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text && text.length > 10) {
      texts.push(text);
    }
  }
  
  return texts;
}

// Get all JSON data
function getAllJSONData() {
  const jsonData = [];
  
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const content = script.textContent || '';
    if (!content) continue;
    
    try {
      const jsonMatches = content.match(/\{[^{}]*"text"[^{}]*\}/g);
      if (jsonMatches) {
        for (const match of jsonMatches) {
          try {
            const parsed = JSON.parse(match);
            jsonData.push(parsed);
          } catch (e) {}
        }
      }
      
      const arrayMatches = content.match(/\[\s*\{[^\[\]]*\}\s*\]/g);
      if (arrayMatches) {
        for (const match of arrayMatches) {
          try {
            const parsed = JSON.parse(match);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                jsonData.push(item);
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  
  const elements = document.querySelectorAll('[data-ft], [data-pagelet]');
  for (const el of elements) {
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.value && attr.value.length > 50) {
        try {
          const parsed = JSON.parse(attr.value);
          jsonData.push(parsed);
        } catch (e) {}
      }
    }
  }
  
  return jsonData;
}

// Extract text from JSON
function extractTextFromJSON(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const text = extractTextFromJSON(item);
      if (text && text.length > 20) return text;
    }
    return '';
  }
  
  if (typeof obj === 'object') {
    const textFields = ['text', 'message', 'content', 'body', 'story', 'post', 'description', 'title', 'name'];
    for (const field of textFields) {
      if (obj[field] && typeof obj[field] === 'string' && obj[field].length > 20) {
        return obj[field];
      }
    }
    
    for (const key in obj) {
      const text = extractTextFromJSON(obj[key]);
      if (text && text.length > 20) return text;
    }
  }
  
  return '';
}

// Find element with text
function findElementWithText(text) {
  const searchText = text.slice(0, 50).replace(/'/g, "\\'");
  const xpath = `//*[contains(text(), '${searchText}')]`;
  try {
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = result.singleNodeValue;
    if (node) return node;
  } catch (e) {}
  
  const elements = document.querySelectorAll('div, span, p, article');
  for (const el of elements) {
    const elText = el.innerText || el.textContent || '';
    if (elText.includes(text) && elText.length < 1000) {
      return el;
    }
  }
  
  return null;
}

// Find post URL
function findPostUrl(element) {
  if (!element) return null;
  
  let current = element;
  while (current && current !== document.body) {
    const links = current.querySelectorAll('a[href]');
    for (const link of links) {
      const href = link.href;
      if (href && href.includes('facebook.com')) {
        if (href.includes('/posts/') || 
            href.includes('/photos/') || 
            href.includes('/videos/') ||
            href.includes('story_fbid') ||
            href.includes('story.php') ||
            href.includes('permalink')) {
          return href;
        }
      }
    }
    current = current.parentElement;
  }
  
  return null;
}

// Extract metric
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