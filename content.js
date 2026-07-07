// content.js - Full Facebook Post Scraper

console.log('[FB-SCRAPER] Content script loaded');

let allScrapedPosts = [];
let seenKeys = new Set();
let isScraping = false;
let currentPageName = '';
const MAX_SCAN_LIMIT = 1000; // Maximum posts to scan (not collect)

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[FB-SCRAPER] Message:', request.action);

  if (request.action === 'PING') {
    sendResponse({ alive: true, postsFound: allScrapedPosts.length });
    return true;
  }

  if (request.action === 'SCRAPE_POSTS') {
    (async () => {
      try {
        if (!request.isAutoScrape) {
          allScrapedPosts = [];
          seenKeys = new Set();
        }
        const results = await scrapePosts(request.keyword);
        sendResponse(results);
      } catch (e) {
        console.error('[FB-SCRAPER] Error:', e);
        sendResponse({ posts: allScrapedPosts, scanned: 0, error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'SCROLL_DOWN') {
    window.scrollBy(0, 800);
    setTimeout(() => sendResponse({ done: true }), 500);
    return true;
  }

  if (request.action === 'GET_PAGE_INFO') {
    const info = getPageInfo();
    sendResponse(info);
    return true;
  }

  if (request.action === 'CLEAR_ACCUMULATED') {
    allScrapedPosts = [];
    seenKeys = new Set();
    sendResponse({ done: true });
    return true;
  }

  if (request.action === 'GET_SCRAPED_DATA') {
    sendResponse({ 
      posts: allScrapedPosts, 
      count: allScrapedPosts.length,
      pageName: currentPageName,
      pageUrl: window.location.href
    });
    return true;
  }

  if (request.action === 'NAVIGATE_TO_POST') {
    try {
      const postData = request.postData;
      const result = navigateToPost(postData);
      sendResponse(result);
    } catch (e) {
      console.error('[FB-SCRAPER] Navigation error:', e);
      sendResponse({ success: false, error: e.message });
    }
    return true;
  }
});

// ============================================
// MAIN SCRAPING FUNCTION
// ============================================
async function scrapePosts(keyword = '') {
  console.log('[FB-SCRAPER] Scraping posts...');
  
  // Check if we've reached max scan limit
  if (allScrapedPosts.length >= MAX_SCAN_LIMIT) {
    console.log('[FB-SCRAPER] Reached maximum scan limit:', MAX_SCAN_LIMIT);
    return {
      posts: allScrapedPosts,
      scanned: 0,
      newPosts: 0,
      total: allScrapedPosts.length,
      pageName: currentPageName,
      maxReached: true
    };
  }
  
  // Get page info first
  const pageInfo = getPageInfo();
  currentPageName = pageInfo.name;
  
  let containers = getPostContainers();
  console.log('[FB-SCRAPER] Found', containers.length, 'containers');

  // Expand "See more" buttons
  let expandedAny = false;
  for (const c of containers) {
    if (expandSeeMore(c)) expandedAny = true;
  }
  if (expandedAny) {
    await new Promise(r => setTimeout(r, 500));
    containers = getPostContainers();
  }

  let newCount = 0;
  let scannedCount = 0;
  const keywordLower = keyword ? cleanText(keyword).toLowerCase() : '';

  for (const container of containers) {
    // Stop if we've reached max scan limit
    if (allScrapedPosts.length >= MAX_SCAN_LIMIT) {
      console.log('[FB-SCRAPER] Stopping - reached max scan limit');
      break;
    }
    
    try {
      const postData = extractFullPostData(container, pageInfo);
      if (!postData) continue;
      
      scannedCount++;
      
      // If keyword is specified, check if post contains the keyword
      if (keywordLower) {
        const textLower = postData.text.toLowerCase();
        // Also check full text and author name
        const fullTextLower = (postData.fullText || '').toLowerCase();
        const authorLower = (postData.authorName || '').toLowerCase();
        
        // Check if keyword is in text, full text, or author name
        if (!textLower.includes(keywordLower) && 
            !fullTextLower.includes(keywordLower) && 
            !authorLower.includes(keywordLower)) {
          continue; // Skip this post if keyword not found
        }
      }

      const key = postData.postId || postData.url || normalizeForKey(postData.text);
      if (seenKeys.has(key)) continue;
      
      seenKeys.add(key);
      allScrapedPosts.push(postData);
      newCount++;
      
    } catch (e) {
      console.warn('[FB-SCRAPER] Error extracting post:', e);
    }
  }

  console.log('[FB-SCRAPER] Scanned', scannedCount, 'posts, found', newCount, 'new matching posts. Total:', allScrapedPosts.length);

  return {
    posts: allScrapedPosts,
    scanned: scannedCount,
    newPosts: newCount,
    total: allScrapedPosts.length,
    pageName: currentPageName,
    maxReached: allScrapedPosts.length >= MAX_SCAN_LIMIT
  };
}

// ============================================
// EXTRACT FULL POST DATA - IMPROVED
// ============================================
function extractFullPostData(container, pageInfo) {
  const fullText = cleanText(container.innerText || '');
  if (!fullText || fullText.length < 20) return null;

  // Get post text/description
  let text = getCaptionText(container) || collapseRepeats(fullText);
  
  // Get URL and ID
  let url = getPermalink(container);
  let postId = extractPostId(url || '');

  // Extract engagement metrics
  const reactions = extractEngagementMetric(container, fullText, 'reactions');
  const comments = extractEngagementMetric(container, fullText, 'comments');
  const shares = extractEngagementMetric(container, fullText, 'shares');

  // Get timestamp
  const timestamp = extractTimestamp(container);

  // Get image URLs
  const images = extractImages(container);

  // Get author info
  const author = extractAuthor(container);

  const postData = {
    // Core fields
    postId: postId || '',
    url: url || window.location.href,
    text: text || '',
    timestamp: timestamp || '',
    
    // Engagement metrics
    reactions: reactions,
    comments: comments,
    shares: shares,
    
    // Author info
    authorName: author.name || '',
    authorUrl: author.url || '',
    
    // Page info
    pageName: pageInfo.name || '',
    pageUrl: pageInfo.url || '',
    
    // Media
    images: images || [],
    
    // Metadata
    scrapedAt: new Date().toISOString(),
    fullText: fullText.slice(0, 2000)
  };

  return postData;
}

// ============================================
// IMPROVED ENGAGEMENT METRIC EXTRACTION
// ============================================
function extractEngagementMetric(container, fullText, type) {
  // Try multiple strategies to get engagement numbers
  
  // Strategy 1: Look for specific aria-labels or data attributes
  const selectors = {
    reactions: [
      '[aria-label*="reaction" i]',
      '[aria-label*="like" i]',
      'span[data-ad-rendering-role="like_count"]',
      'span[data-testid="UFILikeCount"]',
      'span:has(> span:contains("reactions"))'
    ],
    comments: [
      '[aria-label*="comment" i]',
      '[data-ad-rendering-role="comment_count"]',
      'span[data-testid="UFICommentLink"]',
      'a[href*="comment" i]'
    ],
    shares: [
      '[aria-label*="share" i]',
      '[data-ad-rendering-role="share_count"]',
      'span[data-testid="UFIShareCount"]'
    ]
  };
  
  // Try selector-based extraction
  for (const selector of selectors[type] || []) {
    try {
      const elements = container.querySelectorAll(selector);
      for (const el of elements) {
        const text = cleanText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
        const num = parseEngagementNumber(text);
        if (num > 0) return num;
      }
    } catch (e) {}
  }
  
  // Strategy 2: Regex on full text
  const patterns = {
    reactions: [
      /([\d,.]+[KkMmBb]?)\s*(?:reactions?|likes?)/i,
      /([\d,.]+[KkMmBb]?)\s*❤️/i,
      /([\d,.]+[KkMmBb]?)\s*👍/i,
      /^([\d,.]+[KkMmBb]?)\s*$/i
    ],
    comments: [
      /([\d,.]+[KkMmBb]?)\s*comments?/i,
      /([\d,.]+[KkMmBb]?)\s*💬/i
    ],
    shares: [
      /([\d,.]+[KkMmBb]?)\s*shares?/i,
      /([\d,.]+[KkMmBb]?)\s*↗️/i
    ]
  };
  
  for (const pattern of patterns[type] || []) {
    const match = fullText.match(pattern);
    if (match) {
      const num = parseEngagementNumber(match[1]);
      if (num > 0) return num;
    }
  }
  
  // Strategy 3: Look for number spans near the engagement type
  const spans = container.querySelectorAll('span, div');
  let foundText = '';
  for (const span of spans) {
    const spanText = cleanText(span.innerText || span.textContent || '');
    if (spanText && spanText.length < 20) {
      const lowerSpan = spanText.toLowerCase();
      if (lowerSpan.includes(type.slice(0, -1)) || 
          (type === 'reactions' && lowerSpan.includes('like')) ||
          (type === 'reactions' && lowerSpan.includes('❤️')) ||
          (type === 'comments' && lowerSpan.includes('💬')) ||
          (type === 'shares' && lowerSpan.includes('↗️'))) {
        foundText = spanText;
        break;
      }
    }
  }
  
  if (foundText) {
    const num = parseEngagementNumber(foundText);
    if (num > 0) return num;
  }
  
  return 0;
}

function parseEngagementNumber(text) {
  if (!text) return 0;
  
  // Remove non-numeric characters except commas, dots, K, M, B
  const clean = text.replace(/[^0-9.,KkMmBb]/g, '');
  if (!clean) return 0;
  
  // Parse with K/M/B suffixes
  const match = clean.match(/^([\d,.]+)\s*([KkMmBb])?/);
  if (!match) return 0;
  
  let num = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(num)) return 0;
  
  const suffix = (match[2] || '').toLowerCase();
  if (suffix === 'k') return Math.round(num * 1000);
  if (suffix === 'm') return Math.round(num * 1000000);
  if (suffix === 'b') return Math.round(num * 1000000000);
  
  return Math.round(num);
}

// ============================================
// IMPROVED POST CONTAINER DETECTION
// ============================================
function getPostContainers() {
  let allPosts = [];
  
  // Strategy 1: role="article" (most reliable)
  const articles = document.querySelectorAll('[role="article"]');
  for (const article of articles) {
    if (!isComment(article) && article.innerText.length > 50) {
      allPosts.push(article);
    }
  }
  
  // Strategy 2: Facebook feed units
  const feedUnits = document.querySelectorAll('[data-pagelet*="FeedUnit"], [data-pagelet*="feed"]');
  for (const unit of feedUnits) {
    if (!isComment(unit) && unit.innerText.length > 50) {
      // Check if this contains multiple articles
      const childArticles = unit.querySelectorAll('[role="article"]');
      if (childArticles.length > 1) {
        // Add each child article
        for (const child of childArticles) {
          if (!isComment(child) && child.innerText.length > 50) {
            allPosts.push(child);
          }
        }
      } else {
        allPosts.push(unit);
      }
    }
  }
  
  // Strategy 3: Look for posts by action buttons
  const actionButtons = document.querySelectorAll(
    '[data-ad-rendering-role="like_button"], ' +
    '[data-ad-rendering-role="comment_button"], ' +
    '[data-ad-rendering-role="share_button"]'
  );
  
  for (const btn of actionButtons) {
    let container = btn.closest('[role="article"]');
    if (!container) {
      // Find the nearest container with lots of text
      let parent = btn.parentElement;
      while (parent && parent !== document.body) {
        if (parent.innerText && parent.innerText.length > 100) {
          container = parent;
          break;
        }
        parent = parent.parentElement;
      }
    }
    if (container && !allPosts.includes(container) && !isComment(container) && container.innerText.length > 50) {
      allPosts.push(container);
    }
  }
  
  // Strategy 4: Look for story containers
  const stories = document.querySelectorAll(
    '[data-testid="post_container"], ' +
    '[data-testid="fbfeed_story"], ' +
    '.story_body_container, ' +
    '.userContentWrapper'
  );
  
  for (const story of stories) {
    if (!allPosts.includes(story) && !isComment(story) && story.innerText.length > 50) {
      allPosts.push(story);
    }
  }
  
  // Remove duplicates and nested containers
  const uniquePosts = [];
  for (const post of allPosts) {
    let isNested = false;
    for (const other of allPosts) {
      if (post !== other && other.contains(post)) {
        isNested = true;
        break;
      }
    }
    if (!isNested && !uniquePosts.includes(post)) {
      uniquePosts.push(post);
    }
  }
  
  console.log('[FB-SCRAPER] Found', uniquePosts.length, 'unique posts');
  return uniquePosts;
}

// ============================================
// EXTRACT AUTHOR INFO - IMPROVED
// ============================================
function extractAuthor(container) {
  // Look for author name links with profile URLs
  const links = container.querySelectorAll('a[href*="facebook.com"]');
  
  for (const link of links) {
    const href = link.href || '';
    // Skip post links and navigation links
    if (href.includes('/posts/') || 
        href.includes('/photos/') || 
        href.includes('/videos/') ||
        href.includes('/permalink/') ||
        href.includes('/story.php') ||
        href.includes('comment') ||
        href.includes('share')) {
      continue;
    }
    
    const text = cleanText(link.innerText || link.textContent || '');
    if (text && text.length > 2 && text.length < 100) {
      // Check if it's likely a name
      if (!text.includes('facebook') && 
          !text.includes('profile') && 
          !text.includes('page') &&
          !text.match(/^[\d,.]/)) {
        return {
          name: text,
          url: href
        };
      }
    }
  }
  
  // Fallback: Look for strong text that might be the author name
  const strong = container.querySelectorAll('strong, b, h3, h4, h5');
  for (const el of strong) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (text && text.length > 2 && text.length < 100 && !text.match(/^[\d,.]/)) {
      // Check if there's a link nearby
      const nearbyLink = el.closest('a');
      if (nearbyLink) {
        return {
          name: text,
          url: nearbyLink.href || ''
        };
      }
      return {
        name: text,
        url: ''
      };
    }
  }
  
  return { name: '', url: '' };
}

// ============================================
// EXTRACT TIMESTAMP - IMPROVED
// ============================================
function extractTimestamp(container) {
  const timeSelectors = [
    'time',
    'abbr',
    '[data-testid="post_timestamp"]',
    '[aria-label*="hour" i]',
    '[aria-label*="minute" i]',
    '[aria-label*="day" i]',
    'span:has(> a:contains("hour"))',
    'span:has(> a:contains("minute"))'
  ];
  
  for (const selector of timeSelectors) {
    try {
      const elements = container.querySelectorAll(selector);
      for (const el of elements) {
        // Check datetime attribute first
        const datetime = el.getAttribute('datetime') || '';
        if (datetime) {
          return datetime;
        }
        
        // Check aria-label
        const label = el.getAttribute('aria-label') || '';
        if (label && (label.includes('hour') || label.includes('minute') || label.includes('day'))) {
          return label;
        }
        
        // Check text content
        const text = cleanText(el.innerText || el.textContent || '');
        if (text && (text.includes('hour') || text.includes('minute') || text.includes('day') || 
            text.includes('ago') || text.includes('at') || text.match(/\d{1,2}:\d{2}/))) {
          return text;
        }
      }
    } catch (e) {}
  }
  
  // Look for relative time text
  const allText = container.innerText || '';
  const timeMatch = allText.match(/(\d+\s*(?:hour|minute|day|week|month|year)s?\s*ago)/i);
  if (timeMatch) {
    return timeMatch[1];
  }
  
  return '';
}

// ============================================
// EXTRACT IMAGES - IMPROVED
// ============================================
function extractImages(container) {
  const images = [];
  const seen = new Set();
  
  // Look for img tags
  const imgElements = container.querySelectorAll('img');
  for (const img of imgElements) {
    const src = img.src || '';
    // Filter out icons, logos, and tiny images
    if (src && 
        !src.includes('logo') && 
        !src.includes('icon') && 
        !src.includes('avatar') &&
        !src.includes('profile_pic') &&
        !src.includes('button') &&
        src.length > 30 &&
        !seen.has(src)) {
      seen.add(src);
      images.push(src);
    }
  }
  
  // Look for background images
  const divs = container.querySelectorAll('div[style*="background-image"]');
  for (const div of divs) {
    const style = div.getAttribute('style') || '';
    const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
    if (match && match[1] && !seen.has(match[1]) && match[1].length > 20) {
      seen.add(match[1]);
      images.push(match[1]);
    }
  }
  
  return images.slice(0, 10); // Limit to 10 images
}

// ============================================
// GET PERMALINK - IMPROVED
// ============================================
function getPermalink(container) {
  const links = container.querySelectorAll('a[href]');
  
  // Priority 1: Links with "post" or "story" in them
  for (const a of links) {
    const href = a.href || '';
    if (href && (href.includes('/posts/') || 
        href.includes('/permalink/') || 
        href.includes('story_fbid=') ||
        href.includes('/story.php'))) {
      return stripTracking(href);
    }
  }
  
  // Priority 2: Links with timestamp in them
  for (const a of links) {
    const href = a.href || '';
    if (href && (a.querySelector('time') || a.querySelector('abbr') || a.querySelector('[datetime]'))) {
      return stripTracking(href);
    }
  }
  
  // Priority 3: Any Facebook link that's not a profile or page
  for (const a of links) {
    const href = a.href || '';
    if (href && href.includes('facebook.com') && 
        !href.match(/facebook\.com\/[^\/?]+$/)) {
      return stripTracking(href);
    }
  }
  
  return null;
}

// ============================================
// REMAINING HELPER FUNCTIONS
// ============================================

function isComment(el) {
  const ownLabel = (el.getAttribute('aria-label') || '').trim();
  if (/^comment(s)?\s*(by)?\b/i.test(ownLabel)) return true;

  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 20) {
    const role = node.getAttribute && node.getAttribute('role');
    const label = (node.getAttribute && node.getAttribute('aria-label') || '').trim();
    if ((role === 'list' || role === 'complementary') && /^comments?$/i.test(label)) {
      return true;
    }
    node = node.parentElement;
    depth++;
  }
  return false;
}

