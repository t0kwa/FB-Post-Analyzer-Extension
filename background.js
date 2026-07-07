// background.js - Simplified service worker

console.log('[FB-SCRAPER] Background script loaded');

// Listen for extension installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('[FB-SCRAPER] Extension installed successfully');
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'GET_TAB_ID') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        sendResponse({ tabId: tabs[0].id });
      } else {
        sendResponse({ error: 'No active tab found' });
      }
    });
    return true;
  }
  
  if (request.action === 'GET_EXTENSION_INFO') {
    sendResponse({ 
      version: '3.0',
      name: 'Facebook Post Scraper Pro',
      maxPosts: 1000
    });
    return true;
  }
});

console.log('[FB-SCRAPER] Background script ready');