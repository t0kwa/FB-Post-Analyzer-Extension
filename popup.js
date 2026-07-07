// popup.js - With click navigation

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
        <div class="sub">Try a different keyword or scroll down</div>
      </div>
    `;
    return;
  }
  
  postCountEl.textContent = posts.length;
  statsEl.style.display = 'block';
  
  resultsEl.innerHTML = posts.map((p, i) => `
    <div class="post" data-url="${p.url || ''}" data-text="${encodeURIComponent(p.text || '')}" data-index="${i}">
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
    
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'PING' });
    } catch (e) {
      setStatus('⚠️ Please refresh the Facebook page (F5) and try again', 'error');
      searchBtn.disabled = false;
      return;
    }
    
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
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.tabs.sendMessage(tab.id, { action: 'CLEAR_ACCUMULATED' });
  } catch (e) {}
  
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
  let prevCount = 0;
  
  while (!shouldStop && iteration < maxScans) {
    iteration++;
    
    await doSearch(keyword, true);
    
    if (allPosts.length > prevCount) {
      prevCount = allPosts.length;
      noNewPostsCount = 0;
      setStatus(`Found ${prevCount} posts so far (scan ${iteration})`, 'loading');
    } else {
      noNewPostsCount++;
      if (noNewPostsCount > 5 && iteration > 5) {
        setStatus(`No new posts. Total: ${prevCount} (scan ${iteration})`, 'info');
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
      
      if (result && result[0] && result[0].result && noNewPostsCount > 3) {
        setStatus(`✅ Reached bottom! Found ${prevCount} posts`, 'success');
        break;
      }
    } catch (e) {}
  }
  
  if (shouldStop) {
    setStatus(`⏹ Stopped. Found ${prevCount} posts.`, 'info');
  } else if (iteration >= maxScans) {
    setStatus(`⏱ Max scans reached. Found ${prevCount} posts.`, 'info');
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
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: 'CLEAR_ACCUMULATED' });
    }
  });
}

// Click post to open - UPDATED
resultsEl.addEventListener('click', async (e) => {
  const post = e.target.closest('.post');
  if (!post) return;
  
  const url = post.getAttribute('data-url');
  const text = decodeURIComponent(post.getAttribute('data-text') || '');
  
  console.log('[FB-KW] Clicked post:', { url, text: text.slice(0, 100) });
  
  // If we have a URL that's not the current page, use it
  if (url && url !== window.location.href && url.includes('/posts/')) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        await chrome.tabs.update(tab.id, { url });
        setStatus('📄 Opening post...', 'info');
        return;
      }
    } catch (error) {
      console.error('[FB-KW] Navigation error:', error);
    }
  }
  
  // If URL didn't work, try to navigate using the content script
  if (text) {
    try {
      setStatus('🔍 Finding post...', 'loading');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      const response = await chrome.tabs.sendMessage(tab.id, {
        action: 'NAVIGATE_TO_POST',
        postData: { text: text }
      });
      
      if (response && response.success) {
        setStatus('📄 Navigating to post...', 'info');
        if (response.url && response.url !== window.location.href) {
          await chrome.tabs.update(tab.id, { url: response.url });
        }
      } else {
        setStatus('❌ Could not find post. Try refreshing the page.', 'error');
      }
    } catch (error) {
      console.error('[FB-KW] Navigation error:', error);
      setStatus('❌ Error: ' + error.message, 'error');
    }
  } else {
    setStatus('❌ No valid URL for this post', 'error');
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