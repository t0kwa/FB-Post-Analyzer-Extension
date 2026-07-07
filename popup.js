// popup.js - Full Scraper Controller with Export (1000 posts limit)

const keywordInput = document.getElementById('keyword');
const searchBtn = document.getElementById('searchBtn');
const autoScrapeBtn = document.getElementById('autoScrapeBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const statsEl = document.getElementById('stats');
const postCountEl = document.getElementById('postCount');
const scanInfoEl = document.getElementById('scanInfo');
const pageNameEl = document.getElementById('pageName');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const exportJsonBtn = document.getElementById('exportJsonBtn');
const exportExcelBtn = document.getElementById('exportExcelBtn');

let isScraping = false;
let shouldStop = false;
let allPosts = [];
const MAX_SCAN_LIMIT = 1000;

// ============================================
// UI HELPERS
// ============================================
function setStatus(message, type = 'idle') {
  statusEl.textContent = message;
  statusEl.className = 'status ' + type;
}

function renderPosts(posts) {
  allPosts = posts;
  
  if (!posts || posts.length === 0) {
    statsEl.style.display = 'none';
    resultsEl.innerHTML = `
      <div class="empty">
        <span class="icon">🔍</span>
        No posts scraped yet
        <div class="sub">Click Scrape to start collecting posts</div>
      </div>
    `;
    return;
  }
  
  postCountEl.textContent = posts.length;
  statsEl.style.display = 'block';
  
  resultsEl.innerHTML = posts.map((p, i) => `
    <div class="post" data-url="${p.url || ''}" data-postid="${p.postId || ''}" data-description="${encodeURIComponent(p.text || '')}" data-index="${i}">
      <div class="text">${p.text ? p.text.slice(0, 150) + (p.text.length > 150 ? '...' : '') : 'No text'}</div>
      <div class="metrics">
        <span>❤️ ${(p.reactions || 0).toLocaleString()}</span>
        <span>💬 ${(p.comments || 0).toLocaleString()}</span>
        <span>↗️ ${(p.shares || 0).toLocaleString()}</span>
        <span>📅 ${p.timestamp ? p.timestamp.slice(0, 10) : ''}</span>
      </div>
    </div>
  `).join('');
}

// ============================================
// GET PAGE INFO
// ============================================
async function loadPageInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      pageNameEl.textContent = 'Not on Facebook';
      return;
    }
    
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_PAGE_INFO' });
    if (response && response.name) {
      pageNameEl.textContent = response.name;
    }
  } catch (e) {
    pageNameEl.textContent = 'Refresh page to load';
  }
}

// ============================================
// SCRAPE FUNCTION
// ============================================
async function doScrape(keyword, isAuto = false) {
  if (!isAuto) {
    setStatus('🔍 Scraping posts...', 'loading');
    searchBtn.disabled = true;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      setStatus('⚠️ Please open a Facebook page first', 'error');
      searchBtn.disabled = false;
      return;
    }
    
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
    } catch (e) {
      setStatus('⚠️ Please refresh the Facebook page (F5) and try again', 'error');
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
        setStatus(`✅ Scraped ${response.posts.length} posts${newMsg}${maxMsg}${keyword ? ' with "' + keyword + '"' : ''}`, 'success');
      }
      
      // Update page name
      if (response.pageName) {
        pageNameEl.textContent = response.pageName;
      }
    } else if (response && response.error) {
      setStatus('❌ Error: ' + response.error, 'error');
    } else {
      setStatus('❌ No response from page. Try refreshing.', 'error');
    }
  } catch (error) {
    console.error('[FB-SCRAPER] Scrape error:', error);
    setStatus('❌ Error: ' + error.message, 'error');
  }
  
  searchBtn.disabled = false;
}

