// popup.js - Full Scraper Controller with Login Check, Verification & Export

const keywordInput = document.getElementById('keyword');
const pageUrlInput = document.getElementById('pageUrl');
const searchBtn = document.getElementById('searchBtn');
const gotoPageBtn = document.getElementById('gotoPageBtn');
const autoScrapeBtn = document.getElementById('autoScrapeBtn');
const stopBtn = document.getElementById('stopBtn');
const verifyBtn = document.getElementById('verifyBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const statsEl = document.getElementById('stats');
const postCountEl = document.getElementById('postCount');
const scanInfoEl = document.getElementById('scanInfo');
const pageNameEl = document.getElementById('pageName');
const loginBanner = document.getElementById('loginBanner');
const loginBtn = document.getElementById('loginBtn');
const openWindowBtn = document.getElementById('openWindowBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportExcelBtn = document.getElementById('exportExcelBtn');
const exportTxtBtn = document.getElementById('exportTxtBtn');
const exportUidBtn = document.getElementById('exportUidBtn');

let isScraping = false;
let isVerifying = false;
let shouldStop = false;
let allPosts = [];
const MAX_SCAN_LIMIT = 1000;
const STORAGE_KEY = 'fb_scraper_posts_v1';

// ============================================
// STORAGE (persists across popup close/reopen)
// ============================================
async function savePostsToStorage() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: allPosts });
  } catch (e) {
    console.warn('[FB-SCRAPER] Storage save failed:', e);
  }
}

async function loadPostsFromStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (data && data[STORAGE_KEY] && Array.isArray(data[STORAGE_KEY])) {
      renderPosts(data[STORAGE_KEY]);
    }
  } catch (e) {
    console.warn('[FB-SCRAPER] Storage load failed:', e);
  }
}

// ============================================
// UI HELPERS
// ============================================
function setStatus(message, type = 'idle') {
  statusEl.textContent = message;
  statusEl.className = 'status ' + type;
}

function dedupeByPostId(posts) {
  const map = new Map();
  for (const p of posts) {
    const key = p.postId || p.url;
    if (!key) continue;
    if (!map.has(key)) map.set(key, p);
  }
  return Array.from(map.values());
}

function renderPosts(posts) {
  allPosts = posts;
  savePostsToStorage();

  if (!posts || posts.length === 0) {
    statsEl.style.display = 'none';
    resultsEl.innerHTML = `
      <div class="empty">
                No posts scraped yet
        <div class="sub">Click Scrape to start collecting posts</div>
      </div>
    `;
    return;
  }

  const unique = dedupeByPostId(posts);
  const verifiedCount = unique.filter(p => p.verified).length;

  postCountEl.textContent = posts.length;
  document.getElementById('uidCount').textContent = unique.length;
  document.getElementById('verifiedCount').textContent = verifiedCount;
  statsEl.style.display = 'block';

  resultsEl.innerHTML = unique.map((p, i) => {
    let badge = '<span class="verify-tag pending">not verified</span>';
    if (p.verified === true) {
      badge = p.verifyMatch
        ? '<span class="verify-tag match">Verified match</span>'
        : '<span class="verify-tag mismatch">Mismatch</span>';
    } else if (p.verified === false && p.verifyNote) {
      badge = `<span class="verify-tag mismatch">${escapeHtml(p.verifyNote)}</span>`;
    }
    return `
    <div class="post" data-url="${escapeAttr(p.url || '')}" data-postid="${escapeAttr(p.postId || '')}" data-description="${encodeURIComponent(p.text || '')}" data-index="${i}">
      <div class="top-row">
        <div class="postid">ID: ${escapeHtml(p.postId || 'n/a')}</div>
        ${badge}
      </div>
      <div class="text">${escapeHtml(p.text ? p.text.slice(0, 150) + (p.text.length > 150 ? '...' : '') : 'No text')}</div>
      <div class="metrics">
        <span>Reactions: ${(p.reactions || 0).toLocaleString()}</span>
        <span>Comments: ${(p.comments || 0).toLocaleString()}</span>
        <span>Shares: ${(p.shares || 0).toLocaleString()}</span>
        <span>${escapeHtml(p.timestamp || 'n/a')}</span>
      </div>
    </div>
  `;
  }).join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}

