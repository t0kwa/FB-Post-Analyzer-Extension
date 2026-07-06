// inject.js - Fixed to actually send results

console.log('[FB-KW] Injection script loaded');

// Listen for search commands
window.addEventListener('message', function(event) {
  if (event.source !== window) return;
  if (event.data.type === 'FB_KW_SEARCH') {
    console.log('[FB-KW] Inject: Searching for:', event.data.keyword);
    searchPosts(event.data.keyword);
  }
});

// Main search function
function searchPosts(keyword) {
  try {
    console.log('[FB-KW] Inject: Starting search...');
    
    // Strategy 1: Try to get text from React data
    let posts = findPostsViaReact();
    console.log('[FB-KW] Inject: Found via React:', posts.length);
    
    if (posts.length === 0) {
      // Strategy 2: Try DOM
      posts = findPostsViaDOM();
      console.log('[FB-KW] Inject: Found via DOM:', posts.length);
    }
    
    if (posts.length === 0) {
      // Strategy 3: Try text
      posts = findPostsViaText();
      console.log('[FB-KW] Inject: Found via Text:', posts.length);
    }
    
    // Filter by keyword
    const keywordLower = keyword.toLowerCase();
    const matched = [];
    const seen = new Set();
    
    for (const post of posts) {
      const text = post.text || '';
      if (!text) continue;
      
      if (!text.toLowerCase().includes(keywordLower)) continue;
      
      const key = text.slice(0, 100);
      if (seen.has(key)) continue;
      seen.add(key);
      
      // Extract metrics
      const reactions = extractNumber(text, /([\d.,]+[KkMmBb]?)\s*(?:reactions|likes?)/i);
      const comments = extractNumber(text, /([\d.,]+[KkMmBb]?)\s*comments?/i);
      const shares = extractNumber(text, /([\d.,]+[KkMmBb]?)\s*shares?/i);
      
      const snippet = text.length > 160 ? text.slice(0, 160) + '...' : text;
      
      matched.push({
        snippet: snippet.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
        reactions: reactions,
        comments: comments,
        shares: shares,
        url: post.url || window.location.href,
        text: text
      });
    }
    
    console.log('[FB-KW] Inject: Found', matched.length, 'matching posts');
    
    // Send results back
    window.postMessage({
      type: 'FB_KW_RESULTS',
      results: {
        posts: matched,
        scanned: posts.length
      }
    }, '*');
    
  } catch (error) {
    console.error('[FB-KW] Inject: Error:', error);
    window.postMessage({
      type: 'FB_KW_ERROR',
      error: error.message
    }, '*');
  }
}

// Find posts via React data
function findPostsViaReact() {
  const posts = [];
  const seen = new Set();
  
  // Look for any element with data that might contain post text
  const allElements = document.querySelectorAll('[data-ft], [data-pagelet], [data-testid]');
  
  for (const el of allElements) {
    // Check all attributes
    const attrs = el.attributes;
    let postText = '';
    
    for (const attr of attrs) {
      const value = attr.value;
      if (typeof value === 'string' && value.length > 50) {
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(value);
          const text = extractTextFromObject(parsed);
          if (text && text.length > 30) {
            postText = text;
            break;
          }
        } catch (e) {
          // Not JSON, check if it looks like text
          if (value.length > 50 && !value.includes('{') && !value.includes('[')) {
            // Check if it's meaningful text
            if (!value.includes('comment') && 
                !value.includes('share') && 
                !value.includes('reaction') &&
                !value.match(/^[\d,.\s]+$/)) {
              postText = value;
              break;
            }
          }
        }
      }
    }
    
    // Also check inner text
    if (!postText) {
      const text = el.innerText || el.textContent || '';
      if (text.length > 50) {
        const lower = text.toLowerCase();
        if (!lower.includes('comment') && 
            !lower.includes('share') && 
            !lower.includes('reaction') &&
            !lower.includes('like') &&
            !lower.includes('view more') &&
            !lower.includes('see more') &&
            !lower.includes('write a') &&
            !lower.includes('ago') &&
            !/^[\d,.\s]+$/.test(text)) {
          postText = text;
        }
      }
    }
    
    if (postText && postText.length > 30) {
      const key = postText.slice(0, 100);
      if (!seen.has(key)) {
        seen.add(key);
        const url = findPostUrl(el);
        posts.push({
          element: el,
          text: postText,
          url: url || window.location.href
        });
      }
    }
  }
  
  return posts;
}

// Find posts via DOM
function findPostsViaDOM() {
  const posts = [];
  const seen = new Set();
  
  const selectors = [
    'article',
    '[role="article"]',
    'div[data-pagelet^="FeedUnit_"]',
    'div[data-testid="post-container"]',
    'div[class*="story"]',
    'div[class*="post"]'
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      if (el.closest('[role="dialog"]') || 
          el.closest('[aria-label*="Comment"]') ||
          el.closest('[class*="comment"]')) {
        continue;
      }
      
      const text = el.innerText || el.textContent || '';
      if (text.length > 50) {
        const lower = text.toLowerCase();
        if (!lower.includes('comment') && 
            !lower.includes('share') && 
            !lower.includes('reaction') &&
            !lower.includes('like') &&
            !lower.includes('view more') &&
            !lower.includes('see more') &&
            !lower.includes('write a') &&
            !lower.includes('ago') &&
            !/^[\d,.\s]+$/.test(text)) {
          
          const key = text.slice(0, 100);
          if (!seen.has(key)) {
            seen.add(key);
            const url = findPostUrl(el);
            posts.push({
              element: el,
              text: text,
              url: url || window.location.href
            });
          }
        }
      }
    }
  }
  
  return posts;
}

// Find posts via text
function findPostsViaText() {
  const posts = [];
  const seen = new Set();
  
  const bodyText = document.body.innerText || '';
  const lines = bodyText.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 50);
  
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!lower.includes('comment') && 
        !lower.includes('share') && 
        !lower.includes('reaction') &&
        !lower.includes('like') &&
        !lower.includes('view more') &&
        !lower.includes('see more') &&
        !lower.includes('write a') &&
        !lower.includes('ago') &&
        !/^[\d,.\s]+$/.test(line)) {
      
      const key = line.slice(0, 100);
      if (!seen.has(key)) {
        seen.add(key);
        posts.push({
          element: null,
          text: line,
          url: window.location.href
        });
      }
    }
  }
  
  return posts;
}

// Helper: Extract text from object
function extractTextFromObject(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number') return String(obj);
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const text = extractTextFromObject(item);
      if (text && text.length > 20) return text;
    }
    return '';
  }
  
  if (typeof obj === 'object') {
    const textFields = ['text', 'message', 'content', 'body', 'story', 'post', 'description'];
    for (const field of textFields) {
      if (obj[field] && typeof obj[field] === 'string' && obj[field].length > 20) {
        return obj[field];
      }
    }
    
    for (const key in obj) {
      const text = extractTextFromObject(obj[key]);
      if (text && text.length > 20) return text;
    }
  }
  
  return '';
}

// Helper: Find post URL
function findPostUrl(element) {
  if (!element) return null;
  
  const links = element.querySelectorAll('a[href]');
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
  
  return null;
}

// Helper: Extract number
function extractNumber(text, regex) {
  const match = text.match(regex);
  if (match) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (match[1].toLowerCase().includes('k')) return Math.round(num * 1000);
    if (match[1].toLowerCase().includes('m')) return Math.round(num * 1000000);
    return Math.round(num);
  }
  return 0;
}

console.log('[FB-KW] Injection script ready');