function getCaptionText(container) {
  const msgSelectors = [
    '[data-ad-preview="message"]',
    '[data-ad-comet-preview="message"]',
    '[data-testid="post_message"]',
    '[data-testid="status-text"]',
    '.userContent',
    '.post_content'
  ];
  
  for (const selector of msgSelectors) {
    try {
      const el = container.querySelector(selector);
      if (el) {
        const t = cleanText(el.innerText || el.textContent || '');
        if (t && t.length > 10) return t;
      }
    } catch (e) {}
  }
  
  // Try to find the main text in the container
  const textEls = container.querySelectorAll('div[dir="auto"], span[dir="auto"], p');
  for (const el of textEls) {
    if (el.closest('[role="button"]')) continue;
    const t = cleanText(el.innerText || el.textContent || '');
    if (t && t.length > 20 && !t.toLowerCase().includes('comment') && !t.toLowerCase().includes('share')) {
      return t;
    }
  }
  
  return null;
}

function collapseRepeats(text) {
  return text.replace(/\b(\w+)(?:\s+\1\b){2,}/gi, '$1');
}

function expandSeeMore(container) {
  let clicked = false;
  const candidates = container.querySelectorAll('[role="button"], span, div');
  for (const el of candidates) {
    if (el.offsetParent === null) continue;
    const t = cleanText(el.innerText || el.textContent || '').toLowerCase();
    if (t === 'see more' || t === 'tingnan pa' || t === 'view more' || t === 'see less' || t === 'more') {
      try {
        el.click();
        clicked = true;
      } catch (e) {}
    }
  }
  return clicked;
}