// ============================================
// AUTO SCRAPE - SCAN UP TO 1000 POSTS
// ============================================
async function startAutoScrape() {
  const keyword = keywordInput.value.trim();
  
  if (isScraping) {
    setStatus('Already scraping...', 'info');
    return;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ACCUMULATED' });
  } catch (e) {}
  
  isScraping = true;
  shouldStop = false;
  autoScrapeBtn.textContent = '⏳ Scraping...';
  autoScrapeBtn.disabled = true;
  stopBtn.style.display = 'inline-block';
  searchBtn.disabled = true;
  setStatus(`🔄 Auto-scraping${keyword ? ' for "' + keyword + '"' : ''}... (Max ${MAX_SCAN_LIMIT} posts)`, 'loading');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let iteration = 0;
  const maxScans = 50; // More scans to reach 1000 posts
  let noNewPostsCount = 0;
  let prevCount = 0;
  let totalScanned = 0;
  
  while (!shouldStop && iteration < maxScans && allPosts.length < MAX_SCAN_LIMIT) {
    iteration++;
    
    await doScrape(keyword, true);
    
    // Update total scanned
    if (allPosts.length > 0) {
      totalScanned = allPosts.length;
    }
    
    // Check if we reached the limit
    if (allPosts.length >= MAX_SCAN_LIMIT) {
      setStatus(`✅ Reached maximum of ${MAX_SCAN_LIMIT} posts!`, 'success');
      break;
    }
    
    // Check if we got new posts
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
    
    // Check if at bottom of page
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      });
      
      if (result && result[0] && result[0].result && noNewPostsCount > 5) {
        setStatus(`✅ Reached bottom! Scraped ${prevCount}/${MAX_SCAN_LIMIT} posts`, 'success');
        break;
      }
    } catch (e) {}
  }
  
  // Final status messages
  if (shouldStop) {
    setStatus(`⏹ Stopped. Scraped ${prevCount} posts.`, 'info');
  } else if (iteration >= maxScans) {
    setStatus(`⏱ Max scans reached. Scraped ${prevCount} posts.`, 'info');
  } else if (allPosts.length >= MAX_SCAN_LIMIT) {
    setStatus(`✅ Successfully scraped ${MAX_SCAN_LIMIT} posts!`, 'success');
  }
  
  isScraping = false;
  autoScrapeBtn.textContent = '🔄 Auto-Scrape';
  autoScrapeBtn.disabled = false;
  stopBtn.style.display = 'none';
  searchBtn.disabled = false;
}

function stopScrape() {
  shouldStop = true;
  setStatus('⏹ Stopping...', 'info');
}

