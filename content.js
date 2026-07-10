// Full Facebook Post Scraper (with single-post verification)


console.log('[FB-SCRAPER] Content script loaded');

let allScrapedPosts = [];   // formatted posts currently exposed to the popup
let rawPosts = [];          // deduped raw post groups collected so far (this page/session)
let seenRaw = new Map();    // dedupe key -> index into rawPosts
let currentPageName = '';
const MAX_SCAN_LIMIT = 5000;

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[FB-SCRAPER] Message:', request?.action);

  try {
    if (request.action === 'PING') {
      sendResponse({ alive: true, postsFound: allScrapedPosts.length });
      return false;
    }

    if (request.action === 'SCRAPE_POSTS') {
      (async () => {
        try {
          if (!request.isAutoScrape) {
            allScrapedPosts = [];
            rawPosts = [];
            seenRaw = new Map();
          }
          const results = await scrapePosts(request.keyword, request.maxPosts);
          sendResponse(results);
        } catch (e) {
          console.error('[FB-SCRAPER] Scrape error:', e, e && e.stack ? e.stack : 'no-stack');
          sendResponse({ posts: allScrapedPosts, scanned: 0, error: e && e.message ? e.message : String(e) });
        }
      })();
      return true;
    }

    if (request.action === 'SCROLL_DOWN') {
      (async () => {
        const before = {
          scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
          height: Math.round(document.documentElement.scrollHeight || document.body.scrollHeight || 0)
        };

        try {
          window.scrollBy({ top: Math.max(window.innerHeight * 0.55, 550), left: 0, behavior: 'instant' });
        } catch (e) {
          window.scrollBy(0, 800);
        }

        try {
          window.dispatchEvent(new WheelEvent('wheel', { deltaY: 700, bubbles: true, cancelable: true }));
        } catch (e) {}

        const grew = await waitFor(() => {
          const scrollY = Math.round(window.scrollY || document.documentElement.scrollTop || 0);
          const height = Math.round(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
          return (scrollY > before.scrollY + 100 || height > before.height + 100) ? true : null;
        }, 4000, 150);

        sendResponse({ done: true, grew: !!grew });
      })();
      return true;
    }

    if (request.action === 'GET_PAGE_INFO') {
      const info = getPageInfo();
      sendResponse(info);
      return false;
    }

    if (request.action === 'CHECK_LOGIN') {
      const loggedIn = isFacebookLoggedIn();
      sendResponse({ loggedIn, url: window.location.href });
      return false;
    }

    if (request.action === 'CLEAR_ACCUMULATED') {
      allScrapedPosts = [];
      rawPosts = [];
      seenRaw = new Map();
      sendResponse({ done: true });
      return false;
    }

    if (request.action === 'GET_SCRAPED_DATA') {
      sendResponse({
        posts: allScrapedPosts,
        count: allScrapedPosts.length,
        pageName: currentPageName,
        pageUrl: window.location.href
      });
      return false;
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
      return false;
    }

    return false;
  } catch (e) {
    console.error('[FB-SCRAPER] Message handler failed:', e);
    sendResponse({ error: e && e.message ? e.message : String(e) });
    return false;
  }
});

// ============================================
// MAIN SCRAPING FUNCTION
// (one pass over what's currently rendered - popup.js drives the
// auto-scroll loop itself via repeated SCRAPE_POSTS + SCROLL_DOWN calls)
// ============================================
async function scrapePosts(keyword = '', maxPosts) {
  console.log('[FB-SCRAPER] Scraping posts...');

  const effectiveLimit = Math.min(
    MAX_SCAN_LIMIT,
    Number(maxPosts) > 0 ? Math.floor(Number(maxPosts)) : MAX_SCAN_LIMIT
  );

  if (allScrapedPosts.length >= effectiveLimit) {
    console.log('[FB-SCRAPER] Reached post limit:', effectiveLimit);
    return {
      posts: allScrapedPosts,
      scanned: 0,
      newPosts: 0,
      total: allScrapedPosts.length,
      pageName: currentPageName,
      maxReached: true
    };
  }

  const pageIdentity = buildPageIdentity();
  currentPageName = pageIdentity.name;

  // Reveal any machine-translated captions and expand "See more" before
  // reading text, same as the reference scraper's pre-collection pass.
  await revealOriginalText(2);
  await expandSeeMoreButtons(3);
  await new Promise(r => setTimeout(r, 300));

  const collection = await collectPostGroups(pageIdentity);
  const groups = collection.groups;
  const keywordList = parseKeywords(keyword);
  const scannedCount = groups.length;

  console.log('[FB-SCRAPER] Candidates:', collection.stats.candidateRoots, 'Messages:', collection.stats.messageContainers);

  for (const group of groups) {
    const key = getPostKey(group);
    const textKey = getPostTextKey(group);

    if (!key) continue;

    if (textKey && mergeSeenPost(seenRaw, rawPosts, textKey, group)) continue;
    if (mergeSeenPost(seenRaw, rawPosts, key, group)) continue;

    seenRaw.set(key, rawPosts.length);
    if (textKey) seenRaw.set(textKey, rawPosts.length);
    rawPosts.push(group);
  }

  const authorFiltered = rawPosts.filter((post) => pageAuthorMatches(post.author, pageIdentity));
  const keywordFiltered = authorFiltered.filter((post) =>
    matchesKeyword({ text: post.text, authorName: post.author?.name, url: post.link }, keywordList)
  );

  const previousTotal = allScrapedPosts.length;
  allScrapedPosts = keywordFiltered
    .slice(0, effectiveLimit)
    .map((post) => formatPost(post, pageIdentity));
  const newCount = Math.max(0, allScrapedPosts.length - previousTotal);

  console.log('[FB-SCRAPER] Scanned', scannedCount, 'candidates. Raw so far:', rawPosts.length, 'Matched:', allScrapedPosts.length);

  return {
    posts: allScrapedPosts,
    scanned: scannedCount,
    newPosts: newCount,
    total: allScrapedPosts.length,
    pageName: currentPageName,
    maxReached: allScrapedPosts.length >= effectiveLimit
  };
}

