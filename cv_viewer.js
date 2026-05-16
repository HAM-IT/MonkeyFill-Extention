// cv_viewer.js — Renders the CV HTML with DOM-level sanitization

function sanitizeHTML(html) {
  // Parse into a real DOM tree — far safer than regex
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove all <script> elements
  doc.querySelectorAll('script').forEach(el => el.remove());

  // Remove all event handler attributes (on*)
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
      // Strip javascript: protocol in href/src
      if (['href', 'src'].includes(attr.name) && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });

  return doc.documentElement.outerHTML;
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
    document.body.textContent = "Error: No CV data found. Please try generating your CV again.";
  }
});