// ============================================
// LOGIN CHECK (Step 1)
// ============================================
async function checkFacebookLogin(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'CHECK_LOGIN' });
    return response && response.loggedIn;
  } catch (e) {
    return null; // content script not present (wrong page / not loaded yet)
  }
}

async function refreshLoginBanner() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      loginBanner.style.display = 'none';
      return;
    }
    const loggedIn = await checkFacebookLogin(tab.id);
    if (loggedIn === false) {
      loginBanner.style.display = 'block';
    } else {
      loginBanner.style.display = 'none';
    }
  } catch (e) {
    loginBanner.style.display = 'none';
  }
}

loginBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/login' });
    setStatus('Log in, then come back and click Go to Page.', 'info');
  }
});

// ============================================
// GET PAGE INFO
// ============================================
async function loadPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      pageNameEl.textContent = 'Not on Facebook';
      loginBanner.style.display = 'none';
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_INFO' });
    if (response && response.name) {
      pageNameEl.textContent = response.name;
    }
    await refreshLoginBanner();
  } catch (e) {
    pageNameEl.textContent = 'Refresh page to load';
  }
}

async function gotoFacebookPage(pageUrl) {
  if (!pageUrl) {
    setStatus('Enter a Facebook page URL first', 'error');
    return false;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setStatus('No active tab found', 'error');
      return false;
    }

    await chrome.tabs.update(tab.id, { url: pageUrl });
    setStatus(`Navigating to page...`, 'loading');
    return true;
  } catch (error) {
    setStatus('Could not open page: ' + (error.message || error), 'error');
    return false;
  }
}

async function ensureLoggedIn(tab) {
  if (!tab || !tab.url) return false;
  if (!tab.url.includes('facebook.com')) {
    setStatus('Must be on Facebook to scan posts', 'error');
    return false;
  }

  const loggedIn = await checkFacebookLogin(tab.id);
  if (loggedIn === false) {
    setStatus('Facebook login required. Click "Log in to Facebook" above.', 'error');
    loginBanner.style.display = 'block';
    return false;
  }

  return true;
}

// ============================================
// SCRAPE FUNCTION (Steps 3-4)
// ============================================
async function doScrape(keyword, isAuto = false) {
  if (!isAuto) {
    setStatus('Scraping posts...', 'loading');
    searchBtn.disabled = true;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      setStatus('Please open a Facebook page first', 'error');
      searchBtn.disabled = false;
      return;
    }

    const loggedIn = await ensureLoggedIn(tab);
    if (!loggedIn) {
      searchBtn.disabled = false;
      return;
    }

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
    } catch (e) {
      setStatus('Please refresh the Facebook page (F5) and try again', 'error');
      searchBtn.disabled = false;
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'SCRAPE_POSTS',
      keyword: keyword,
      isAutoScrape: isAuto
    });

    console.log('[FB-SCRAPER] Response:', response);

    if (response && response.posts) {
      scanInfoEl.textContent = `${response.scanned || 0} scanned • ${response.newPosts || 0} new • ${response.total || 0} total`;
      renderPosts(response.posts);

      if (response.posts.length === 0) {
        setStatus(`No posts found${keyword ? ' with "' + keyword + '"' : ''}`, 'info');
      } else {
        const newMsg = response.newPosts > 0 ? ` (+${response.newPosts} new)` : '';
        const maxMsg = response.maxReached ? ` (Max ${MAX_SCAN_LIMIT} reached)` : '';
        setStatus(`Scraped ${response.posts.length} posts${newMsg}${maxMsg}${keyword ? ' with "' + keyword + '"' : ''}`, 'success');
      }

      if (response.pageName) {
        pageNameEl.textContent = response.pageName;
      }
    } else if (response && response.error) {
      setStatus('Error: ' + response.error, 'error');
    } else {
      setStatus('No response from page. Try refreshing.', 'error');
    }
  } catch (error) {
    console.error('[FB-SCRAPER] Scrape error:', error);
    setStatus('Error: ' + error.message, 'error');
  }

  searchBtn.disabled = false;
}

// ============================================
// VERIFY UNIQUE POSTS (Step 5)
// Opens each unique post's own permalink URL in a background tab,
// re-scrapes it standalone, and compares against the feed-scraped data.
// ============================================
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); resolve(false); }
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        if (!done) { done = true; cleanup(); resolve(true); }
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function normNumbersMatch(a, b) {
  // Engagement counts drift constantly on live posts, so treat "close enough" as a match.
  if (a === 0 && b === 0) return true;
  const diff = Math.abs((a || 0) - (b || 0));
  const base = Math.max(a || 0, b || 0, 1);
  return diff / base < 0.15; // within 15%
}

