// popup.js
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const keywordInput = document.getElementById("keyword");
const searchBtn = document.getElementById("searchBtn");
const rescanBtn = document.getElementById("rescanBtn");
const autoScanBtn = document.getElementById("autoScanBtn");
const stopBtn = document.getElementById("stopBtn");

let activePort = null;
let allFoundPosts = [];

function fmt(n) {
  return n.toLocaleString();
}

function renderResults(posts) {
  if (!posts || posts.length === 0) {
    summaryEl.style.display = "none";
    resultsEl.innerHTML = '<div class="empty">No matching posts found yet.</div>';
    return;
  }
  
  document.getElementById('totalPosts').textContent = posts.length;
  summaryEl.style.display = "block";
  
  resultsEl.innerHTML = posts
    .map(
      (p) => `
        <div class="post-card" data-url="${p.url || ''}">
          <div class="snippet">${p.snippet || 'No description available'}</div>
          <div class="metrics">
            <span>❤️ ${fmt(p.reactions || 0)}</span>
            <span>💬 ${fmt(p.comments || 0)}</span>
            <span>↗️ ${fmt(p.shares || 0)}</span>
          </div>
        </div>
      `
    )
    .join("");
}

// Handle clicks on a post card and navigate to the matching Facebook post.
resultsEl.addEventListener("click", async (e) => {
  const card = e.target.closest(".post-card");
  if (!card) return;
  
  const url = card.getAttribute("data-url");
  resultsEl.querySelectorAll('.post-card.selected').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  
  if (url && url !== window.location.href) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.update(tab.id, { url });
        statusEl.textContent = "Opening post in the current tab...";
        return;
      }
      chrome.tabs.create({ url });
      statusEl.textContent = "Opening post in a new tab...";
      return;
    } catch (error) {
      statusEl.textContent = "Error opening post: " + error.message;
    }
  } else {
    statusEl.textContent = "No direct post link found for this item.";
  }
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Confirms the content script is actually alive in the tab before we try to
// use it. Fixes the confusing "Could not establish connection" case, which
// usually means the tab was open before the extension was (re)loaded and
// needs a refresh.
function pingContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "PING" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

function setScanningUI(isScanning) {
  autoScanBtn.style.display = isScanning ? "none" : "inline-block";
  stopBtn.style.display = isScanning ? "inline-block" : "none";
  searchBtn.disabled = isScanning;
  rescanBtn.disabled = isScanning;
  if (isScanning) {
    statusEl.textContent = "Auto-scanning... Scroll in progress";
  }
}

// --- Quick (one-shot) scan of whatever is currently loaded ---------------
async function runQuickScan(keyword) {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("facebook.com")) {
    statusEl.textContent = "Please open a Facebook page tab first.";
    return;
  }
  
  statusEl.textContent = "Checking connection to the page...";
  const alive = await pingContentScript(tab.id);
  if (!alive) {
    statusEl.textContent = "⚠️ Can't reach the page. Refresh the Facebook tab (F5) — this usually happens right after installing/updating the extension — then try again.";
    return;
  }
  
  statusEl.textContent = "Scanning visible posts...";
  chrome.tabs.sendMessage(
    tab.id,
    { action: "SEARCH_KEYWORD", keyword },
    (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Couldn't reach the page. Refresh the Facebook tab and try again.";
        return;
      }
      if (!response) {
        statusEl.textContent = "No response from page.";
        return;
      }
      statusEl.textContent = `Found ${response.posts.length} post(s) matching "${keyword}" (scanned ${response.scanned} loaded posts).`;
      renderResults(response.posts);
    }
  );
}

// --- Auto-scan: scrolls the page and collects matches live ---------------
async function startAutoScan(keyword) {
  const tab = await getActiveTab();
  if (!tab || !tab.url || !tab.url.includes("facebook.com")) {
    statusEl.textContent = "Please open a Facebook page tab first.";
    return;
  }
  
  statusEl.textContent = "Checking connection to the page...";
  const alive = await pingContentScript(tab.id);
  if (!alive) {
    statusEl.textContent = "⚠️ Can't reach the page. Refresh the Facebook tab (F5) — this usually happens right after installing/updating the extension — then try again.";
    return;
  }
  
  setScanningUI(true);
  allFoundPosts = [];
  statusEl.textContent = "Starting auto-scan…";
  
  activePort = chrome.tabs.connect(tab.id, { name: "AUTO_SCAN" });
  
  activePort.onMessage.addListener((msg) => {
    console.debug("Popup received message:", msg);
    
    if (msg.type === "STATUS") {
      statusEl.textContent = msg.message;
    } else if (msg.type === "PROGRESS") {
      allFoundPosts = msg.posts || [];
      statusEl.textContent = `Scanning… loaded ${msg.scanned || 0} posts so far, ${allFoundPosts.length} match "${keyword}" (pass ${msg.iteration || 0})`;
      renderResults(allFoundPosts);
    } else if (msg.type === "DONE") {
      statusEl.textContent = `Done — ${msg.reason} Found ${msg.posts.length} matching post(s) out of ${msg.scanned || 0} scanned.`;
      allFoundPosts = msg.posts || [];
      renderResults(allFoundPosts);
      setScanningUI(false);
      activePort = null;
    }
  });
  
  activePort.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "⚠️ Lost connection to the page. Refresh the Facebook tab and try again.";
    } else {
      statusEl.textContent = "Auto-scan stopped.";
    }
    activePort = null;
    setScanningUI(false);
  });
  
  try {
    activePort.postMessage({ action: "START", keyword });
  } catch (error) {
    statusEl.textContent = "Error starting auto-scan: " + error.message;
    setScanningUI(false);
    activePort = null;
  }
}

function stopAutoScan() {
  if (activePort) {
    try {
      activePort.postMessage({ action: "STOP" });
    } catch (e) {
      console.debug("Error stopping auto-scan:", e);
    }
  }
  setScanningUI(false);
  statusEl.textContent = "Auto-scan stopped by user.";
  activePort = null;
}

// --- Wire up buttons -------------------------------------------------------
searchBtn.addEventListener("click", () => {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    statusEl.textContent = "Type a keyword first.";
    return;
  }
  runQuickScan(keyword);
});

rescanBtn.addEventListener("click", () => {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    statusEl.textContent = "Type a keyword first, then scan.";
    return;
  }
  runQuickScan(keyword);
});

autoScanBtn.addEventListener("click", () => {
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    statusEl.textContent = "Type a keyword first, then auto-scan.";
    return;
  }
  startAutoScan(keyword);
});

stopBtn.addEventListener("click", stopAutoScan);

keywordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchBtn.click();
});

// Auto-run search if keyword is already entered when popup opens
document.addEventListener("DOMContentLoaded", () => {
  const keyword = keywordInput.value.trim();
  if (keyword) {
    runQuickScan(keyword);
  }
});