// ============================================
// EXPORT FUNCTIONS
// ============================================
function exportToCSV(posts) {
  if (!posts || posts.length === 0) {
    setStatus('⚠️ No posts to export', 'error');
    return;
  }
  
  const headers = [
    'Post ID', 'URL', 'Text', 'Timestamp', 
    'Reactions', 'Comments', 'Shares',
    'Author Name', 'Author URL', 'Page Name', 'Page URL',
    'Images', 'Scraped At'
  ];
  
  const rows = posts.map(p => [
    p.postId || '',
    p.url || '',
    (p.text || '').replace(/,/g, ';').replace(/\n/g, ' '),
    p.timestamp || '',
    p.reactions || 0,
    p.comments || 0,
    p.shares || 0,
    p.authorName || '',
    p.authorUrl || '',
    p.pageName || '',
    p.pageUrl || '',
    (p.images || []).join(' | '),
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
  
  const totalReactions = posts.reduce((sum, p) => sum + (p.reactions || 0), 0);
  setStatus(`📄 Exported ${posts.length} posts to CSV (❤️ ${totalReactions.toLocaleString()} total reactions)`, 'success');
}

function exportToJSON(posts) {
  if (!posts || posts.length === 0) {
    setStatus('⚠️ No posts to export', 'error');
    return;
  }
  
  const jsonContent = JSON.stringify(posts, null, 2);
  const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  chrome.downloads.download({
    url: url,
    filename: `facebook_posts_${new Date().toISOString().slice(0,10)}.json`,
    saveAs: true
  });
  
  setStatus(`📋 Exported ${posts.length} posts to JSON`, 'success');
}

function exportToExcel(posts) {
  if (!posts || posts.length === 0) {
    setStatus('⚠️ No posts to export', 'error');
    return;
  }
  
  // Create an HTML table for Excel
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
      <th>Post ID</th><th>URL</th><th>Text</th><th>Timestamp</th>
      <th>Reactions</th><th>Comments</th><th>Shares</th>
      <th>Author Name</th><th>Author URL</th><th>Page Name</th><th>Page URL</th>
      <th>Images</th><th>Scraped At</th>
    </tr>
  `;
  
  for (const p of posts) {
    html += `
      <tr>
        <td>${(p.postId || '').replace(/"/g, '""')}</td>
        <td>${(p.url || '').replace(/"/g, '""')}</td>
        <td>${((p.text || '').replace(/,/g, ';').replace(/\n/g, ' ')).replace(/"/g, '""')}</td>
        <td>${(p.timestamp || '').replace(/"/g, '""')}</td>
        <td>${p.reactions || 0}</td>
        <td>${p.comments || 0}</td>
        <td>${p.shares || 0}</td>
        <td>${(p.authorName || '').replace(/"/g, '""')}</td>
        <td>${(p.authorUrl || '').replace(/"/g, '""')}</td>
        <td>${(p.pageName || '').replace(/"/g, '""')}</td>
        <td>${(p.pageUrl || '').replace(/"/g, '""')}</td>
        <td>${((p.images || []).join(' | ')).replace(/"/g, '""')}</td>
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
  
  const totalReactions = posts.reduce((sum, p) => sum + (p.reactions || 0), 0);
  const totalComments = posts.reduce((sum, p) => sum + (p.comments || 0), 0);
  const totalShares = posts.reduce((sum, p) => sum + (p.shares || 0), 0);
  setStatus(`📊 Exported ${posts.length} posts to Excel (❤️${totalReactions.toLocaleString()} 💬${totalComments.toLocaleString()} ↗️${totalShares.toLocaleString()})`, 'success');
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
        setStatus('📄 Opening post...', 'info');
        return;
      }
    } catch (error) {
      console.error('[FB-SCRAPER] Navigation error:', error);
    }
  }
  
  if (url || description || postId) {
    try {
      setStatus('🔍 Finding post...', 'loading');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'NAVIGATE_TO_POST',
        postData: { url, text: description, postId }
      });
      
      if (response && response.success) {
        setStatus('📄 Opening post...', 'info');
      } else {
        setStatus('❌ Could not find post. Try refreshing.', 'error');
      }
    } catch (error) {
      setStatus('❌ Error: ' + error.message, 'error');
    }
  } else {
    setStatus('❌ No valid URL for this post', 'error');
  }
});

// ============================================
// CLEAR RESULTS
// ============================================
function clearResults() {
  allPosts = [];
  statsEl.style.display = 'none';
  resultsEl.innerHTML = `
    <div class="empty">
      <span class="icon">🔍</span>
      No posts scraped yet
      <div class="sub">Click Scrape to start collecting posts</div>
    </div>
  `;
  setStatus('🗑 Cleared', 'idle');
  scanInfoEl.textContent = '0 scanned';
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'CLEAR_ACCUMULATED' });
    }
  });
}

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
  if (e.key === 'Escape' && isScraping) {
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
stopBtn.addEventListener('click', stopScrape);
clearBtn.addEventListener('click', clearResults);

exportCsvBtn.addEventListener('click', () => exportToCSV(allPosts));
exportJsonBtn.addEventListener('click', () => exportToJSON(allPosts));
exportExcelBtn.addEventListener('click', () => exportToExcel(allPosts));

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
  loadPageInfo();
  setInterval(loadPageInfo, 5000);
});

console.log('[FB-SCRAPER] Popup ready - Scanning up to 1000 posts');