function textRoughlyMatches(a, b) {
  if (!a || !b) return false;
  const na = a.slice(0, 80).toLowerCase().replace(/\s+/g, ' ').trim();
  const nb = b.slice(0, 80).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function verifyUniquePosts() {
  if (isVerifying) {
    setStatus('Already verifying...', 'info');
    return;
  }
  const unique = dedupeByPostId(allPosts).filter(p => p.url);
  if (unique.length === 0) {
    setStatus('No posts with a URL to verify. Scrape first.', 'error');
    return;
  }

  isVerifying = true;
  shouldStop = false;
  verifyBtn.textContent = 'Verifying...';
  verifyBtn.disabled = true;
  stopBtn.style.display = 'inline-block';

  const originalTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const returnTab = originalTabs[0];

  const byKey = new Map();
  for (const p of allPosts) byKey.set(p.postId || p.url, p);

  let done = 0;
  for (const p of unique) {
    if (shouldStop) break;
    done++;
    setStatus(`Verifying ${done}/${unique.length}: ${p.postId || p.url.slice(0, 40)}`, 'loading');

    let tab;
    try {
      tab = await chrome.tabs.create({ url: p.url, active: false });
      await waitForTabComplete(tab.id, 15000);
      await new Promise(r => setTimeout(r, 2000)); // let dynamic content settle

      const result = await chrome.tabs.sendMessage(tab.id, {
        action: 'SCRAPE_SINGLE_POST',
        expectedPostId: p.postId
      });

      if (result && result.post) {
        const live = result.post;
        const textMatch = textRoughlyMatches(p.text, live.text) || textRoughlyMatches(p.combinedText, live.combinedText);
        const reactMatch = normNumbersMatch(p.reactions, live.reactions);
        const commMatch = normNumbersMatch(p.comments, live.comments);
        const shareMatch = normNumbersMatch(p.shares, live.shares);
        const overallMatch = textMatch && reactMatch && commMatch && shareMatch;

        const key = p.postId || p.url;
        const updated = {
          ...p,
          verified: true,
          verifyMatch: overallMatch,
          verifyNote: overallMatch ? '' : [
            !textMatch ? 'text differs' : null,
            !reactMatch ? 'reactions differ' : null,
            !commMatch ? 'comments differ' : null,
            !shareMatch ? 'shares differ' : null
          ].filter(Boolean).join(', '),
          liveReactions: live.reactions,
          liveComments: live.comments,
          liveShares: live.shares,
          reactions: live.reactions,
          comments: live.comments,
          shares: live.shares
        };
        byKey.set(key, updated);
      } else {
        const key = p.postId || p.url;
        byKey.set(key, { ...p, verified: false, verifyNote: (result && result.error) || 'Could not open/extract post' });
      }
    } catch (e) {
      const key = p.postId || p.url;
      byKey.set(key, { ...p, verified: false, verifyNote: e.message || 'Tab error' });
    } finally {
      if (tab && tab.id) {
        try { await chrome.tabs.remove(tab.id); } catch (e) {}
      }
    }

    renderPosts(Array.from(byKey.values()));
  }

  // Return focus to the original tab
  try {
    if (returnTab && returnTab.id) await chrome.tabs.update(returnTab.id, { active: true });
  } catch (e) {}

  isVerifying = false;
  verifyBtn.textContent = 'Verify Unique Posts';
  verifyBtn.disabled = false;
  if (!isScraping) stopBtn.style.display = 'none';

  const finalUnique = dedupeByPostId(allPosts);
  const verifiedOk = finalUnique.filter(p => p.verified && p.verifyMatch).length;
  const verifiedBad = finalUnique.filter(p => p.verified && !p.verifyMatch).length;
  if (shouldStop) {
    setStatus(`Verification stopped. ${verifiedOk} matched, ${verifiedBad} mismatched.`, 'info');
  } else {
    setStatus(`Verification complete: ${verifiedOk} matched, ${verifiedBad} mismatched out of ${finalUnique.length}.`, verifiedBad > 0 ? 'info' : 'success');
  }
}

// ============================================
// EXPORT FUNCTIONS (Step 7-8)
// Columns: Post ID, Date Posted, Text, Reactions, Comments, Shares (+ extras)
// ============================================
async function exportToText(posts) {
  if (!posts || posts.length === 0) {
    setStatus('No posts to export', 'error');
    return;
  }
  const unique = dedupeByPostId(posts);
  const lines = unique.map(p => `Post ID: ${(p.postId || '')}\nDate Posted: ${(p.timestamp || '')}\nText: ${(p.text || '').replace(/\r?\n/g, ' ')}\nReactions: ${p.reactions || 0} Comments: ${p.comments || 0} Shares: ${p.shares || 0}\nVerified: ${p.verified ? (p.verifyMatch ? 'Yes - match' : 'Yes - mismatch') : 'No'}\nURL: ${(p.url || '')}\n---`);
  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: `facebook_posts_${new Date().toISOString().slice(0,10)}.txt`,
    saveAs: true
  });

  setStatus(`Exported ${unique.length} unique posts to TXT`, 'success');
}

