const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const keywordInput = document.getElementById("keyword");
const searchBtn = document.getElementById("searchBtn");
const rescanBtn = document.getElementById("rescanBtn");
const autoScanBtn = document.getElementById("autoScanBtn");
const stopBtn = document.getElementById("stopBtn");

let activePort = null;

function fmt(n) {
  return n.toLocaleString();
}

function renderResults(posts) {
  if (!posts || posts.length === 0) {
    summaryEl.style.display = "none";
    resultsEl.innerHTML =
      '<div class="empty">No matching posts found yet.</div>';
    return;
  }

  const totals = posts.reduce(
    (acc, p) => {
      acc.reactions += p.reactions;
      acc.comments += p.comments;
      acc.shares += p.shares;
      return acc;
    },
    { reactions: 0, comments: 0, shares: 0 }
  );

  document.getElementById("totalPosts").textContent = fmt(posts.length);
  document.getElementById("totalReactions").textContent = fmt(totals.reactions);
  document.getElementById("totalComments").textContent = fmt(totals.comments);
  document.getElementById("totalShares").textContent = fmt(totals.shares);
  summaryEl.style.display = "block";

  resultsEl.innerHTML = posts
    .map(
      (p) => `
      <div class="post-card">
        <div class="snippet">${p.snippet}</div>
        <div class="metrics">
          <span>👍 ${fmt(p.reactions)}</span>
          <span>💬 ${fmt(p.comments)}</span>
          <span>↗️ ${fmt(p.shares)}</span>
        </div>
      </div>`
    )
    .join("");
}

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
    statusEl.textContent =
      "⚠️ Can't reach the page. Refresh the Facebook tab (F5) — this usually happens right after installing/updating the extension — then try again.";
    return;
  }

  statusEl.textContent = "Scanning visible posts...";

  chrome.tabs.sendMessage(
    tab.id,
    { action: "SEARCH_KEYWORD", keyword },
    (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent =
          "Couldn't reach the page. Refresh the Facebook tab and try again.";
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
    statusEl.textContent =
      "⚠️ Can't reach the page. Refresh the Facebook tab (F5) — this usually happens right after installing/updating the extension — then try again.";
    return;
  }

  setScanningUI(true);
  statusEl.textContent = "Starting auto-scan…";

  activePort = chrome.tabs.connect(tab.id, { name: "AUTO_SCAN" });

  activePort.onMessage.addListener((msg) => {
    if (msg.type === "STATUS") {
      statusEl.textContent = msg.message;
    } else if (msg.type === "PROGRESS") {
      statusEl.textContent = `Scanning… loaded ${msg.scanned} posts so far, ${msg.posts.length} match "${keyword}" (pass ${msg.iteration}).`;
      renderResults(msg.posts);
    } else if (msg.type === "DONE") {
      statusEl.textContent = `Done — ${msg.reason} Found ${msg.posts.length} matching post(s) out of ${msg.scanned} scanned.`;
      renderResults(msg.posts);
      setScanningUI(false);
      activePort = null;
    }
  });

  activePort.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      statusEl.textContent =
        "⚠️ Lost connection to the page. Refresh the Facebook tab and try again.";
    }
    activePort = null;
    setScanningUI(false);
  });

  activePort.postMessage({ action: "START", keyword });
}

function stopAutoScan() {
  if (activePort) {
    activePort.postMessage({ action: "STOP" });
  }
  setScanningUI(false);
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