function cleanText(text) {
  return (text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTracking(href) {
  return href.split('&__tn__')[0].split('&__cft__')[0].split('?__tn__')[0];
}

function normalizeForKey(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function extractPostId(url) {
  if (!url) return '';
  
  const patterns = [
    /story_fbid=([^&]+)/i,
    /\/posts\/([^/?]+)/i,
    /\/permalink\/([^/?]+)/i,
    /\/photos\/([^/?]+)/i,
    /\/videos\/([^/?]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }
  
  return '';
}

function getPageInfo() {
  const url = window.location.href;
  let name = '';
  
  // Try to get page name from the page
  const nameElements = document.querySelectorAll('h1, h2, strong, span[dir="auto"]');
  for (const el of nameElements) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (text && text.length > 2 && text.length < 100) {
      if (!text.toLowerCase().includes('comment') && 
          !text.toLowerCase().includes('share') &&
          !text.toLowerCase().includes('reaction')) {
        name = text;
        break;
      }
    }
  }
  
  if (!name) {
    const urlMatch = url.match(/facebook\.com\/([^/?]+)/);
    if (urlMatch) {
      name = urlMatch[1];
    }
  }
  
  return {
    name: name || 'Unknown Page',
    url: url
  };
}

function navigateToPost(postData) {
  if (postData.url && postData.url.includes('facebook.com')) {
    window.location.href = postData.url;
    return { success: true, method: 'url', url: postData.url };
  }

  if (postData.text) {
    const element = findPostElementByText(postData.text);
    if (element) {
      const link = element.querySelector('a[href*="/posts/"], a[href*="/photos/"], time a');
      if (link && link.href) {
        window.location.href = link.href;
        return { success: true, method: 'link', url: link.href };
      }
      try { element.click(); return { success: true, method: 'click' }; } catch (e) {}
    }
  }

  return { success: false, error: 'Post not found' };
}

function findPostElementByText(text) {
  if (!text) return null;
  const searchText = text.slice(0, 50).replace(/'/g, "\\'");
  
  try {
    const xpath = `//*[contains(text(), '${searchText}')]`;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = result.singleNodeValue;
    if (node) {
      let element = node;
      while (element && element !== document.body) {
        if (element.tagName === 'ARTICLE' || 
            element.getAttribute('role') === 'article' ||
            element.getAttribute('data-pagelet')?.startsWith('FeedUnit_')) {
          return element;
        }
        element = element.parentElement;
      }
      return node;
    }
  } catch (e) {}

  const elements = document.querySelectorAll('div, span, p, article');
  for (const el of elements) {
    const elText = el.innerText || el.textContent || '';
    if (elText.includes(text.slice(0, 50)) && elText.length < 2000) {
      let element = el;
      while (element && element !== document.body) {
        if (element.tagName === 'ARTICLE' || 
            element.getAttribute('role') === 'article' ||
            element.getAttribute('data-pagelet')?.startsWith('FeedUnit_')) {
          return element;
        }
        element = element.parentElement;
      }
      return el;
    }
  }

  return null;
}

console.log('[FB-SCRAPER] Ready - Enhanced version scanning up to 1000 posts');