function exportUids(posts) {
  if (!posts || posts.length === 0) {
    setStatus('No posts to export', 'error');
    return;
  }

  const unique = dedupeByPostId(posts);
  const content = unique.map(p => p.postId || p.url).join('\n');
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: `facebook_post_ids_${new Date().toISOString().slice(0,10)}.txt`,
    saveAs: true
  });

  setStatus(`Exported ${unique.length} unique post IDs`, 'success');
}

async function startAutoScrape() {
  const keyword = keywordInput.value.trim();
  const pageUrl = pageUrlInput.value.trim();

  if (isScraping) {
    setStatus('Already scraping...', 'info');
    return;
  }

  const tabQueryResult = await chrome.tabs.query({ active: true, currentWindow: true });
  let [tab] = tabQueryResult;
  if (!tab || !tab.url || !tab.url.includes('facebook.com') || (pageUrl && !tab.url.startsWith(pageUrl))) {
    const navigated = await gotoFacebookPage(pageUrl);
    if (!navigated) {
      return;
    }
    await new Promise(r => setTimeout(r, 3000));
    const updatedTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    [tab] = updatedTabs;
  }

  const loggedIn = await ensureLoggedIn(tab);
  if (!loggedIn) return;

  try {
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ACCUMULATED' });
    }
  } catch (e) {}

  isScraping = true;
  shouldStop = false;
  autoScrapeBtn.textContent = 'Scraping...';
  autoScrapeBtn.disabled = true;
  stopBtn.style.display = 'inline-block';
  searchBtn.disabled = true;
  setStatus(`Auto-scraping${keyword ? ' for "' + keyword + '"' : ''}... (Max ${MAX_SCAN_LIMIT} posts)`, 'loading');

  let iteration = 0;
  const maxScans = 50;
  let noNewPostsCount = 0;
  let prevCount = 0;

  while (!shouldStop && iteration < maxScans && allPosts.length < MAX_SCAN_LIMIT) {
    iteration++;

    await doScrape(keyword, true);

    if (allPosts.length >= MAX_SCAN_LIMIT) {
      setStatus(`Reached maximum of ${MAX_SCAN_LIMIT} posts!`, 'success');
      break;
    }

    if (allPosts.length > prevCount) {
      prevCount = allPosts.length;
      noNewPostsCount = 0;
      setStatus(`Scraped ${prevCount}/${MAX_SCAN_LIMIT} posts so far (pass ${iteration})`, 'loading');
    } else {
      noNewPostsCount++;
      if (noNewPostsCount > 8 && iteration > 8) {
        setStatus(`No new posts. Total: ${prevCount}/${MAX_SCAN_LIMIT} (pass ${iteration})`, 'info');
      }
    }

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SCROLL_DOWN' });
    } catch (e) {}

    await new Promise(r => setTimeout(r, 1500));

    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      });

      if (result && result[0] && result[0].result && noNewPostsCount > 5) {
        setStatus(`Reached bottom! Scraped ${prevCount}/${MAX_SCAN_LIMIT} posts`, 'success');
        break;
      }
    } catch (e) {}
  }

  if (shouldStop) {
    setStatus(`Stopped. Scraped ${prevCount} posts.`, 'info');
  } else if (iteration >= maxScans) {
    setStatus(`Max scans reached. Scraped ${prevCount} posts.`, 'info');
  } else if (allPosts.length >= MAX_SCAN_LIMIT) {
    setStatus(`Successfully scraped ${MAX_SCAN_LIMIT} posts!`, 'success');
  }

  isScraping = false;
  autoScrapeBtn.textContent = 'Auto-Scrape';
  autoScrapeBtn.disabled = false;
  if (!isVerifying) stopBtn.style.display = 'none';
  searchBtn.disabled = false;
}