// ============================================
// PAGE IDENTITY (page name + slug, used to tell the page's own posts
// apart from comments / shares by other people)
// ============================================
function buildPageIdentity() {
  return {
    name: detectPageName(),
    slug: getPageSlug(window.location.href)
  };
}

function detectPageName() {
  const normalizeTextLocal = (value) => String(value || '').replace(/\s+/g, ' ').trim();

  const heading = Array.from(document.querySelectorAll('h1'))
    .map((element) => normalizeTextLocal(element.innerText || element.textContent || ''))
    .find((text) => text && text.length <= 100);

  if (heading) return heading;

  const title = normalizeTextLocal(document.title || '');
  const cleanedTitle = title
    .replace(/\s*\|\s*Facebook.*$/i, '')
    .replace(/\s*-\s*Facebook.*$/i, '')
    .trim();

  if (cleanedTitle) return cleanedTitle;

  const slug = getPageSlug(window.location.href);
  return slug ? slug.replace(/[._-]+/g, ' ').trim() : '';
}

function getPageSlug(url) {
  try {
    const parsed = new URL(url);

    return parsed.pathname
      .split('/')
      .filter(Boolean)
      .find((part) => !['profile.php', 'groups', 'pages', 'posts', 'videos', 'photos'].includes(part.toLowerCase())) || '';
  } catch {
    return '';
  }
}

