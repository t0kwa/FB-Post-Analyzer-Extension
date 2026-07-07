// content.js - Full Facebook Post Scraper

console.log('[FB-SCRAPER] Content script loaded');

let allScrapedPosts = [];
let seenKeys = new Set();
let isScraping = false;
let currentPageName = '';
const MAX_SCAN_LIMIT = 1000;

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
  
  const pageInfo = getPageInfo();
  currentPageName = pageInfo.name;
  
  let containers = getPostContainers();
  console.log('[FB-SCRAPER] Found', containers.length, 'containers');

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
    if (allScrapedPosts.length >= MAX_SCAN_LIMIT) {
      console.log('[FB-SCRAPER] Stopping - reached max scan limit');
      break;
    }
    
    try {
      const postData = extractFullPostData(container, pageInfo);
      if (!postData) continue;
      
      scannedCount++;
      
      if (keywordLower) {
        const textLower = postData.text.toLowerCase();
        const fullTextLower = (postData.fullText || '').toLowerCase();
        const authorLower = (postData.authorName || '').toLowerCase();
        
        if (!textLower.includes(keywordLower) && 
            !fullTextLower.includes(keywordLower) && 
            !authorLower.includes(keywordLower)) {
          continue;
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
// EXTRACT FULL POST DATA
// ============================================
function extractFullPostData(container, pageInfo) {
  const fullText = cleanText(container.innerText || '');
  if (!fullText || fullText.length < 20) return null;

  let text = getCaptionText(container) || collapseRepeats(fullText);
  
  let url = getPermalink(container);
  let postId = extractPostId(url || '');

  // If no post ID found, try to get from container attributes
  if (!postId) {
    const dataAttrs = ['data-story-id', 'data-post-id', 'data-ft'];
    for (const attr of dataAttrs) {
      const val = container.getAttribute(attr);
      if (val) {
        const match = val.match(/(\d+)/);
        if (match) {
          postId = match[1];
          break;
        }
      }
    }
  }

  const reactions = extractEngagementMetric(container, fullText, 'reactions');
  const comments = extractEngagementMetric(container, fullText, 'comments');
  const shares = extractEngagementMetric(container, fullText, 'shares');
  const timestamp = extractTimestamp(container);
  const images = extractImages(container);
  const author = extractAuthor(container);

  return {
    postId: postId || '',
    url: url || window.location.href,
    text: text || '',
    timestamp: timestamp || '',
    reactions: reactions,
    comments: comments,
    shares: shares,
    authorName: author.name || '',
    authorUrl: author.url || '',
    pageName: pageInfo.name || '',
    pageUrl: pageInfo.url || '',
    images: images || [],
    scrapedAt: new Date().toISOString(),
    fullText: fullText.slice(0, 2000)
  };
}

// ============================================
// ENGAGEMENT METRIC EXTRACTION
// ============================================
function extractEngagementMetric(container, fullText, type) {
  const roleSelectors = {
    reactions: '[data-ad-rendering-role="like_button"], [data-ad-rendering-role="reaction_button"], [data-ad-rendering-role="reactions_button"], [data-ad-rendering-role="like_count"]',
    comments: '[data-ad-rendering-role="comment_button"], [data-ad-rendering-role="comment_count"]',
    shares: '[data-ad-rendering-role="share_button"], [data-ad-rendering-role="share_count"]'
  };

  const selector = roleSelectors[type];
  if (!selector) return 0;

  const buttons = Array.from(container.querySelectorAll(selector));
  let bestCount = 0;

  for (const button of buttons) {
    const count = findAdjacentEngagementCount(button);
    if (count > bestCount) bestCount = count;
  }

  if (bestCount > 0) return bestCount;

  const fallback = findEngagementByIcon(container, type);
  return fallback;
}

function findAdjacentEngagementCount(button) {
  if (!button) return 0;
  const parent = button.parentElement;
  if (!parent) return 0;

  const exactSpan = parent.querySelector('span');
  if (exactSpan) {
    const count = parseEngagementNumber(cleanText(exactSpan.innerText || exactSpan.textContent || ''));
    if (count > 0) return count;
  }

  const siblingSpan = button.nextElementSibling && button.nextElementSibling.querySelector('span');
  if (siblingSpan) {
    const count = parseEngagementNumber(cleanText(siblingSpan.innerText || siblingSpan.textContent || ''));
    if (count > 0) return count;
  }

  let node = button;
  let depth = 0;
  while (node && depth < 5) {
    const spans = node.querySelectorAll('span');
    for (const span of spans) {
      const count = parseEngagementNumber(cleanText(span.innerText || span.textContent || ''));
      if (count > 0) return count;
    }
    node = node.parentElement;
    depth += 1;
  }

  const siblings = button.parentElement ? Array.from(button.parentElement.children) : [];
  for (const sibling of siblings) {
    if (sibling === button) continue;
    const spans = sibling.querySelectorAll('span');
    for (const span of spans) {
      const count = parseEngagementNumber(cleanText(span.innerText || span.textContent || ''));
      if (count > 0) return count;
    }
  }

  return 0;
}

function findEngagementByIcon(container, type) {
  const iconMap = {
    reactions: ['like', 'reaction', 'thumb', '❤️', '👍'],
    comments: ['comment', 'reply', '💬'],
    shares: ['share', '↗️']
  };
  const keywords = iconMap[type] || [];
  const spans = Array.from(container.querySelectorAll('span'));

  for (const span of spans) {
    const text = cleanText(span.innerText || span.textContent || '');
    if (!text) continue;
    const lower = text.toLowerCase();
    if (keywords.some(k => lower.includes(k))) {
      const count = parseEngagementNumber(text);
      if (count > 0) return count;
    }
  }

  return 0;
}

function parseEngagementNumber(text) {
  if (!text) return 0;
  const clean = text.replace(/[^0-9.,KkMmBb]/g, '');
  if (!clean) return 0;
  
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
// POST CONTAINER DETECTION
// ============================================
function getPostContainers() {
  let allPosts = [];
  
  const articles = document.querySelectorAll('[role="article"]');
  for (const article of articles) {
    if (!isComment(article) && article.innerText.length > 50) {
      allPosts.push(article);
    }
  }
  
  const feedUnits = document.querySelectorAll('[data-pagelet*="FeedUnit"], [data-pagelet*="feed"]');
  for (const unit of feedUnits) {
    if (!isComment(unit) && unit.innerText.length > 50) {
      const childArticles = unit.querySelectorAll('[role="article"]');
      if (childArticles.length > 1) {
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
  
  const actionButtons = document.querySelectorAll(
    '[data-ad-rendering-role="like_button"], ' +
    '[data-ad-rendering-role="comment_button"], ' +
    '[data-ad-rendering-role="share_button"]'
  );
  
  for (const btn of actionButtons) {
    let container = btn.closest('[role="article"]');
    if (!container) {
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
// EXTRACT AUTHOR INFO
// ============================================
function extractAuthor(container) {
  const links = container.querySelectorAll('a[href*="facebook.com"]');
  
  for (const link of links) {
    const href = link.href || '';
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
      if (!text.includes('facebook') && 
          !text.includes('profile') && 
          !text.includes('page') &&
          !text.match(/^[\d,.]/)) {
        return { name: text, url: href };
      }
    }
  }
  
  const strong = container.querySelectorAll('strong, b, h3, h4, h5');
  for (const el of strong) {
    const text = cleanText(el.innerText || el.textContent || '');
    if (text && text.length > 2 && text.length < 100 && !text.match(/^[\d,.]/)) {
      const nearbyLink = el.closest('a');
      if (nearbyLink) {
        return { name: text, url: nearbyLink.href || '' };
      }
      return { name: text, url: '' };
    }
  }
  
  return { name: '', url: '' };
}

// ============================================
// EXTRACT TIMESTAMP
// ============================================
function extractTimestamp(container) {
  const timeSelectors = [
    'time',
    'abbr',
    '[data-testid="post_timestamp"]',
    '[aria-label*="hour" i]',
    '[aria-label*="minute" i]',
    '[aria-label*="day" i]'
  ];
  
  for (const selector of timeSelectors) {
    try {
      const elements = container.querySelectorAll(selector);
      for (const el of elements) {
        const datetime = el.getAttribute('datetime') || '';
        if (datetime) return datetime;
        
        const label = el.getAttribute('aria-label') || '';
        if (label && (label.includes('hour') || label.includes('minute') || label.includes('day'))) {
          return label;
        }
        
        const text = cleanText(el.innerText || el.textContent || '');
        if (text && (text.includes('hour') || text.includes('minute') || text.includes('day') || 
            text.includes('ago') || text.includes('at') || text.match(/\d{1,2}:\d{2}/))) {
          return text;
        }
      }
    } catch (e) {}
  }
  
  const allText = container.innerText || '';
  const timeMatch = allText.match(/(\d+\s*(?:hour|minute|day|week|month|year)s?\s*ago)/i);
  if (timeMatch) return timeMatch[1];
  
  return '';
}

// ============================================
// EXTRACT IMAGES
// ============================================
function extractImages(container) {
  const images = [];
  const seen = new Set();
  
  const imgElements = container.querySelectorAll('img');
  for (const img of imgElements) {
    const src = img.src || '';
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
  
  const divs = container.querySelectorAll('div[style*="background-image"]');
  for (const div of divs) {
    const style = div.getAttribute('style') || '';
    const match = style.match(/url\(['"]?([^'"()]+)['"]?\)/);
    if (match && match[1] && !seen.has(match[1]) && match[1].length > 20) {
      seen.add(match[1]);
      images.push(match[1]);
    }
  }
  
  return images.slice(0, 10);
}

// ============================================
// GET PERMALINK
// ============================================
function getPermalink(container) {
  const links = container.querySelectorAll('a[href]');
  const matchesPostUrl = (href) => {
    return /\/posts\/|\/permalink\/|story_fbid=|\/story\.php|\/photos\/|\/videos\/|ft_ent_identifier=|fbid=|[\?&]id=/i.test(href);
  };
  
  for (const a of links) {
    let href = a.href || '';
    if (!href) continue;
    if (matchesPostUrl(href)) {
      return normalizeUrl(stripTracking(href));
    }
  }
  
  for (const a of links) {
    let href = a.href || '';
    if (!href) continue;
    if (a.querySelector('time') || a.querySelector('abbr') || a.querySelector('[datetime]')) {
      return normalizeUrl(stripTracking(href));
    }
  }
  
  for (const a of links) {
    let href = a.href || '';
    if (!href) continue;
    if (href.includes('facebook.com') && !href.match(/facebook\.com\/[^\/?]+$/)) {
      return normalizeUrl(stripTracking(href));
    }
  }
  
  return null;
}

// ============================================
// NAVIGATE TO POST - FIXED
// ============================================
function navigateToPost(postData) {
  console.log('[FB-SCRAPER] Navigating to post:', postData);
  
  // Strategy 1: Direct URL navigation (most reliable)
  if (postData.url && postData.url.includes('facebook.com')) {
    // Check if it's a valid post URL
    if (postData.url.includes('/posts/') || 
        postData.url.includes('/permalink/') || 
        postData.url.includes('story_fbid=') ||
        postData.url.includes('/photos/') ||
        postData.url.includes('/videos/')) {
      console.log('[FB-SCRAPER] Opening post URL directly:', postData.url);
      window.location.href = postData.url;
      return { success: true, method: 'url', url: postData.url };
    }
    
    // If it's just a page URL, try to find the actual post
    console.log('[FB-SCRAPER] URL is page URL, searching for post...');
  }

  // Strategy 2: Find by text content
  if (postData.text) {
    console.log('[FB-SCRAPER] Searching for post by text...');
    const element = findPostElementByText(postData.text);
    if (element) {
      console.log('[FB-SCRAPER] Found element by text');
      
      // Try to find post link
      const link = element.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="/photos/"], a[href*="/videos/"]');
      if (link && link.href) {
        console.log('[FB-SCRAPER] Found post link:', link.href);
        window.location.href = link.href;
        return { success: true, method: 'link', url: link.href };
      }
      
      // Try to find any link with Facebook URL
      const anyLink = element.querySelector('a[href*="facebook.com"]');
      if (anyLink && anyLink.href && 
          !anyLink.href.match(/facebook\.com\/[^\/?]+$/) &&
          !anyLink.href.includes('/profile.php')) {
        console.log('[FB-SCRAPER] Found Facebook link:', anyLink.href);
        window.location.href = anyLink.href;
        return { success: true, method: 'link', url: anyLink.href };
      }
      
      // Click the element as last resort
      try {
        console.log('[FB-SCRAPER] Clicking element...');
        element.click();
        return { success: true, method: 'click' };
      } catch (e) {
        console.warn('[FB-SCRAPER] Click failed:', e);
      }
    }
  }

  // Strategy 3: Search by post ID
  if (postData.postId) {
    console.log('[FB-SCRAPER] Searching for post by ID:', postData.postId);
    const links = document.querySelectorAll('a[href*="story_fbid=' + postData.postId + '"], a[href*="/posts/' + postData.postId + '"]');
    for (const link of links) {
      if (link.href) {
        console.log('[FB-SCRAPER] Found post by ID:', link.href);
        window.location.href = link.href;
        return { success: true, method: 'id', url: link.href };
      }
    }
  }

  // Strategy 4: Search by author + text
  if (postData.authorName && postData.text) {
    console.log('[FB-SCRAPER] Searching by author and text...');
    const authorText = postData.authorName.slice(0, 20);
    const postText = postData.text.slice(0, 30);
    
    const elements = document.querySelectorAll('div[role="article"], article');
    for (const el of elements) {
      const elText = el.innerText || '';
      if (elText.includes(authorText) && elText.includes(postText)) {
        const link = el.querySelector('a[href*="/posts/"], a[href*="/permalink/"]');
        if (link && link.href) {
          console.log('[FB-SCRAPER] Found post by author+text:', link.href);
          window.location.href = link.href;
          return { success: true, method: 'author_text', url: link.href };
        }
      }
    }
  }

  console.log('[FB-SCRAPER] Could not find post');
  return { success: false, error: 'Post not found on page' };
}

// ============================================
// FIND POST ELEMENT BY TEXT - IMPROVED
// ============================================
function findPostElementByText(text) {
  if (!text) return null;
  
  const searchText = text.slice(0, 50).replace(/'/g, "\\'").replace(/"/g, '\\"');
  console.log('[FB-SCRAPER] Searching for:', searchText);
  
  // Try XPath
  try {
    const xpath = `//*[contains(text(), '${searchText}')]`;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    const node = result.singleNodeValue;
    if (node) {
      let element = node;
      while (element && element !== document.body) {
        if (element.tagName === 'ARTICLE' || 
            element.getAttribute('role') === 'article' ||
            element.getAttribute('data-pagelet')?.startsWith('FeedUnit_') ||
            element.getAttribute('data-testid') === 'post_container') {
          return element;
        }
        element = element.parentElement;
      }
      return node;
    }
  } catch (e) {
    console.warn('[FB-SCRAPER] XPath search failed:', e);
  }

  // Try finding by partial text match in post containers
  const containers = document.querySelectorAll('div[role="article"], article, div[data-pagelet*="FeedUnit"], div[data-testid="post_container"]');
  const searchWords = text.slice(0, 30).split(' ').filter(w => w.length > 5);
  
  for (const el of containers) {
    const elText = el.innerText || el.textContent || '';
    let matchCount = 0;
    for (const word of searchWords) {
      if (elText.includes(word)) matchCount++;
    }
    if (matchCount >= Math.min(2, searchWords.length)) {
      return el;
    }
  }

  // Last resort: look for any element containing the text
  const allElements = document.querySelectorAll('div, span, p');
  for (const el of allElements) {
    const elText = el.innerText || el.textContent || '';
    if (elText.includes(text.slice(0, 30)) && elText.length < 2000) {
      let element = el;
      while (element && element !== document.body) {
        if (element.tagName === 'ARTICLE' || 
            element.getAttribute('role') === 'article' ||
            element.getAttribute('data-pagelet')?.startsWith('FeedUnit_') ||
            element.getAttribute('data-testid') === 'post_container') {
          return element;
        }
        element = element.parentElement;
      }
      return el;
    }
  }

  return null;
}

// ============================================
// HELPER FUNCTIONS
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
    '.post_content',
    '.html-div',
    '[dir="auto"]'
  ];

  for (const selector of msgSelectors) {
    try {
      const elements = Array.from(container.querySelectorAll(selector));
      for (const el of elements) {
        if (el.closest('[role="button"]')) continue;
        const text = cleanText(el.innerText || el.textContent || '');
        if (!text || text.length < 15) continue;
        if (/see less|see more|view more|more|less/i.test(text)) continue;
        if (/comment|share|like|reaction/i.test(text) && text.split('\n').length <= 2) continue;
        return text;
      }
    } catch (e) {}
  }

  const bodyNodes = Array.from(container.querySelectorAll('div[dir="auto"]'));
  let bestText = '';
  for (const node of bodyNodes) {
    if (node.closest('[role="button"]')) continue;
    const text = cleanText(node.innerText || node.textContent || '');
    if (!text || text.length < 15) continue;
    if (/see less|see more|view more|more|less/i.test(text)) continue;
    if (text.includes('http') && text.length < 60) continue;
    if (text.length > bestText.length) {
      bestText = text;
    }
  }
  if (bestText) return bestText;

  const paragraphNodes = Array.from(container.querySelectorAll('p'));
  for (const p of paragraphNodes) {
    const text = cleanText(p.innerText || p.textContent || '');
    if (text && text.length > 15 && !/see less|see more/i.test(text)) {
      return text;
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

function normalizeUrl(href) {
  try {
    return new URL(href, window.location.href).href;
  } catch (e) {
    return href;
  }
}

function normalizeForKey(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 150);
}

function extractPostId(url) {
  if (!url) return '';
  
  const patterns = [
    /story_fbid=([^&]+)/i,
    /ft_ent_identifier=([^&]+)/i,
    /fbid=([^&]+)/i,
    /[\?&]id=(\d+)/i,
    /\/posts\/([^/?&]+)/i,
    /\/permalink\/([^/?&]+)/i,
    /\/photos\/([^/?&]+)/i,
    /\/videos\/([^/?&]+)/i
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return '';
}

function getPageInfo() {
  const url = window.location.href;
  let name = '';
  
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
    if (urlMatch) name = urlMatch[1];
  }
  
  return { name: name || 'Unknown Page', url: url };
}

console.log('[FB-SCRAPER] Ready - Enhanced version scanning up to 1000 posts');