async function startPageNavigation() {
  const pageUrl = pageUrlInput.value.trim();
  const success = await gotoFacebookPage(pageUrl);
  if (success) {
    setStatus('Page opened. Wait a few seconds then scrape.', 'info');
    setTimeout(refreshLoginBanner, 2000);
  }
}

function stopScrape() {
  shouldStop = true;
  setStatus('Stopping...', 'info');
}

function exportToCSV(posts) {
  if (!posts || posts.length === 0) {
    setStatus('No posts to export', 'error');
    return;
  }
  const unique = dedupeByPostId(posts);

  const headers = [
    'Post ID', 'Date Posted', 'Text', 'Reactions', 'Comments', 'Shares',
    'Verified', 'URL', 'Author Name', 'Page Name', 'Scraped At'
  ];

  const rows = unique.map(p => [
    p.postId || '',
    p.timestamp || '',
    (p.text || '').replace(/,/g, ';').replace(/\n/g, ' '),
    p.reactions || 0,
    p.comments || 0,
    p.shares || 0,
    p.verified ? (p.verifyMatch ? 'Yes - match' : 'Yes - mismatch') : 'No',
    p.url || '',
    p.authorName || '',
    p.pageName || '',
    p.scrapedAt || ''
  ]);

  const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: `facebook_posts_${new Date().toISOString().slice(0,10)}.csv`,
    saveAs: true
  });

  const totalReactions = unique.reduce((sum, p) => sum + (p.reactions || 0), 0);
  setStatus(`Exported ${unique.length} unique posts to CSV (${totalReactions.toLocaleString()} total reactions)`, 'success');
}

function exportToJSON(posts) {
  if (!posts || posts.length === 0) {
    setStatus('No posts to export', 'error');
    return;
  }
  const unique = dedupeByPostId(posts);
  const jsonContent = JSON.stringify(unique, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: `facebook_posts_${new Date().toISOString().slice(0,10)}.json`,
    saveAs: true
  });

  setStatus(`Exported ${unique.length} unique posts to JSON`, 'success');
}

