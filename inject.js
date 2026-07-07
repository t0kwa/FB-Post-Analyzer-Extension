// inject.js - Handle blocked Facebook requests

(function() {
  console.log('[FB-SCRAPER] Injection script loaded');
  
  // Override fetch
  const origFetch = window.fetch;
  window.fetch = function(url, options) {
    if (url && typeof url === 'string' && url.includes('facebook.com/ajax/')) {
      console.log('[FB-SCRAPER] Intercepted fetch:', url);
      return Promise.resolve(new Response(JSON.stringify({
        success: false,
        error: 'Request intercepted by extension',
        data: null
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' }
      }));
    }
    return origFetch.call(this, url, options);
  };
  
  // Override XMLHttpRequest
  const origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    const xhr = new origXHR();
    const origSend = xhr.send;
    const origOpen = xhr.open;
    
    xhr.open = function(method, url, ...args) {
      this._url = url;
      this._method = method;
      return origOpen.call(this, method, url, ...args);
    };
    
    xhr.send = function(body) {
      if (this._url && typeof this._url === 'string' && this._url.includes('facebook.com/ajax/')) {
        console.log('[FB-SCRAPER] Intercepted XHR:', this._url);
        setTimeout(() => {
          try {
            if (this.onreadystatechange) {
              this.readyState = 4;
              this.status = 200;
              this.statusText = 'OK';
              this.responseText = JSON.stringify({
                success: false,
                error: 'Request intercepted by extension',
                data: null
              });
              this.onreadystatechange();
            }
            if (this.onload) {
              this.onload();
            }
          } catch (e) {
            console.warn('[FB-SCRAPER] XHR mock error:', e);
          }
        }, 50);
        return;
      }
      return origSend.call(this, body);
    };
    
    return xhr;
  };
  
  // Override navigator.sendBeacon
  const origSendBeacon = navigator.sendBeacon;
  navigator.sendBeacon = function(url, data) {
    if (url && typeof url === 'string' && url.includes('facebook.com/ajax/')) {
      console.log('[FB-SCRAPER] Intercepted sendBeacon:', url);
      return true;
    }
    return origSendBeacon.call(this, url, data);
  };
  
  console.log('[FB-SCRAPER] Injection complete - All Facebook ajax requests intercepted');
})();