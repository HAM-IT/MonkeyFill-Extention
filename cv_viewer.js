// cv_viewer.js — Renders the CV HTML with sanitization

function sanitizeHTML(html) {
  // Strip <script> tags and their contents
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Strip event handler attributes (onclick, onerror, onload, etc.)
  html = html.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Strip javascript: protocol in href/src attributes
  html = html.replace(/(?:href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return html;
}

chrome.storage.local.get(['cvHTML'], (result) => {
  if (result.cvHTML) {
    const sanitized = sanitizeHTML(result.cvHTML);
    document.open();
    document.write(sanitized);
    document.close();
    
    setTimeout(() => {
      const btn = document.getElementById('download-pdf-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          window.print();
        });
      }
    }, 100);
  } else {
    document.body.innerHTML = "<h1>Error: No CV data found.</h1><p>Please try generating your CV again.</p>";
  }
});