function exportToExcel(posts) {
  if (!posts || posts.length === 0) {
    setStatus('No posts to export', 'error');
    return;
  }
  const unique = dedupeByPostId(posts);

  let html = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:x="urn:schemas-microsoft-com:office:excel"
          xmlns="http://www.w3.org/TR/REC-html40">
    <head><meta charset="UTF-8">
    <!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
    <x:Name>Posts</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
    </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
    <style>
      th { background-color: #1877f2; color: white; font-weight: bold; }
      td { border: 1px solid #ccc; }
    </style>
    </head>
    <body>
    <table border="1">
    <tr>
      <th>Post ID</th><th>Date Posted</th><th>Text</th>
      <th>Reactions</th><th>Comments</th><th>Shares</th>
      <th>Verified</th><th>URL</th><th>Author Name</th><th>Page Name</th><th>Scraped At</th>
    </tr>
  `;

  for (const p of unique) {
    html += `
      <tr>
        <td>${(p.postId || '').replace(/"/g, '""')}</td>
        <td>${(p.timestamp || '').replace(/"/g, '""')}</td>
        <td>${((p.text || '').replace(/,/g, ';').replace(/\n/g, ' ')).replace(/"/g, '""')}</td>
        <td>${p.reactions || 0}</td>
        <td>${p.comments || 0}</td>
        <td>${p.shares || 0}</td>
        <td>${p.verified ? (p.verifyMatch ? 'Yes - match' : 'Yes - mismatch') : 'No'}</td>
        <td>${(p.url || '').replace(/"/g, '""')}</td>
        <td>${(p.authorName || '').replace(/"/g, '""')}</td>
        <td>${(p.pageName || '').replace(/"/g, '""')}</td>
        <td>${(p.scrapedAt || '').replace(/"/g, '""')}</td>
      </tr>
    `;
  }

  html += '</table></body></html>';

  const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  chrome.downloads.download({
    url: url,
    filename: `facebook_posts_${new Date().toISOString().slice(0,10)}.xls`,
    saveAs: true
  });

  const totalReactions = unique.reduce((sum, p) => sum + (p.reactions || 0), 0);
  const totalComments = unique.reduce((sum, p) => sum + (p.comments || 0), 0);
  const totalShares = unique.reduce((sum, p) => sum + (p.shares || 0), 0);
  setStatus(`Exported ${unique.length} unique posts to Excel (Reactions: ${totalReactions.toLocaleString()}, Comments: ${totalComments.toLocaleString()}, Shares: ${totalShares.toLocaleString()})`, 'success');
}

function isSpecificFacebookPostUrl(url) {
  return !!url && /facebook\.com.*(\/posts\/|\/permalink\/|story_fbid=|\/story\.php|\/photos\/|\/videos\/|ft_ent_identifier=|fbid=|[\?&]id=)/i.test(url);
}

// ============================================
// CLICK POST TO NAVIGATE
// ============================================
resultsEl.addEventListener('click', async (e) => {
  const post = e.target.closest('.post');
  if (!post) return;

  const url = post.getAttribute('data-url');
  const postId = post.getAttribute('data-postid') || '';
  const description = decodeURIComponent(post.getAttribute('data-description') || '');

  if (url && url.includes('facebook.com') && isSpecificFacebookPostUrl(url)) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        setStatus('Opening post...', 'info');
        return;
      }
    } catch (error) {
      console.error('[FB-SCRAPER] Navigation error:', error);
    }
  }

  if (url || description || postId) {
    try {
      setStatus('Finding post...', 'loading');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'NAVIGATE_TO_POST',
        postData: { url, text: description, postId }
      });

      if (response && response.success) {
        setStatus('Opening post...', 'info');
      } else {
        setStatus('Could not find post. Try refreshing.', 'error');
      }
    } catch (error) {
      setStatus('Error: ' + error.message, 'error');
    }
  } else {
    setStatus('No valid URL for this post', 'error');
  }
});

// ============================================
// CLEAR RESULTS
// ============================================
function clearResults() {
  allPosts = [];
  savePostsToStorage();
  statsEl.style.display = 'none';
  resultsEl.innerHTML = `
    <div class="empty">
            No posts scraped yet
      <div class="sub">Click Scrape to start collecting posts</div>
    </div>
  `;
  setStatus('Cleared', 'idle');
  scanInfoEl.textContent = '0 scanned';

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'CLEAR_ACCUMULATED' });
    }
  });
}

// ============================================
// DETACH INTO SEPARATE WINDOW
// (Chrome closes action popups on focus loss, which kills any in-flight
// scrape/verify loop. A normal extension window persists instead.)
// ============================================
openWindowBtn.addEventListener('click', () => {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 520,
    height: 720
  });
});

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (!isScraping) {
      doScrape(keywordInput.value.trim());
    }
  }
  if (e.key === 'Escape' && (isScraping || isVerifying)) {
    stopScrape();
  }
});

// ============================================
// EVENT LISTENERS
// ============================================
searchBtn.addEventListener('click', () => {
  if (isScraping) return;
  doScrape(keywordInput.value.trim());
});

autoScrapeBtn.addEventListener('click', startAutoScrape);
verifyBtn.addEventListener('click', verifyUniquePosts);
stopBtn.addEventListener('click', stopScrape);
clearBtn.addEventListener('click', clearResults);

exportCsvBtn.addEventListener('click', () => exportToCSV(allPosts));
exportJsonBtn.addEventListener('click', () => exportToJSON(allPosts));
exportExcelBtn.addEventListener('click', () => exportToExcel(allPosts));
exportTxtBtn.addEventListener('click', () => exportToText(allPosts));
exportUidBtn.addEventListener('click', () => exportUids(allPosts));
gotoPageBtn.addEventListener('click', startPageNavigation);

keywordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (isScraping) return;
    doScrape(keywordInput.value.trim());
  }
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  keywordInput.focus();
  loadPostsFromStorage();
  loadPageInfo();
  setInterval(loadPageInfo, 5000);
});

console.log('[FB-SCRAPER] Popup ready - login check, scrape, verify, export');