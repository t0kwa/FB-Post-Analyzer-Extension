// popup.js - Shows accumulating posts

const keywordInput = document.getElementById('keyword');
const searchBtn = document.getElementById('searchBtn');
const autoScanBtn = document.getElementById('autoScanBtn');
const stopBtn = document.getElementById('stopBtn');
const clearBtn = document.getElementById('clearBtn');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const statsEl = document.getElementById('stats');
const postCountEl = document.getElementById('postCount');
const scanInfoEl = document.getElementById('scanInfo');

let isScanning = false;
let shouldStop = false;
let allPosts = [];
let totalFound = 0;

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
        No matching posts found yet
        <div class="sub">Scrolling will find more posts...</div>
      </div>
    `;
    return;
  }
  
  postCountEl.textContent = posts.length;
  statsEl.style.display = 'block';
  
  // Show ALL accumulated posts
  resultsEl.innerHTML = posts.map((p, i) => `
    <div class="post" data-url="${p.url || ''}" data-index="${i}">
      <div class="text">${p.snippet || 'No description'}</div>
      <div class="metrics">
        <span>❤️ ${(p.reactions || 0).toLocaleString()}</span>
        <span>💬 ${(p.comments || 0).toLocaleString()}</span>
        <span>↗️ ${(p.shares || 0).toLocaleString()}</span>
      </div>
    </div>
  `).join('');
}

async function doSearch(keyword, isAuto = false) {
  if (!keyword || keyword.trim() === '') {
    setStatus('Please enter a keyword', 'error');
    return;
  }
  
  keyword = keyword.trim();
  
  if (!isAuto) {
    // Reset accumulated posts for new manual search
    totalFound = 0;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ACCUMULATED' });
    } catch (e) {}
    
    setStatus('🔍 Searching for "' + keyword + '"...', 'loading');
    searchBtn.disabled = true;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!tab || !tab.url || !tab.url.includes('facebook.com')) {
      setStatus('⚠️ Please open a Facebook page first', 'error');
      searchBtn.disabled = false;
      return;
    }
    
    // Check if content script is alive
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
    } catch (e) {
      setStatus('⚠️ Please refresh the Facebook page (F5) and try again', 'error');
      searchBtn.disabled = false;
      return;
    }
    
    // Send search with isAuto flag
    const response = await chrome.tabs.sendMessage(tab.id, {
      action: 'SEARCH_KEYWORD',
      keyword: keyword,
      isAutoScan: isAuto
    });
    
    console.log('[FB-KW] Response:', response);
    
    if (response && response.posts) {
      scanInfoEl.textContent = `${response.scanned || 0} scanned • ${response.newPosts || 0} new`;
      renderPosts(response.posts);
      
      if (response.posts.length === 0) {
        setStatus(`No posts found with "${keyword}" yet`, 'info');
      } else {
        const newMsg = response.newPosts > 0 ? ` (+${response.newPosts} new)` : '';
        setStatus(`✅ Found ${response.posts.length} posts${newMsg} with "${keyword}"`, 'success');
      }
    } else if (response && response.error) {
      setStatus('❌ Error: ' + response.error, 'error');
    } else {
      setStatus('❌ No response from page. Try refreshing.', 'error');
    }
  } catch (error) {
    console.error('[FB-KW] Search error:', error);
    setStatus('❌ Error: ' + error.message, 'error');
  }
  
  searchBtn.disabled = false;
}

async function startAutoScan() {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    setStatus('Please enter a keyword first', 'error');
    return;
  }
  
  if (isScanning) {
    setStatus('Already scanning...', 'info');
    return;
  }
  
  // Reset accumulated posts for new auto-scan
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ACCUMULATED' });
  } catch (e) {}
  totalFound = 0;
  
  isScanning = true;
  shouldStop = false;
  autoScanBtn.textContent = '⏳ Scanning...';
  autoScanBtn.disabled = true;
  stopBtn.style.display = 'inline-block';
  searchBtn.disabled = true;
  setStatus(`🔄 Auto-scanning for "${keyword}"...`, 'loading');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let iteration = 0;
  const maxScans = 30;
  let noNewPostsCount = 0;
  
  while (!shouldStop && iteration < maxScans) {
    iteration++;
    
    // Search current view - this will accumulate posts
    await doSearch(keyword, true);
    
    // Check if we found new posts
    if (allPosts.length > totalFound) {
      totalFound = allPosts.length;
      noNewPostsCount = 0;
      setStatus(`Found ${totalFound} posts so far (scan ${iteration})`, 'loading');
    } else {
      noNewPostsCount++;
      if (noNewPostsCount > 3 && iteration > 5) {
        setStatus(`No new posts found in last ${noNewPostsCount} scans. Total: ${totalFound}`, 'info');
      }
    }
    
    // Scroll down
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SCROLL_DOWN' });
    } catch (e) {}
    
    // Wait for content to load
    await new Promise(r => setTimeout(r, 1500));
    
    // Check if at bottom
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      });
      
      if (result && result[0] && result[0].result) {
        if (iteration > 5 && noNewPostsCount > 2) {
          setStatus(`✅ Reached bottom! Found ${totalFound} posts`, 'success');
          break;
        }
      }
    } catch (e) {}
  }
  
  if (shouldStop) {
    setStatus(`⏹ Stopped. Found ${totalFound} posts.`, 'info');
  } else if (iteration >= maxScans) {
    setStatus(`⏱ Max scans reached. Found ${totalFound} posts.`, 'info');
  }
  
  isScanning = false;
  autoScanBtn.textContent = '🔄 Auto-Scan';
  autoScanBtn.disabled = false;
  stopBtn.style.display = 'none';
  searchBtn.disabled = false;
}

function stopScan() {
  shouldStop = true;
  setStatus('⏹ Stopping...', 'info');
}

function clearResults() {
  allPosts = [];
  totalFound = 0;
  statsEl.style.display = 'none';
  resultsEl.innerHTML = `
    <div class="empty">
      <span class="icon">🔍</span>
      No results yet
      <div class="sub">Search for posts with a keyword</div>
    </div>
  `;
  setStatus('🗑 Cleared', 'idle');
  scanInfoEl.textContent = '0 scanned';
  
  // Also clear in content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'CLEAR_ACCUMULATED' });
    }
  });
}

// Click post to open
resultsEl.addEventListener('click', async (e) => {
  const post = e.target.closest('.post');
  if (!post) return;
  
  const url = post.getAttribute('data-url');
  if (!url || url === window.location.href) {
    setStatus('No valid URL for this post', 'error');
    return;
  }
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.update(tab.id, { url });
      setStatus('📄 Opening post...', 'info');
    }
  } catch (error) {
    setStatus('Error opening post', 'error');
  }
});

// Event listeners
searchBtn.addEventListener('click', () => {
  if (isScanning) return;
  doSearch(keywordInput.value);
});

autoScanBtn.addEventListener('click', startAutoScan);
stopBtn.addEventListener('click', stopScan);
clearBtn.addEventListener('click', clearResults);

keywordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (isScanning) return;
    doSearch(keywordInput.value);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  keywordInput.focus();
});

console.log('[FB-KW] Popup ready');