function pageAuthorMatches(author, identity) {
  if (!identity || (!identity.name && !identity.slug)) return true;

  const authorName = normalizeName(author?.name);
  const expectedName = normalizeName(identity.name);
  const authorHref = String(author?.href || '').toLowerCase();
  const expectedSlug = String(identity.slug || '').toLowerCase();

  if (expectedSlug && authorHref.includes(`/${expectedSlug}`)) return true;
  if (!authorName || !expectedName) return false;

  return authorName === expectedName ||
    authorName.includes(expectedName) ||
    expectedName.includes(authorName);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================
// KEYWORD MATCHING
// ============================================
function parseKeywords(keywords) {
  return String(keywords || '')
    .split(',')
    .map((keyword) => cleanText(keyword).toLowerCase())
    .filter(Boolean);
}

function matchesKeyword(postData, keywordList) {
  if (!keywordList || keywordList.length === 0) return true;
  return keywordList.some((keyword) => matchesSingleKeyword(postData, keyword));
}

function matchesSingleKeyword(postData, keywordLower) {
  if (!keywordLower) return true;
  const norm = (s) => cleanText(String(s || '')).toLowerCase();
  const fields = [postData.text, postData.combinedText, postData.fullText, postData.authorName, postData.url];
  for (const f of fields) {
    if (!f) continue;
    const v = norm(f);
    if (v.includes(keywordLower)) return true;
  }

  const combined = norm((postData.combinedText || postData.fullText || postData.text || ''));
  const tokens = combined.split(/\s+/).map(t => t.replace(/^[#@]+|[^\w\u00C0-\u017F]+$/g, '')).filter(Boolean);
  if (tokens.includes(keywordLower)) return true;

  return false;
}

// ============================================
// POST GROUP COLLECTION
// Ported from the reference Playwright scraper's collectPostGroups().
// Selectors / aria-labels / ignored-text list are kept verbatim.
// ============================================
const PERMALINK_PATTERNS = [
  '/posts/', '/permalink/', 'story.php', 'story_fbid', '/photos/', 'photo.php',
  'fbid=', '/videos/', '/watch/?v=', '/reel/', '/share/p/', '/share/v/', '/share/r/'
];
const COMMENT_LINK_PATTERNS = ['comment_id=', 'reply_comment_id=', '/comments/', 'comment/replies'];
const IGNORED_TEXT = new Set([
  'like', 'comment', 'share', 'send', 'see more', 'see less', 'all reactions:',
  'top comments', 'most relevant', 'all comments', 'write a comment',
  'view more comments', 'view previous comments', 'hide', 'report', 'follow',
  'message', 'online status indicator active', 'online status indicator inactive'
]);
const POST_MESSAGE_SELECTOR = [
  "[data-ad-preview='message']",
  "[data-ad-comet-preview='message']",
  "[data-ad-rendering-role='story_message']"
].join(', ');

function ptNormalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isCommentLink(link) {
  return COMMENT_LINK_PATTERNS.some((pattern) => (link || '').includes(pattern));
}

function isHiddenEl(element) {
  const style = window.getComputedStyle(element);
  return style.display === 'none' ||
    style.visibility === 'hidden' ||
    element.getAttribute('aria-hidden') === 'true';
}

function isUiText(text) {
  const lower = text.toLowerCase();
  return IGNORED_TEXT.has(lower) ||
    /^\d+[KkMm]?$/.test(text) ||
    /^\d+\s+(comments?|shares?)$/i.test(text) ||
    /^(likes?|comments?|shares?|reply)$/i.test(text) ||
    /^translated/i.test(text) ||
    /translated by facebook/i.test(text);
}

function isAuthorNoise(text, element) {
  const lower = text.toLowerCase();
  const aria = ptNormalizeText(element?.getAttribute('aria-label') || '').toLowerCase();
  const title = ptNormalizeText(element?.getAttribute('title') || '').toLowerCase();
  const combined = `${lower} ${aria} ${title}`;

  return isUiText(text) ||
    combined.includes('online status indicator') ||
    combined.includes('active now') ||
    combined.includes('profile picture') ||
    combined.includes('cover photo') ||
    combined.includes('verified account') ||
    lower.startsWith('see more from ') ||
    lower.startsWith('follow ') ||
    lower.includes(' is with ');
}

function getPostRoot(messageContainer) {
  let article = messageContainer.closest("div[role='article']");

  while (article) {
    if (article.querySelector("h2 a[href], h3 a[href], strong a[href]")) {
      return article;
    }
    article = article.parentElement?.closest("div[role='article']");
  }

  return messageContainer.closest("div[role='article']") ||
    messageContainer.closest('[aria-posinset]') ||
    messageContainer.closest("[data-pagelet^='FeedUnit_']") ||
    messageContainer.closest("[data-pagelet*='FeedUnit']");
}

function getPostIdFromValue(value) {
  const text = String(value || '');
  const match = text.match(/(?:story_fbid|post_id|top_level_post_id|mf_story_key)["'=:%\s]+([A-Za-z0-9_.-]+)/i);
  return match?.[1] || '';
}

function getPostIdFromRoot(root) {
  const values = [];
  const nestedArticles = Array.from(root.querySelectorAll("div[role='article']"))
    .filter((nested) => nested !== root);

  for (const element of [root, ...Array.from(root.querySelectorAll("[data-ft], [data-store], [data-testid], a[href]")).slice(0, 200)]) {
    if (nestedArticles.some((nested) => nested.contains(element))) continue;

    values.push(element.getAttribute('data-ft'));
    values.push(element.getAttribute('data-store'));
    values.push(element.getAttribute('data-testid'));
    if (element.href) values.push(element.href);
  }

  return values.map(getPostIdFromValue).find(Boolean) || '';
}

function buildPostLink(postId, author, identity) {
  if (!postId) return '';

  const cleanPostId = encodeURIComponent(postId);
  const expectedSlug = String(identity?.slug || '');

  if (expectedSlug) {
    return `https://www.facebook.com/${expectedSlug}/posts/${cleanPostId}`;
  }

  try {
    const parsed = new URL(author?.href || '');
    const authorPath = parsed.pathname.replace(/\/$/, '');

    if (authorPath && authorPath !== '/') {
      return `${parsed.origin}${authorPath}/posts/${cleanPostId}`;
    }
  } catch {
    return '';
  }

  return '';
}

function getPostLink(article, author, identity) {
  const expectedSlug = String(identity?.slug || '').toLowerCase();
  const nestedArticles = Array.from(article.querySelectorAll("div[role='article']"))
    .filter((nested) => nested !== article);
  const messageContainers = Array.from(article.querySelectorAll(POST_MESSAGE_SELECTOR))
    .filter((container) => !nestedArticles.some((nested) => nested.contains(container)));
  const isInsidePostMessage = (anchor) => messageContainers.some((container) => container.contains(anchor));
  const firstMessage = Array.from(article.querySelectorAll(POST_MESSAGE_SELECTOR))
    .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
  const firstMessageTop = firstMessage?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;

  const isHeaderAnchor = (anchor) => {
    const box = anchor.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top <= firstMessageTop + 20;
  };
  const isAuthorHref = (href) => {
    try {
      const parsed = new URL(href);
      const cleanPath = parsed.pathname.replace(/^\/|\/$/g, '').toLowerCase();
      return expectedSlug && cleanPath === expectedSlug;
    } catch {
      return false;
    }
  };
  const isPageOwnedPostHref = (href) => {
    try {
      const parsed = new URL(href);
      const path = parsed.pathname.toLowerCase();
      return Boolean(expectedSlug) && (
        path.includes(`/${expectedSlug}/posts/`) ||
        path.includes(`/${expectedSlug}/videos/`) ||
        path.includes(`/${expectedSlug}/photos/`) ||
        path.includes(`/${expectedSlug}/reel/`) ||
        path.includes(`/${expectedSlug}/permalink/`)
      );
    } catch {
      return false;
    }
  };
  const isShareWrapperHref = (href) => {
    try {
      const parsed = new URL(href);
      const path = parsed.pathname.toLowerCase();
      return path.includes('/share/p/') || path.includes('/share/v/') || path.includes('/share/r/');
    } catch {
      return false;
    }
  };
  const getCleanHref = (anchor) => (anchor.href || '').split('#')[0];
  const isPostHref = (href) =>
    href &&
    href.includes('facebook.com') &&
    !isAuthorHref(href) &&
    !isCommentLink(href) &&
    PERMALINK_PATTERNS.some((pattern) => href.includes(pattern));
  const isPrimaryPermalinkHref = (href) => {
    try {
      const parsed = new URL(href);
      const path = parsed.pathname.toLowerCase();
      return path.includes(`/${expectedSlug}/posts/`) ||
        path.includes(`/${expectedSlug}/permalink/`) ||
        href.includes('story.php') ||
        href.includes('story_fbid');
    } catch {
      return false;
    }
  };
  const rankLinks = (links) => {
    const uniqueLinks = [...new Set(links)];
    return uniqueLinks.find((href) => isPageOwnedPostHref(href) && isPrimaryPermalinkHref(href)) ||
      uniqueLinks.find(isPageOwnedPostHref) ||
      uniqueLinks.find(isShareWrapperHref) ||
      uniqueLinks[0] ||
      '';
  };
  const decodeCandidateUrl = (value) => {
    const unescaped = String(value || '')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .replace(/\\u0025/g, '%')
      .replace(/\\u0026/g, '&')
      .replace(/\\u003d/g, '=');
    try {
      return decodeURIComponent(unescaped);
    } catch {
      return unescaped;
    }
  };
  const getMarkupLinks = () => {
    let markupSource = article;
    if (nestedArticles.length || messageContainers.length) {
      const clone = article.cloneNode(true);
      Array.from(clone.querySelectorAll("div[role='article']")).forEach((nested) => nested.remove());
      Array.from(clone.querySelectorAll(POST_MESSAGE_SELECTOR)).forEach((message) => message.remove());
      markupSource = clone;
    }
    const markup = markupSource.outerHTML || '';
    const matches = [
      ...markup.matchAll(/https?:\\?\/\\?\/(?:www\.)?facebook\.com[^"'<>\\\s]+/gi),
      ...markup.matchAll(/https%3A%2F%2F(?:www\.)?facebook\.com[^"'<>\\\s]+/gi)
    ];
    return matches
      .map((match) => decodeCandidateUrl(match[0]))
      .map((href) => href.split('#')[0])
      .filter(isPostHref);
  };

  const articleLinks = Array.from(article.querySelectorAll('a[href]'))
    .filter((anchor) => !nestedArticles.some((nested) => nested.contains(anchor)))
    .filter((anchor) => !isInsidePostMessage(anchor));

  // Priority 0: the post's own timestamp anchor (the "3h" / "Yesterday at
  // 10:00 AM" text under the author name) is the exact link Facebook's own
  // UI uses when you click the timestamp to open a post - it's always
  // present without clicking anything, unlike Share -> Copy link, which
  // depends on share-dialog markup that changes often and is slow/flaky to
  // drive from a content script. Prefer it whenever it resolves to a valid
  // post href.
  const timeLikeText = /^(?:\d+\s*[a-z]{1,3}|yesterday|just now)$/i;
  const timeLikeLabel = /\d{1,2}:\d{2}\s*(am|pm)?/i;
  const weekdayLabel = /^(mon|tue|wed|thu|fri|sat|sun)/i;
  const timestampAnchor = articleLinks.find((anchor) => {
    if (anchor.querySelector('time, abbr') || anchor.matches('time, abbr')) return true;
    const text = cleanText(anchor.innerText || anchor.textContent || '');
    const label = cleanText(anchor.getAttribute('aria-label') || '');
    return timeLikeText.test(text) || timeLikeLabel.test(label) || weekdayLabel.test(label);
  });
  if (timestampAnchor) {
    const timestampHref = getCleanHref(timestampAnchor);
    if (isPostHref(timestampHref)) return { link: timestampHref, linkSource: 'timestamp' };
  }

  const headerLinks = articleLinks.filter(isHeaderAnchor).map(getCleanHref).filter(isPostHref);
  const headerLink = rankLinks(headerLinks);
  if (headerLink) return { link: headerLink, linkSource: 'header' };

  const outerLinks = articleLinks.map((anchor) => (anchor.href || '').split('#')[0]).filter(isPostHref);
  const outerLink = rankLinks(outerLinks);
  if (outerLink) return { link: outerLink, linkSource: 'outer' };

  const markupLink = rankLinks(getMarkupLinks());
  if (markupLink) return { link: markupLink, linkSource: 'markup' };

  const postId = getPostIdFromRoot(article);
  const builtLink = buildPostLink(postId, author, identity);
  if (builtLink) return { link: builtLink, linkSource: 'built' };

  return { link: '', linkSource: 'none' };
}

function hasCommentLinkFn(article) {
  return Array.from(article.querySelectorAll('a[href]')).some((anchor) => isCommentLink(anchor.href || ''));
}

function hasPostMessageFn(article) {
  return Boolean(article.querySelector(POST_MESSAGE_SELECTOR));
}

function isLikelyCommentArticle(article, link) {
  if (isCommentLink(link)) return true;
  if (hasPostMessageFn(article)) return false;
  if (!link) return true;

  const text = ptNormalizeText(article.innerText || article.textContent || '').toLowerCase();
  const hasCommentOnlyControls = text.includes('reply') ||
    text.includes('write a reply') ||
    text.includes('view more replies') ||
    text.includes('top fan') ||
    text.includes('author');
  const hasPostControls = text.includes('share') || /\d+\s+shares?/.test(text) || text.includes('all reactions:');

  return hasCommentOnlyControls && !hasPostControls;
}

function getAuthor(article, identity) {
  const expectedName = normalizeName(identity?.name);
  const expectedSlug = String(identity?.slug || '').toLowerCase();
  const candidateElements = Array.from(article.querySelectorAll([
    "h2 a[href]", "h3 a[href]", "strong a[href]", "span[dir='auto'] a[href]", "a[role='link'][href]"
  ].join(', ')));
  const candidates = [];

  for (const link of candidateElements) {
    if (isHiddenEl(link)) continue;

    const text = ptNormalizeText(link.innerText || link.textContent || '');
    const href = link.href || '';
    const name = normalizeName(text);
    const lowerHref = href.toLowerCase();

    if (!text || text.length > 120) continue;
    if (PERMALINK_PATTERNS.some((pattern) => href.includes(pattern))) continue;
    if (isAuthorNoise(text, link)) continue;

    candidates.push({
      name: text,
      href,
      score: Number(expectedSlug && lowerHref.includes(`/${expectedSlug}`)) * 100 +
        Number(expectedName && name === expectedName) * 80 +
        Number(expectedName && (name.includes(expectedName) || expectedName.includes(name))) * 40 +
        Number(Boolean(link.closest('h2, h3, strong'))) * 10
    });
  }

  candidates.sort((left, right) => right.score - left.score);

  if (candidates.length > 0) {
    return { name: candidates[0].name, href: candidates[0].href };
  }

  const fallback = Array.from(article.querySelectorAll("span[dir='auto'], strong, h2, h3"))
    .map((element) => ptNormalizeText(element.innerText || element.textContent || ''))
    .find((text) => text && text.length <= 120 && !isAuthorNoise(text));

  return { name: fallback || '', href: '' };
}

function getBoundaryTop(article) {
  const candidates = Array.from(article.querySelectorAll("[role='button'], [aria-label], span, div, a"));
  const tops = candidates
    .filter((element) => !isHiddenEl(element))
    .filter((element) => {
      const text = ptNormalizeText(element.innerText || element.textContent || '').toLowerCase();
      const aria = ptNormalizeText(element.getAttribute('aria-label') || '').toLowerCase();
      const isSmall = text.length > 0 && text.length <= 80;

      if (isSmall && (
        text === 'like' || text === 'comment' || text === 'share' ||
        text === 'write a comment' || text === 'most relevant' || text === 'all comments' ||
        text.includes('view more comment') || text.includes('view previous comment')
      )) {
        return true;
      }

      return aria.includes('write a comment') ||
        aria.includes('comment as') ||
        aria.includes('reply') ||
        aria === 'comment' ||
        aria.startsWith('comment ');
    })
    .map((element) => element.getBoundingClientRect().top)
    .filter((top) => top > 0);

  return tops.length ? Math.min(...tops) : null;
}

function getGroupText(article) {
  const nestedArticles = Array.from(article.querySelectorAll("div[role='article']")).filter((nested) => nested !== article);
  const messageContainers = Array.from(article.querySelectorAll(POST_MESSAGE_SELECTOR))
    .filter((container) => !nestedArticles.some((nested) => nested.contains(container)));
  const sourceContainers = messageContainers.length ? messageContainers : [article];
  const boundaryTop = getBoundaryTop(article);
  const lines = [];

  const addLine = (text) => {
    const duplicateIndex = lines.findIndex((line) => line === text || line.includes(text) || text.includes(line));
    if (duplicateIndex >= 0) {
      if (text.length > lines[duplicateIndex].length) lines[duplicateIndex] = text;
      return;
    }
    lines.push(text);
  };

  for (const container of sourceContainers) {
    if (isHiddenEl(container)) continue;
    if (nestedArticles.some((nested) => nested.contains(container))) continue;
    if (boundaryTop && container.getBoundingClientRect().top >= boundaryTop) continue;

    const renderedLines = String(container.innerText || container.textContent || '')
      .split('\n')
      .map(ptNormalizeText)
      .filter(Boolean);

    for (const text of renderedLines) {
      if (text.length < 3) continue;
      if (isUiText(text)) continue;
      addLine(text);
    }
  }

  return lines.join('\n').trim();
}

function getEngagementCounts(article) {
  const nestedArticles = Array.from(article.querySelectorAll("div[role='article']")).filter((nested) => nested !== article);
  const isOwnScope = (element) => !nestedArticles.some((nested) => nested.contains(element));
  const boundaryTop = getBoundaryTop(article);
  const isAboveBoundary = (element) => !boundaryTop || element.getBoundingClientRect().top < boundaryTop;

  const parseCount = (value) => {
    const match = String(value || '').match(/\d[\d.,]*\s*[KkMm]?/);
    return match ? match[0].replace(/\s+/g, '') : '';
  };

  const getCountNear = (roleValue) => {
    const markers = Array.from(article.querySelectorAll(`[data-ad-rendering-role="${roleValue}"]`))
      .filter(isOwnScope)
      .filter((element) => !isHiddenEl(element))
      .filter(isAboveBoundary)
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);

    for (const marker of markers) {
      const iconContainer = marker.parentElement;
      const countContainer = iconContainer?.nextElementSibling;
      const countSpan = countContainer?.querySelector("span[dir='auto']") || countContainer;
      const value = parseCount(countSpan?.innerText || countSpan?.textContent || '');
      if (value) return value;
    }
    return '';
  };

  return {
    reactions: getCountNear('like_button'),
    comments: getCountNear('comment_button'),
    shares: getCountNear('share_button')
  };
}

function isSeeMoreControl(element) {
  const text = ptNormalizeText(element.innerText || element.textContent || '').toLowerCase();
  const label = ptNormalizeText(element.getAttribute('aria-label') || '').toLowerCase();
  const isCompact = text.length > 0 && text.length <= 40;

  return (isCompact && (text === 'see more' || text === '... see more' || text.endsWith(' see more'))) ||
    label === 'see more' ||
    label === 'see more of this post' ||
    label.includes('see more text');
}

function isOriginalTextControl(element) {
  const text = ptNormalizeText(element.innerText || element.textContent || '').toLowerCase();
  const label = ptNormalizeText(element.getAttribute('aria-label') || '').toLowerCase();
  const combined = `${text} ${label}`;

  return combined.includes('see original') ||
    combined.includes('view original') ||
    combined.includes('show original') ||
    combined.includes('original text');
}

async function expandArticleButtons(article, isMatch) {
  for (let round = 0; round < 3; round++) {
    const candidates = Array.from(article.querySelectorAll(
      "div[role='button'], span[role='button'], a[role='link'], [aria-label]"
    )).filter((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).filter((element) => isMatch(element));

    if (candidates.length === 0) break;

    for (const candidate of candidates) candidate.click();
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
}

async function collectPostGroups(pageIdentity) {
  const articles = Array.from(document.querySelectorAll("div[role='article']"));

  const uniqueElements = (elements) => elements.filter((element, index) =>
    elements.findIndex((candidate) => candidate === element) === index
  );

  const postMessageRoots = uniqueElements(
    Array.from(document.querySelectorAll(POST_MESSAGE_SELECTOR))
      .map(getPostRoot)
      .filter(Boolean)
  );
  const outerPostMessageRoots = postMessageRoots.filter((root) =>
    !postMessageRoots.some((other) => other !== root && other.contains(root))
  );
  const fallbackArticleRoots = articles.filter((article) => !article.parentElement?.closest("div[role='article']"));
  const candidateRoots = outerPostMessageRoots.length ? outerPostMessageRoots : fallbackArticleRoots;

  const scrapeRunId = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const groups = await Promise.all(candidateRoots.map(async (article, index) => {
    await expandArticleButtons(article, isSeeMoreControl);
    await expandArticleButtons(article, isOriginalTextControl);

    const text = getGroupText(article);
    const author = getAuthor(article, pageIdentity);
    const { link, linkSource } = getPostLink(article, author, pageIdentity);
    const hasMessage = hasPostMessageFn(article);
    const engagement = getEngagementCounts(article);
    const scrapeIndex = `${scrapeRunId}-${index}`;

    article.setAttribute('data-scrape-index', scrapeIndex);

    return {
      author,
      text,
      link,
      linkSource,
      hasComment: isCommentLink(link) || hasCommentLinkFn(article),
      hasPostMessage: hasMessage,
      isLikelyComment: isLikelyCommentArticle(article, link),
      reactions: engagement.reactions,
      comments: engagement.comments,
      shares: engagement.shares,
      postIdRaw: getPostIdFromRoot(article),
      scrapeIndex,
      element: article
    };
  }));

  const filteredGroups = groups.filter((group) =>
    group.text &&
    !group.isLikelyComment &&
    (group.hasPostMessage || group.link)
  );

  return {
    groups: filteredGroups,
    stats: {
      articleCount: articles.length,
      candidateRoots: candidateRoots.length,
      messageContainers: document.querySelectorAll(POST_MESSAGE_SELECTOR).length
    }
  };
}

// ============================================
// PRE-COLLECTION PASS: reveal translations / expand "See more"
// across the whole viewport before reading text
// ============================================
async function revealOriginalText(maxRounds = 2) {
  for (let round = 0; round < maxRounds; round++) {
    const candidates = Array.from(document.querySelectorAll(
      "div[role='button'], span[role='button'], a[role='link'], [aria-label*='original' i]"
    )).filter((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= window.innerHeight &&
        style.display !== 'none' && style.visibility !== 'hidden';
    }).filter(isOriginalTextControl);

    const uniqueCandidates = candidates.filter((element, index) =>
      candidates.findIndex((candidate) => candidate === element || element.contains(candidate)) === index
    );

    for (const candidate of uniqueCandidates.slice(0, 30)) candidate.click();

    if (uniqueCandidates.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

async function expandSeeMoreButtons(maxRounds = 3) {
  for (let round = 0; round < maxRounds; round++) {
    const candidates = Array.from(document.querySelectorAll(
      "div[role='button'], span[role='button'], [aria-label='See more'], [aria-label='See more of this post']"
    )).filter((element) => {
      const box = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= window.innerHeight &&
        style.display !== 'none' && style.visibility !== 'hidden';
    }).filter((element) => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const label = (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isTinyIconButton = !text && (label === 'more' || label.includes('more options') || label.includes('actions for this post'));
      const isCompactTextControl = text.length > 0 && text.length <= 40;

      if (isTinyIconButton) return false;

      return isCompactTextControl && (text === 'see more' || text === '... see more' || text.endsWith(' see more')) ||
        label === 'see more' ||
        label === 'see more of this post' ||
        label.includes('see more text');
    });

    const uniqueCandidates = candidates.filter((element, index) =>
      candidates.findIndex((candidate) => candidate === element || element.contains(candidate)) === index
    );

    for (const candidate of uniqueCandidates.slice(0, 30)) candidate.click();

    if (uniqueCandidates.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

// ============================================
// DEDUPE / MERGE (across scan passes)
// ============================================
function getPostKey(post) {
  if (post.link) return `link:${stripTracking(post.link)}`;
  return getPostTextKey(post);
}

function getPostTextKey(post) {
  const normalizedText = String(post.text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const normalizedAuthor = normalizeName(post.author?.name || '');

  return normalizedText ? `text:${normalizedAuthor}:${normalizedText}` : '';
}

function mergeSeenPost(seenMap, posts, key, post) {
  if (!seenMap.has(key)) return false;

  const existingPost = posts[seenMap.get(key)];
  let changed = false;

  if (existingPost && !existingPost.link && post.link) {
    existingPost.link = post.link;
    existingPost.linkSource = post.linkSource;
    changed = true;
  }
  if (existingPost && (!existingPost.text || post.text.length > existingPost.text.length)) {
    existingPost.text = post.text;
    changed = true;
  }
  if (existingPost && !existingPost.reactions && post.reactions) {
    existingPost.reactions = post.reactions;
    changed = true;
  }
  if (existingPost && !existingPost.comments && post.comments) {
    existingPost.comments = post.comments;
    changed = true;
  }
  if (existingPost && !existingPost.shares && post.shares) {
    existingPost.shares = post.shares;
    changed = true;
  }

  if (changed) delete existingPost._formatted;

  return true;
}

// ============================================
// TEXT CLEANUP / FORMATTING
// ============================================
function cleanPostText(text) {
  const seen = new Set();

  return String(text || '')
    .split('\n')
    .map((line) => line
      .replace(/\s*(?:â€¦|\.\.\.|…)\s*see more\s*$/i, '')
      .replace(/\s*see less\s*$/i, '')
      .trim())
    .filter(Boolean)
    .filter((line) => !/^(\.\.\.\s*)?see more$/i.test(line))
    .filter((line) => {
      if (seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .join('\n');
}

function removeAuthorLine(text, identity) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  if (pageAuthorMatches({ name: lines[0], href: '' }, identity)) {
    return lines.slice(1).join('\n').trim();
  }

  return lines.join('\n');
}

function formatPost(post, pageIdentity) {
  if (post._formatted) return post._formatted;

  const formatted = buildFormattedPost(post, pageIdentity);
  post._formatted = formatted;
  post.element = null; // release the DOM reference once we've extracted what we need
  return formatted;
}

function buildFormattedPost(post, pageIdentity) {
  const cleanedText = removeAuthorLine(cleanPostText(post.text), pageIdentity);
  const link = stripTracking(post.link || '');
  const postId = extractPostId(link) || post.postIdRaw || '';

  let reactions = parseEngagementNumber(post.reactions || '');
  let comments = parseEngagementNumber(post.comments || '');
  let shares = parseEngagementNumber(post.shares || '');

  let timestamp = '';
  let images = [];

  if (post.element) {
    if (!reactions) reactions = extractEngagementMetric(post.element, post.text, 'reactions');
    if (!comments) comments = extractEngagementMetric(post.element, post.text, 'comments');
    if (!shares) shares = extractEngagementMetric(post.element, post.text, 'shares');
    timestamp = extractTimestamp(post.element);
    images = extractImages(post.element);
  }

  return {
    postId: postId || '',
    url: link || window.location.href,
    text: cleanedText || '',
    combinedText: cleanedText || '',
    timestamp: timestamp || '',
    reactions: reactions || 0,
    comments: comments || 0,
    shares: shares || 0,
    authorName: post.author?.name || '',
    authorUrl: post.author?.href || '',
    pageName: pageIdentity?.name || '',
    pageUrl: window.location.href,
    images: images || [],
    scrapedAt: new Date().toISOString(),
    fullText: (post.text || '').slice(0, 2000),
    linkSource: post.linkSource || 'none'
  };
}

function isFacebookLoggedIn() {
  const url = window.location.href;
  if (/facebook\.com\/(login|recover|checkpoint|privacy_checkup|save-device)/i.test(url)) {
    return false;
  }

  if (document.querySelector('input[name="email"], input#email, input[name="pass"], form[action*="login"]')) {
    return false;
  }

  if (document.querySelector('[aria-label="Account"], [aria-label="Home"], [aria-label="Profile"]')) {
    return true;
  }

  const pageMeta = document.querySelector('meta[property="og:title"], meta[name="description"]');
  if (pageMeta) {
    return true;
  }

  return !/login\.php/i.test(url);
}

// ============================================
// ENGAGEMENT METRIC EXTRACTION (fallback path - used only when the
// primary data-ad-rendering-role lookup in getEngagementCounts() above
// comes up empty for a given post)
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
  const clean = String(text).replace(/[^0-9.,KkMmBb]/g, '');
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
// EXTRACT AUXILIARY DATA (images, timestamp)
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

function extractTimestamp(container) {
  const timeSelectors = [
    'time', 'abbr', '[data-testid="post_timestamp"]',
    '[aria-label*="hour" i]', '[aria-label*="minute" i]', '[aria-label*="day" i]'
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
    /\/videos\/([^/?&]+)/i,
    /\/share\/p\/([^/?&]+)/i,
    /\/share\/v\/([^/?&]+)/i,
    /\/share\/r\/([^/?&]+)/i
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return '';
}

function getPageInfo() {
  const identity = buildPageIdentity();
  return { name: identity.name || 'Unknown Page', url: window.location.href, slug: identity.slug || '' };
}

// ============================================
// WAIT / TEXT UTILITIES
// ============================================
function waitFor(conditionFn, timeoutMs = 8000, intervalMs = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      let result;
      try {
        result = conditionFn();
      } catch (e) {
        result = null;
      }
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function cleanText(text) {
  return (text || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTracking(link) {
  if (!link) return '';

  try {
    const parsed = new URL(link);
    parsed.searchParams.delete('__cft__');
    parsed.searchParams.delete('__tn__');
    return parsed.toString();
  } catch {
    return link;
  }
}

// ============================================
// NAVIGATE TO POST
// ============================================
function navigateToPost(postData) {
  console.log('[FB-SCRAPER] Navigating to post:', postData);

  if (postData.url && postData.url.includes('facebook.com')) {
    if (postData.url.includes('/posts/') ||
        postData.url.includes('/permalink/') ||
        postData.url.includes('story_fbid=') ||
        postData.url.includes('/photos/') ||
        postData.url.includes('/videos/') ||
        postData.url.includes('/share/')) {
      console.log('[FB-SCRAPER] Opening post URL directly:', postData.url);
      window.location.href = postData.url;
      return { success: true, method: 'url', url: postData.url };
    }
    console.log('[FB-SCRAPER] URL is page URL, searching for post...');
  }

  if (postData.text) {
    console.log('[FB-SCRAPER] Searching for post by text...');
    const element = findPostElementByText(postData.text);
    if (element) {
      console.log('[FB-SCRAPER] Found element by text');

      const link = element.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid="], a[href*="/photos/"], a[href*="/videos/"]');
      if (link && link.href) {
        console.log('[FB-SCRAPER] Found post link:', link.href);
        window.location.href = link.href;
        return { success: true, method: 'link', url: link.href };
      }

      const anyLink = element.querySelector('a[href*="facebook.com"]');
      if (anyLink && anyLink.href &&
          !anyLink.href.match(/facebook\.com\/[^\/?]+$/) &&
          !anyLink.href.includes('/profile.php')) {
        console.log('[FB-SCRAPER] Found Facebook link:', anyLink.href);
        window.location.href = anyLink.href;
        return { success: true, method: 'link', url: anyLink.href };
      }

      try {
        console.log('[FB-SCRAPER] Clicking element...');
        element.click();
        return { success: true, method: 'click' };
      } catch (e) {
        console.warn('[FB-SCRAPER] Click failed:', e);
      }
    }
  }

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

function findPostElementByText(text) {
  if (!text) return null;

  const searchText = text.slice(0, 50).replace(/'/g, "\\'").replace(/"/g, '\\"');
  console.log('[FB-SCRAPER] Searching for:', searchText);

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

console.log('[FB-SCRAPER] Ready - Enhanced version (ported post-grouping/author-matching/link-resolution from reference scraper)');