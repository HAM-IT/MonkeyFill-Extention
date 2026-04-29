// popup.js — MonkeyFill by HABOMIC
// ALL AI via Groq — fast, free-tier, no quota surprises.

const BACKEND_URL = "https://monkeyfill-backend.omarabouelouafa303.workers.dev"; // Your secure Cloudflare Backend
const EXTENSION_VERSION = chrome.runtime.getManifest().version; // Auto-synced with manifest.json
const GROQ_READ_MODEL = "llama-3.1-8b-instant";    // Reader — tiny, fast, cheap
const GROQ_WRITE_MODEL= "llama-3.3-70b-versatile";  // Writer — smart 70B

function getStorage(keys) {
  return new Promise(resolve => {
    chrome.storage.sync.get(["coachCredits", "lastResetDate", "isPremium", "userId", "premiumKey"], (syncRes) => {
      chrome.storage.local.get(keys, (localRes) => {
        resolve({ ...localRes, ...syncRes });
      });
    });
  });
}

// ─── Backend Fetch Helper ──────────────────────────────────────────────────────
async function executeBackendCall(url, requestBody, retry = true) {
  const store = await getStorage(["userId", "premiumKey", "isDevMode", "devCode"]);
  let userId = store.userId;
  if (!userId) {
    userId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
    chrome.storage.sync.set({ userId });
  }

  const headers = { 
    "Content-Type": "application/json",
    "X-User-Id": userId
  };
  if (store.premiumKey) headers["X-Premium-Key"] = store.premiumKey;
  if (store.isDevMode && store.devCode) headers["X-Dev-Code"] = store.devCode;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody)
  });

  if (res.status === 429 && retry) {
    await new Promise(r => setTimeout(r, 1500)); // wait 1.5s then retry
    return executeBackendCall(url, requestBody, false);
  }
  
  const data = await res.json();
  
  if (res.status === 403 && data.limitExceeded) {
     // If dev mode is on locally, the backend shouldn't have blocked us.
     // Force-retry with deductCredit=false as a safety net.
     if (store.isDevMode && retry) {
       requestBody.deductCredit = false;
       return executeBackendCall(url, requestBody, false);
     }
     throw new Error("LIMIT_EXCEEDED");
  }
  if (!res.ok) { 
    throw new Error("Backend Error: " + (data.error || res.status)); 
  }
  
  // Update credits UI globally if element exists
  const creditCountEl = document.getElementById("credit-count");
  if (creditCountEl && data.creditsRemaining !== undefined) {
     creditCountEl.textContent = data.creditsRemaining;
     // Don't overwrite stored credits when in dev/premium mode (∞)
     if (data.creditsRemaining !== '∞') {
       chrome.storage.sync.set({ coachCredits: data.creditsRemaining });
     }
     if (data.creditsRemaining === '∞') creditCountEl.style.color = "#eab308";
  }
  
  return data;
}

// ─── Backend Reader: requests parsed JSON ────────────────────────────────────────
async function callGroq(systemPrompt, userContent, temperature = 0.1, deductCredit = true) {
  const data = await executeBackendCall(BACKEND_URL, {
      model: GROQ_READ_MODEL,
      systemPrompt, userContent, temperature, responseFormat: "json_object",
      deductCredit
  });
  return JSON.parse(data.text);
}

// ─── Backend Writer: requests raw string ─────────────────────────────────────────
async function callGroqWriter(systemPrompt, userContent, temperature = 0.35, deductCredit = true) {
  const data = await executeBackendCall(BACKEND_URL, {
      model: GROQ_WRITE_MODEL,
      systemPrompt, userContent, temperature,
      deductCredit
  });
  return data.text.replace(/```json/g, "").replace(/```/g, "").trim();
}

// ─── Safe JSON parse ──────────────────────────────────────────────────────────
function safeParseJson(raw) {
  try { return JSON.parse(raw); } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("AI returned unparseable response.");
  }
}

// ─── ATS Weighted Scoring Rubric ─────────────────────────────────────────────
const ATS_SCORING_RUBRIC = `
Calculate match_probability using this rubric (total 100):
  A) Required Skills Match      (40pts) = (matched_required / total_required) × 40
  B) Experience / Seniority Fit (20pts) = exact match=20, one level off=10, two+=0
  C) Job Title Relevance        (15pts) = same/similar=15, related=8, unrelated=0
  D) Preferred Skills Match     (10pts) = (matched_preferred / total_preferred) × 10
  E) Education Fit              (10pts) = match=10, partial=5, none=0
  F) Location / Remote          (5pts)  = match or remote=5, flexible=3, mismatch=0
Sum A+B+C+D+E+F. Never fabricate. Compute internally, output only the integer.
`;

function mdToHtml(text) {
  if (!text) return "";
  return text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
}

// ─── Version Gate ─────────────────────────────────────────────────────────────
function parseVersion(v) {
  return (v || "0").split(".").map(Number);
}
function isVersionOutdated(installed, required) {
  const a = parseVersion(installed);
  const b = parseVersion(required);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] || 0, bi = b[i] || 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

async function checkForUpdates() {
  try {
    const res = await fetch(BACKEND_URL, { method: "GET", cache: "no-store" });
    if (!res.ok) return; // silently skip if backend unreachable
    const data = await res.json();
    const requiredVersion = data.required_version;
    const updateUrl = data.update_url || "https://www.linkedin.com/company/habomic";
    if (requiredVersion && isVersionOutdated(EXTENSION_VERSION, requiredVersion)) {
      showUpdateBanner(EXTENSION_VERSION, requiredVersion, updateUrl);
    }
  } catch (_) {
    // Network error — silently ignore, don't break the extension
  }
}

function showUpdateBanner(currentVersion, requiredVersion, updateUrl) {
  // Don't show twice
  if (document.getElementById("mf-update-banner")) return;

  const banner = document.createElement("div");
  banner.id = "mf-update-banner";
  banner.innerHTML = `
    <div id="mf-update-overlay"></div>
    <div id="mf-update-modal">
      <div id="mf-update-emoji">🐒</div>
      <h2 id="mf-update-title">Update Required</h2>
      <p id="mf-update-subtitle">
        You're on <strong>v${currentVersion}</strong> — version <strong>v${requiredVersion}</strong> is now live.<br><br>
        This version is no longer supported. Follow the steps below to get the new one.
      </p>
      <div id="mf-update-steps">
        <div class="mf-step">
          <div class="mf-step-num">1</div>
          <div class="mf-step-text">Open Chrome and go to <strong>chrome://extensions</strong></div>
        </div>
        <div class="mf-step">
          <div class="mf-step-num">2</div>
          <div class="mf-step-text">Find <strong>MonkeyFill (by HABOMIC)</strong> and click <strong>Remove</strong></div>
        </div>
        <div class="mf-step">
          <div class="mf-step-num">3</div>
          <div class="mf-step-text">Go to HABOMIC's website or LinkedIn to download the new version, then load it unpacked</div>
        </div>
      </div>
      <a id="mf-update-cta" href="${updateUrl}" target="_blank">
        🚀 Go to HABOMIC — Get New Version
      </a>
      <p id="mf-update-footer">MonkeyFill is locked until you update.</p>
    </div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    #mf-update-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.82);
      backdrop-filter: blur(5px);
      z-index: 9998;
      pointer-events: all;
    }
    #mf-update-modal {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 9999;
      background: #1a1a2e;
      border: 1px solid rgba(239,68,68,0.45);
      border-radius: 16px;
      padding: 24px 20px;
      width: 284px;
      text-align: center;
      font-family: 'Inter', sans-serif;
      box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(239,68,68,0.15);
      animation: mf-pop-in 0.28s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes mf-pop-in {
      from { transform: translate(-50%,-50%) scale(0.82); opacity:0; }
      to   { transform: translate(-50%,-50%) scale(1);    opacity:1; }
    }
    #mf-update-emoji { font-size: 38px; margin-bottom: 8px; }
    #mf-update-title {
      font-size: 16px; font-weight: 700;
      color: #fca5a5; margin: 0 0 10px;
      letter-spacing: -0.3px;
    }
    #mf-update-subtitle {
      font-size: 11.5px; color: #94a3b8;
      line-height: 1.65; margin: 0 0 14px;
    }
    #mf-update-subtitle strong { color: #c4b5fd; }
    #mf-update-steps {
      background: rgba(255,255,255,0.04);
      border-radius: 10px;
      padding: 10px;
      margin-bottom: 14px;
      text-align: left;
    }
    .mf-step {
      display: flex; align-items: flex-start;
      gap: 10px; margin-bottom: 8px;
    }
    .mf-step:last-child { margin-bottom: 0; }
    .mf-step-num {
      background: #ef4444; color: #fff;
      font-weight: 700; font-size: 10px;
      width: 18px; height: 18px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 1px;
    }
    .mf-step-text { font-size: 11px; color: #cbd5e1; line-height: 1.5; }
    .mf-step-text strong { color: #e2e8f0; }
    #mf-update-cta {
      display: block;
      background: linear-gradient(135deg, #7c3aed, #5b21b6);
      color: #fff; text-decoration: none;
      padding: 11px 16px; border-radius: 8px;
      font-size: 12px; font-weight: 600;
      margin-bottom: 10px; transition: opacity 0.2s;
    }
    #mf-update-cta:hover { opacity: 0.85; }
    #mf-update-footer { font-size: 10px; color: #475569; margin: 0; }
  `;

  document.head.appendChild(style);
  document.body.appendChild(banner);

  // Hard block: swallow all clicks and keypresses so nothing below works
  banner.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => {
    if (document.getElementById("mf-update-banner")) e.stopImmediatePropagation();
  }, true);
}


// ─── PDF Generator — clean, human-looking, no AI traces ─────────────────────
async function openCVAsPDF(cv, jobSummary, userProfile) {
  const store = await new Promise(resolve => chrome.storage.local.get(["cvTheme", "cvLayout"], resolve));
  const themeId = store.cvTheme || "basic";
  const layoutId = store.cvLayout || "modern_sidebar";
  
  const THEMES = {
    basic: { text: "#1c1c1e", bg: "#fff", accent: "#5C2D91", borderMain: "#ede9fe", borderSide: "#f3f4f6" },
    modern_trust: { text: "#1A3263", bg: "#F2EAE0", accent: "#547792", borderMain: "#d1dee8", borderSide: "#e2dacf" },
    sustainable_growth: { text: "#285A48", bg: "#B0E4CC", accent: "#408A71", borderMain: "#94d1b5", borderSide: "#9fdbbd" },
    sophisticated_creative: { text: "#575757", bg: "#F3E4C9", accent: "#A98B76", borderMain: "#e6d6b8", borderSide: "#eadbcc" },
    energetic_startup: { text: "#AE2448", bg: "#D5E7B5", accent: "#72BAA9", borderMain: "#c5dab1", borderSide: "#cbe0b6" }
  };
  const t = THEMES[themeId] || THEMES.basic;

  const p = userProfile?.personal || {};
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || "Candidate";
  const tagline = cv.tagline || "";

  // Skills
  const skillGroups = (cv.skills_relevant || []);
  const skillsHtml = skillGroups.map(s => `<span class="sk">${s}</span>`).join("");

  // Experience — rendered in AI's relevance order from experience_merged
  const profileExpMap = {};
  (userProfile?.experience || []).forEach(e => {
    profileExpMap[`${e.job_title}|${e.company_name}`] = e;
  });

  const expHtmlCombined = (cv.experience_merged || []).map(merged => {
    const profile = profileExpMap[merged.role_key];
    const bullets = merged.bullets || (profile?.key_achievements) || [];
    if (profile) {
      const start = profile.start_date || "";
      const end = profile.end_date || "Present";
      return `<div class="exp-block">
        <div class="exp-row">
          <div>
            <span class="exp-title">${profile.job_title || ""}</span>
            <span class="exp-company"> · ${profile.company_name || ""}${profile.location ? " · " + profile.location : ""}</span>
          </div>
          <span class="exp-date">${start}${start ? " – " : ""}${end}</span>
        </div>
        ${bullets.map(b => `<div class="exp-bullet">&#x25B8;&nbsp;${mdToHtml(b)}</div>`).join("")}
      </div>`;
    } else {
      const parts = merged.role_key.split("|");
      return `<div class="exp-block">
        <div class="exp-row">
          <div>
            <span class="exp-title">${parts[0] || "Consultant"}</span>
            <span class="exp-company"> · ${parts[1] || "Project"} · Remote</span>
          </div>
          <span class="exp-date">Parallel Target</span>
        </div>
        ${bullets.map(b => `<div class="exp-bullet">&#x25B8;&nbsp;${mdToHtml(b)}</div>`).join("")}
      </div>`;
    }
  }).join("");



  const edu = (userProfile?.education || []).map(e =>
    `<div class="exp-block">
      <div class="exp-row">
        <div>
          <span class="exp-title">${[e.degree, e.field_of_study].filter(Boolean).join(" in ") || ""}</span>
          <span class="exp-company"> · ${e.institution_name || ""}</span>
        </div>
      </div>
    </div>`
  ).join("");

  const langs = (userProfile?.languages || []).join("  ·  ");

  // Reusable Blocks
  const skillsBlock = skillsHtml ? `<div class="sec"><div class="sec-title">Key Proficiencies</div><div class="sk-wrap">${skillsHtml}</div></div>` : "";
  const eduBlock = edu ? `<div class="sec"><div class="sec-title">Education</div>${edu}</div>` : "";
  const langsBlock = langs ? `<div class="sec"><div class="sec-title">Languages</div><p class="lang-text">${langs}</p></div>` : "";
  const summaryBlock = cv.summary ? `<div class="sec"><div class="sec-title">Executive Summary</div><p class="summary">${cv.summary}</p></div>` : "";
  const expBlock = expHtmlCombined ? `<div class="sec"><div class="sec-title">Professional Experience</div>${expHtmlCombined}</div>` : "";

  const hdBlock = `
    <div class="hd">
      <div class="hd-name">${name}</div>
      ${tagline ? `<div class="hd-role">${tagline}</div>` : ""}
      <div class="hd-contacts">
        ${p.email ? `<span>${p.email}</span>` : ""}
        ${p.phone ? `<span>${p.phone}</span>` : ""}
        ${p.city ? `<span>${p.city}${p.country ? ", " + p.country : ""}</span>` : ""}
        ${p.linkedin_url ? `<span>${p.linkedin_url}</span>` : ""}
      </div>
    </div>`;

  let layoutCss = ``;
  let pageContentHtml = ``;

  if (layoutId === 'classic_executive') {
    layoutCss = `
      .hd { text-align: center; border-bottom: 2px solid ${t.text}; padding-bottom: 20px; margin-bottom: 24px; }
      .hd-contacts { justify-content: center; }
      .sk-wrap { display: flex; flex-direction: row; flex-wrap: wrap; gap: 8px 14px; }
      .sk { border: 1px solid ${t.borderMain}; border-radius: 4px; padding: 3px 8px; font-weight: 500; font-size: 8pt; background: #ffffff55; }
      .main-stack { display: flex; flex-direction: column; gap: 6px; }
    `;
    pageContentHtml = `
      ${hdBlock}
      <div class="main-stack">
        ${summaryBlock}
        ${expBlock}
        ${eduBlock}
        ${skillsBlock}
        ${langsBlock}
      </div>
    `;
  } else if (layoutId === 'bold_split') {
    layoutCss = `
      .hd { border-bottom: none; margin-bottom: 28px; }
      .hd-name { font-size: 26pt; color: ${t.accent}; letter-spacing: -1px; margin-bottom: 6px;}
      .hd-role { font-size: 11pt; margin-bottom: 12px; opacity: 0.9;}
      .body-grid { display: grid; grid-template-columns: 1fr 210px; gap: 0 45px; align-items: start; }
      .sidebar { border-left: 2px solid ${t.borderSide}; padding-left: 25px; }
    `;
    pageContentHtml = `
      ${hdBlock}
      <div class="body-grid">
        <div class="main">
          ${summaryBlock}
          ${expBlock}
        </div>
        <div class="sidebar">
          ${skillsBlock}
          ${eduBlock}
          ${langsBlock}
        </div>
      </div>
    `;
  } else {
    // modern_sidebar
    layoutCss = `
      .hd { border-bottom: 2px solid ${t.text}; padding-bottom: 14px; margin-bottom: 20px; }
      .body-grid { display: grid; grid-template-columns: 190px 1fr; gap: 0 32px; align-items: start; }
      .sidebar { border-right: 1px solid ${t.borderSide}; padding-right: 20px; }
    `;
    pageContentHtml = `
      ${hdBlock}
      <div class="body-grid">
        <div class="sidebar">
          ${skillsBlock}
          ${eduBlock}
          ${langsBlock}
        </div>
        <div class="main">
           ${summaryBlock}
           ${expBlock}
        </div>
      </div>
    `;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',sans-serif;color:${t.text};background:${t.bg};font-size:9.5pt;line-height:1.6;}
  .page{max-width:760px;margin:0 auto;padding:36px 44px 40px;}

  /* Base Typography */
  .hd-name{font-size:22pt;font-weight:700;letter-spacing:-0.5px;color:${t.text};line-height:1.1;}
  .hd-role{font-size:10.5pt;font-weight:500;color:${t.accent};margin:4px 0 10px;}
  .hd-contacts{display:flex;flex-wrap:wrap;gap:0 18px;font-size:8.5pt;color:${t.text};opacity:0.8;}
  .hd-contacts span{white-space:nowrap;}

  /* ── Sections ── */
  .sec{margin-bottom:20px;}
  .sec-title{
    font-size:7.5pt;font-weight:700;text-transform:uppercase;
    letter-spacing:0.12em;color:${t.accent};
    margin-bottom:10px;padding-bottom:3px;
    border-bottom:1px solid ${t.borderMain};
  }

  .summary{font-size:9.5pt;color:${t.text};opacity:0.9;line-height:1.65;}
  
  .sk-wrap{display:flex;flex-direction:column;gap:5px;}
  .sk{font-size:8.5pt;color:${t.text};padding:1px 0;}

  /* ── Experience ── */
  .exp-block{margin-bottom:16px;}
  .exp-row{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:2px;margin-bottom:5px;}
  .exp-title{font-size:9.5pt;font-weight:700;color:${t.text};}
  .exp-company{font-size:9pt;color:${t.text};opacity:0.8;font-weight:500;}
  .exp-date{font-size:8pt;color:${t.text};opacity:0.7;white-space:nowrap;font-weight:500;}
  .exp-bullet{font-size:9pt;color:${t.text};opacity:0.9;padding-left:14px;margin-top:3px;line-height:1.55;}
  .exp-bullet strong{color:${t.text};opacity:1;font-weight:700;}

  .lang-text{font-size:8.5pt;color:${t.text};opacity:0.85;line-height:1.7;}

  /* Layout Specific Injected CSS */
  ${layoutCss}

  @page{size:A4;margin:0}
  @media print{
    body{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
    .page{padding:24px 32px;max-width:100%;}
  }
</style>
</head>
<body>
<div class="page">
  ${pageContentHtml}
</div>
<div class="print-overlay">
  <button id="download-pdf-btn">Download PDF</button>
</div>
<style>
  .print-overlay { position: fixed; bottom: 20px; right: 20px; z-index: 1000; }
  .print-overlay button { background: #5C2D91; color: white; border: none; padding: 12px 20px; border-radius: 30px; font-weight: 600; cursor: pointer; font-size: 14px; box-shadow: 0 4px 15px rgba(92,45,145,0.4); transition: all 0.2s; font-family: 'Inter', sans-serif; display: flex; align-items: center; gap: 8px; }
  .print-overlay button::before { content: "📄"; }
  .print-overlay button:hover { background: #4a2475; transform: translateY(-2px); }
  @media print { .print-overlay { display: none !important; } }
</style>
</body></html>`;

  chrome.storage.local.set({ cvHTML: html }, () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("cv_viewer.html") });
  });
}

// ─── Toast Notifications ─────────────────────────────────────────────────────
function showToast(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  const icon = type === "error" ? "⚠️" : type === "success" ? "✅" : "🔔";
  toast.textContent = `${icon} ${message}`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  // ── Version gate: check silently in background ─────────────────────────────
  checkForUpdates();

  const btnCoach = document.getElementById("coach-btn");
  const btnPasteToggle = document.getElementById("paste-toggle-btn");
  const btnAnalyzePaste = document.getElementById("analyze-paste-btn");
  const btnCvPaste = document.getElementById("cv-paste-btn");
  const pasteArea = document.getElementById("paste-area");
  const pasteChevron = document.getElementById("paste-chevron");
  const jobPasteInput = document.getElementById("job-paste-input");
  const companyInput = document.getElementById("company-name");
  const creditCountEl = document.getElementById("credit-count");
  const resultsBox = document.getElementById("coach-results");
  const paywallBox = document.getElementById("paywall");
  const btnUpgrade = document.getElementById("upgrade-btn");
  const optionsLink = document.getElementById("options-link");
  const proCvBtn = document.getElementById("pro-cv-btn");
  const btnLangEn = document.getElementById("lang-en");
  const btnLangFr = document.getElementById("lang-fr");

  let activeLanguage = "English";
  let isUserPremium = false;

  // ── Restore saved state on open ───────────────────────────────────────────
  chrome.storage.sync.get(["coachCredits", "lastResetDate", "isPremium"], (syncData) => {
    chrome.storage.local.get(
      ["userProfile", "savedJobText", "savedCompany", "savedResults", "isDevMode", "cvLanguage"],
      (r) => {
        // Merge them so we can use r transparently
        r = { ...r, ...syncData };

        // Language restore
        activeLanguage = r.cvLanguage || "English";
        updateLangUI(activeLanguage);

        // Dev Mode restore
        if (r.isDevMode) proCvBtn.classList.remove("hidden");

        isUserPremium = r.isPremium || r.isDevMode || false;
        creditCountEl.textContent = isUserPremium ? "∞" : (r.coachCredits ?? 5);
        if (isUserPremium) creditCountEl.style.color = "#eab308";

        // Show empty state if no profile
        if (!r.userProfile) {
          const mainChildren = document.querySelector('main').children;
          Array.from(mainChildren).forEach(el => {
            if (el.id !== 'empty-state' && !el.classList.contains('tagline')) {
              el.classList.add('hidden');
            }
          });
          document.getElementById('empty-state').classList.remove('hidden');
          document.getElementById('empty-state-btn').addEventListener('click', () => chrome.runtime.openOptionsPage());
          return; // Skip filling the rest
        }

      // Restore job text & company
      if (r.savedJobText) {
        jobPasteInput.value = r.savedJobText;
        // Auto-open the paste area so they see their text
        pasteArea.classList.remove("hidden");
        pasteChevron.classList.add("open");
      }
      if (r.savedCompany) companyInput.value = r.savedCompany;

      // Restore last results HTML
      if (r.savedResults) {
        resultsBox.innerHTML = r.savedResults.html;
        resultsBox.classList.remove("hidden");
        // Re-attach PDF button listener if it exists in restored HTML
        const btn = document.getElementById("dl-pdf-btn");
        if (btn && r.savedResults.cvData) {
          btn.addEventListener("click", () =>
            openCVAsPDF(r.savedResults.cvData, r.savedResults.jobSummary, r.userProfile)
          );
        }
      }
    });
  });

  // Auto-save job text as user types (debounced 600ms)
  let saveDebounce;
  jobPasteInput.addEventListener("input", () => {
    clearTimeout(saveDebounce);
    saveDebounce = setTimeout(() =>
      chrome.storage.local.set({ savedJobText: jobPasteInput.value }), 600);
  });
  companyInput.addEventListener("input", () => {
    chrome.storage.local.set({ savedCompany: companyInput.value });
  });

  optionsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

  function updateLangUI(lang) {
    btnLangEn.classList.toggle("active", lang === "English");
    btnLangFr.classList.toggle("active", lang === "French");
  }

  btnLangEn.addEventListener("click", () => {
    activeLanguage = "English";
    updateLangUI(activeLanguage);
    chrome.storage.local.set({ cvLanguage: activeLanguage });
  });

  btnLangFr.addEventListener("click", () => {
    activeLanguage = "French";
    updateLangUI(activeLanguage);
    chrome.storage.local.set({ cvLanguage: activeLanguage });
  });



  proCvBtn.addEventListener("click", () => {
    const jobText = jobPasteInput.value.trim();
    if (!jobText) { showToast("Paste a job offer first!", "error"); return; }
    runTailoredProCV(jobText, proCvBtn, "🚀 Tailored PRO");
  });

  btnUpgrade.addEventListener("click", () => window.open("https://habomic.com", "_blank"));

  // ── Paste area toggle ──────────────────────────────────────────────────────
  btnPasteToggle.addEventListener("click", () => {
    const closed = pasteArea.classList.toggle("hidden");
    pasteChevron.classList.toggle("open", !closed);
  });

  // ── Analyze pasted offer ───────────────────────────────────────────────────
  btnAnalyzePaste.addEventListener("click", () => {
    const text = jobPasteInput.value.trim();
    if (!text) { showToast("Please paste the job description first.", "error"); return; }
    runAnalysis(text, btnAnalyzePaste, "🧠 Analyze (1 Credit)");
  });

  // ── Generate tailored CV ───────────────────────────────────────────────────
  btnCvPaste.addEventListener("click", () => {
    const text = jobPasteInput.value.trim();
    if (!text) { showToast("Please paste the job description first.", "error"); return; }
    runTailoredCV(text, btnCvPaste, "📄 Tailored CV");
  });

  // ── Analyze current page ───────────────────────────────────────────────────
  btnCoach.addEventListener("click", () => {
    chrome.storage.local.get(["coachCredits", "userProfile"], (r) => {
      if (!r.userProfile) { showToast("Upload your CV in Options first!", "error"); return; }

      btnCoach.textContent = "Reading Page...";
      btnCoach.disabled = true;
      hideResults();

      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (!tabs[0]) { resetBtn(btnCoach, "🧠 Analyze Current Page (1 Credit)"); return; }
        try {
          const injected = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id, allFrames: false },
            func: () => {
              const containers = [
                document.querySelector('main'), document.querySelector('[role="main"]'),
                document.getElementById('job-description'), document.querySelector('.job-description'),
                document.querySelector('.description'), document.querySelector('.posting'),
                document.querySelector('[class*="job"]'), document.querySelector('[class*="position"]')
              ];
              for (const c of containers) {
                if (c && c.innerText.length > 300) return c.innerText.substring(0, 12000);
              }
              let t = "";
              document.querySelectorAll('p,li,h1,h2,h3').forEach(el => t += el.innerText + "\n");
              return t.substring(0, 12000);
            }
          });
          const rawText = injected[0]?.result || "";
          if (!rawText || rawText.length < 80) {
            showToast("Couldn't read the page. Try the Paste option instead.", "error");
            resetBtn(btnCoach, "🧠 Analyze Current Page (1 Credit)"); return;
          }
          // Also save this page text so if the user wants Tailored CV they can use it
          chrome.storage.local.set({ savedJobText: rawText });
          jobPasteInput.value = rawText;
          await runAnalysis(rawText, btnCoach, "🧠 Analyze Current Page (1 Credit)");
        } catch (err) {
          console.error(err);
          showToast("Failed: " + err.message, "error");
          resetBtn(btnCoach, "🧠 Analyze Current Page (1 Credit)");
        }
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // SHARED ANALYSIS ENGINE
  // ────────────────────────────────────────────────────────────────────────────
  async function runAnalysis(rawJobText, triggerBtn, resetLabel) {
    const store = await getStorage(["coachCredits", "userProfile", "isPremium"]);
    if (!store.userProfile) { showToast("Upload your CV first!", "error"); return; }

    triggerBtn.disabled = true;
    hideResults();

    try {
      // STEP 1 — Reader: parse job requirements
      triggerBtn.textContent = "Reading Job...";
      const jobSummary = await callGroq(
        `ATS job parser. Extract structured requirements. Return JSON:
{"job_title":"","years_of_experience_required":null,"required_skills":[],"preferred_skills":[],"seniority_level":"junior|mid|senior|lead|executive","responsibilities":[],"education_required":"","location":"","is_remote":false}`,
        rawJobText.substring(0, 6000),
        0.1, true
      );

      // STEP 2 — Reader: research company if name given
      const companyName = companyInput.value.trim();
      let companyContext = null;
      if (companyName) {
        triggerBtn.textContent = "Researching Company...";
        companyContext = await callGroq(
          `Company intelligence assistant. Infer from name what this company is and return ONLY valid JSON:
{"size":"startup|sme|large|enterprise","industry":"","culture_keywords":[],"hiring_style":"formal|casual|technical","what_they_value":[],"tone_for_application":"formal|conversational|technical"}
Make reasonable inferences. No markdown.`,
          `Company: ${companyName}. Role: ${jobSummary.job_title || "unknown"}.`,
          0.1, false
        );
      }

      // STEP 3 — Writer (smart 70B): match analysis + wildcard + growth roadmap
      triggerBtn.textContent = "Analyzing Match...";
      const analysisRaw = await callGroqWriter(
        `You are a brutally honest career coach. Your goal is to identify exactly why this candidate might fail to land the job.

${ATS_SCORING_RUBRIC}

Output ONLY valid JSON, no markdown:
{
  "match_probability": <integer using higher-weight rubric — ${ATS_SCORING_RUBRIC}>,
  "matched_skills": "comma-separated skills candidate has that the job requires",
  "missing_skills": "Only the HIGH-STAKES gaps that actually prevent a hire. Focus on: Years of experience in the specific industry, seniority-level gaps (eg. 'Management experience'), critical domain knowledge (eg. 'Automotive supply chain'), or non-negotiable tech. Skip minor tool gaps.",
  "advice": "One precise actionable sentence. Name the specific core gap and how to bridge it professionally. Be direct.",
  "growth_roadmap": {
    "skills_to_learn": ["Target only the non-negotiable skills missing from the candidate's core profile. 3-4 items."],
    "projects_to_build": ["Concrete project idea that proves capability in the missing HIGH-STAKES domain. 2-3 items."],
    "experiences_to_seek": ["The specific type of professional exposure needed to close the gap. Eg: 'Gain experience in a fast-paced SME' or 'Manage a small cross-functional team'. 2 items."],
    "certifications": ["Only high-value certs that hiring managers in this specific industry genuinely respect."]
  },
  "wildcard": "ONE creative, low-cost stand-out move. NOT a video. Think: a free deliverable the hiring team would actually use (mini process audit, competitor gap analysis, a public repo solving their known problem). Make it hyper-specific to this role and company."
}`,
        `CV: ${JSON.stringify(store.userProfile)}\nJob: ${JSON.stringify(jobSummary)}${companyContext ? `\nCompany: ${JSON.stringify(companyContext)}` : ""}`,
        0.45, false
      );

      const analysis = safeParseJson(analysisRaw);

      const html = renderResults(analysis, jobSummary, companyContext);
      // Persist results HTML (no cvData for analysis — only for CV)
      chrome.storage.local.set({ savedResults: { html, jobSummary } });
      resetBtn(triggerBtn, resetLabel);

    } catch (err) {
      console.error(err);
      if (err.message === "LIMIT_EXCEEDED") {
        showPaywall();
      } else {
        showToast("Analysis failed: " + err.message, "error");
      }
      resetBtn(triggerBtn, resetLabel);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TAILORED CV ENGINE
  // ────────────────────────────────────────────────────────────────────────────
  async function runTailoredCV(rawJobText, triggerBtn, resetLabel) {
    const store = await getStorage(["coachCredits", "userProfile", "isPremium", "isDevMode"]);
    if (!store.userProfile) { showToast("Upload your CV first!", "error"); return; }

    triggerBtn.disabled = true;
    hideResults();

    try {
      // STEP 1 — Reader: extract job keywords
      triggerBtn.textContent = "Reading Job...";
      const jobSummary = await callGroq(
        `ATS job analyzer. Return JSON:
{"job_title":"","primary_focus":"leadership|technical|domain|hybrid","must_have_keywords":[],"nice_to_have_keywords":[],"action_verbs":[],"key_responsibilities":["top 3-5"],"seniority":"junior|mid|senior|lead"}`,
        rawJobText.substring(0, 6000),
        0.1, true
      );

      const companyName = companyInput.value.trim();

      // STEP 2 — Writer: intelligent context-aware tailoring
      triggerBtn.textContent = activeLanguage === "French" ? "Votre CV en Fran\u00e7ais..." : "Building Your CV...";
      const cvRaw = await callGroqWriter(
        `Senior CV strategist. Output language: ${activeLanguage}. Output ONLY valid JSON.

STEP 1 \u2014 JOB FOCUS ANALYSIS (internal, do not output):
Read the job requirements. Identify the PRIMARY FOCUS the employer cares about most. Examples:
- Leadership/management role \u2192 emphasize team sizes, mentoring, decision-making, cross-functional coordination
- Technical specialist \u2192 emphasize tools, methodologies, technical depth, certifications
- Domain expert (electrical, supply chain, etc.) \u2192 emphasize domain-specific projects, vocabulary, outcomes
- Hybrid \u2192 blend proportionally

STEP 2 \u2014 SMART EXPERIENCE REFRAMING:
CRITICAL: You MUST include EVERY experience from the candidate's CV. Do NOT skip any role.
- Highly relevant roles: 2-3 detailed bullets ANGLED toward the job's primary focus
- Less relevant roles: 1-2 shorter bullets highlighting any transferable value (soft skills, general achievements, industry exposure)
Example: "Led a team of 4 electrical engineers on power distribution redesign"
- If job = leadership: "Led and mentored a cross-functional team of 4 engineers, coordinating deliverables across departments"
- If job = electrical: "Designed and delivered power distribution system overhaul using [specific tools], achieving [metric]"
Use the candidate's REAL context_tags and achievements. Never fabricate, only reframe.
GUIDED READING: Wrap the most job-relevant keywords in **double asterisks**.

STEP 3 \u2014 EXPERIENCE ORDERING:
Order ALL experiences by relevance to this job. Most relevant first. This is NOT necessarily chronological.

STEP 4 \u2014 SKILLS (8-10 max):
Select only skills that match this job's domain. Hard skills first, skip generic soft skills.

STEP 5 \u2014 SUMMARY (2-3 sentences, first person):
If candidate doesn't hold the target title, bridge: "Proven [Current Role] with [X years] in [Domain], seeking to apply [Key Strength] as [Target Title]."
If they do hold it, lead with strongest relevant achievement. End with a concrete differentiator.

STEP 6 \u2014 TAGLINE:
${store.isDevMode ? `Select from: "Fix. Simplify. Scale." / "Remove the waste. Unlock the growth." / "From chaos to machine." / "Simplify first. Scale after." / "Less noise. More performance." / "Build a business that runs itself." / "Clarity > Speed > Scale" - or create similar (3-4 words, results-focused).` : `Generate a 5-7 word professional tagline connecting a candidate strength to what this job values.`}

JSON output:
{
  "summary":"string",
  "tagline":"string",
  "skills_relevant":["ordered by relevance to job"],
  "experience_merged":[
    {"role_key":"Job Title|Company Name","bullets":["bullet1","bullet2"]}
  ]
}`,
        `Candidate CV: ${JSON.stringify(store.userProfile)}\nJob Requirements: ${JSON.stringify(jobSummary)}${companyName ? `\nTarget Company: ${companyName}` : ""}`,
        0.3, false
      );

      const cv = safeParseJson(cvRaw);

      const html = renderCV(cv, jobSummary, store.userProfile);
      // Persist results with cvData so PDF button works after reopen
      chrome.storage.local.set({ savedResults: { html, cvData: cv, jobSummary } });
      resetBtn(triggerBtn, resetLabel);

    } catch (err) {
      console.error(err);
      if (err.message === "LIMIT_EXCEEDED") {
        showPaywall();
      } else {
        showToast("CV generation failed: " + err.message, "error");
      }
      resetBtn(triggerBtn, resetLabel);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // TAILORED PRO ENGINE (Gap-Bridging via Freelance Projects)
  // ────────────────────────────────────────────────────────────────────────────
  async function runTailoredProCV(rawJobText, triggerBtn, resetLabel) {
    const store = await getStorage(["coachCredits", "userProfile", "isPremium", "isDevMode"]);
    if (!store.userProfile) { showToast("Upload your CV first!", "error"); return; }

    triggerBtn.disabled = true;
    hideResults();

    try {
      // STEP 1 — Reader: extract job keywords
      triggerBtn.textContent = "Analyzing Gaps...";
      const jobSummary = await callGroq(
        `ATS job analyzer. Return JSON:
{"job_title":"","primary_focus":"leadership|technical|domain|hybrid","must_have_keywords":[],"nice_to_have_keywords":[],"action_verbs":[],"key_responsibilities":["top 3-5"],"seniority":"junior|mid|senior|lead"}`,
        rawJobText.substring(0, 6000),
        0.1, true
      );

      const companyName = companyInput.value.trim();


      // STEP 2 - Writer: GAP BRIDGING + SMART TAILORING
      triggerBtn.textContent = activeLanguage === "French" ? "Construction..." : "Bridging Gaps...";
      const cvRaw = await callGroqWriter(
        `Elite career strategist. Output language: ${activeLanguage}. Output ONLY valid JSON.

STEP 1 - JOB FOCUS ANALYSIS (internal):
Identify the PRIMARY FOCUS the employer values most (leadership, technical depth, domain expertise, or hybrid). This determines how ALL experience is reframed.

STEP 2 - GAP IDENTIFICATION:
Compare candidate history to job requirements. Find 1-2 critical missing skills/tools/processes.

STEP 3 - FREELANCE BOOST:
Create 1-2 realistic freelance projects to fill those gaps:
- Date them parallel to the candidate's current/recent role timeframe
- Name descriptively (e.g. "Supply Chain Digitalization Project"). NO agency/company names - present as independent freelance
- Use the missing tech. Wrap keywords in **double asterisks**
- Ensure every skill used also appears in skills_relevant

STEP 4 - SMART EXPERIENCE REFRAMING:
CRITICAL: Include EVERY experience from the candidate's CV. Do NOT skip any role.
- Highly relevant roles: 2-3 detailed bullets ANGLED toward the job's primary focus
- Less relevant roles: 1-2 shorter bullets highlighting transferable value
Never fabricate, only reframe emphasis. Wrap key terms in **double asterisks**.

STEP 5 - EXPERIENCE ORDERING:
Freelance projects FIRST, then ALL remaining experiences ordered by relevance (not chronological).

STEP 6 - SKILLS (8-10 max): Hard skills matching job domain first.

STEP 7 - SUMMARY (2-3 sentences, first person): Bridge to target role naturally.

STEP 8 - TAGLINE:
${store.isDevMode ? `Select from: "Fix. Simplify. Scale." / "Remove the waste. Unlock the growth." / "From chaos to machine." / "Simplify first. Scale after." / "Less noise. More performance." / "Build a business that runs itself." / "Clarity > Speed > Scale" - or create similar.` : `Generate a 5-7 word professional tagline connecting candidate strength to job needs.`}

JSON output:
{
  "summary":"string",
  "tagline":"string",
  "skills_relevant":["ordered by relevance"],
  "experience_merged":[
    {"role_key":"Freelance Consultant|Descriptive Project Name","bullets":["bullet"]},
    {"role_key":"Job Title|Company Name","bullets":["bullet1","bullet2"]}
  ]
}`,
        `Candidate CV: ${JSON.stringify(store.userProfile)}\nJob Requirements: ${JSON.stringify(jobSummary)}${companyName ? `\nTarget Company: ${companyName}` : ""}`,
        0.3, false
      );

      const cv = safeParseJson(cvRaw);

      const html = renderCV(cv, jobSummary, store.userProfile);
      chrome.storage.local.set({ savedResults: { html, cvData: cv, jobSummary } });
      resetBtn(triggerBtn, resetLabel);

    } catch (err) {
      console.error(err);
      if (err.message === "LIMIT_EXCEEDED") {
        showPaywall();
      } else {
        showToast("PRO Generation failed: " + err.message, "error");
      }
      resetBtn(triggerBtn, resetLabel);
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER: Analysis Results  — returns HTML string and also sets DOM
  // ────────────────────────────────────────────────────────────────────────────
  function renderResults(analysis, jobSummary, companyCtx) {
    resultsBox.classList.remove("hidden");
    const prob = Math.min(100, Math.max(0, parseInt(analysis.match_probability) || 0));
    let barColor = "#ef4444";
    if (prob >= 70) barColor = "#10b981";
    else if (prob >= 45) barColor = "#f59e0b";

    const toneNote = companyCtx
      ? ({ formal: "Be formal, polished, structured.", conversational: "Be conversational — show personality, skip corporate speak.", technical: "Emphasise technical depth; link to portfolio or code." })[companyCtx.tone_for_application] || ""
      : "";

    // ── Growth Roadmap renderer ──────────────────────────────────────────────
    const rm = analysis.growth_roadmap || {};
    const roadmapTracks = [
      { icon: "🧠", label: "Skills to Learn", items: rm.skills_to_learn, color: "#ede9fe", border: "#c4b5fd", text: "#4c1d95" },
      { icon: "🛠", label: "Projects to Build", items: rm.projects_to_build, color: "#e0f2fe", border: "#7dd3fc", text: "#0c4a6e" },
      { icon: "🌍", label: "Experiences to Seek", items: rm.experiences_to_seek, color: "#fef3c7", border: "#fcd34d", text: "#78350f" },
      { icon: "🏅", label: "Certifications", items: rm.certifications, color: "#dcfce7", border: "#86efac", text: "#14532d" },
    ];

    const roadmapHtml = roadmapTracks
      .filter(t => t.items && t.items.length > 0)
      .map(t => `
        <div style="background:${t.color};border:1px solid ${t.border};border-radius:7px;padding:8px 10px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${t.text};margin-bottom:5px;">${t.icon} ${t.label}</div>
          ${t.items.map(i => `<div style="font-size:11.5px;color:${t.text};padding-left:10px;margin-bottom:3px;">▸ ${i}</div>`).join("")}
        </div>`
      ).join("");

    const html = `
      <div class="result-header">
        <h4>Analysis${jobSummary?.job_title ? ` · ${jobSummary.job_title}` : ""}</h4>
        <strong style="color:${barColor};font-size:15px;">${prob}%</strong>
      </div>
      <div class="score-bar-wrap">
        <div class="score-bar-bg">
          <div class="score-bar-fill" id="score-fill" style="width:0%;background:${barColor};"></div>
        </div>
      </div>
      ${analysis.matched_skills ? `<div class="pill matched">✅ ${analysis.matched_skills}</div>` : ""}
      ${analysis.missing_skills ? `<div class="pill missing">⚠️ Missing: ${analysis.missing_skills}</div>` : ""}
      ${roadmapHtml ? `
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;padding:4px 0 2px;">📍 Your Growth Roadmap</div>
          ${roadmapHtml}
        </div>` : ""}
      <p class="advice"><strong>Coach:</strong> ${analysis.advice}</p>
      ${toneNote ? `<p class="advice" style="margin-top:0;"><strong>Company Tone:</strong> ${toneNote}</p>` : ""}
      ${analysis.wildcard ? `<div class="wildcard-box"><strong>🃏 Stand-Out Move</strong>${analysis.wildcard}</div>` : ""}
    `;
    resultsBox.innerHTML = html;
    requestAnimationFrame(() => {
      const fill = document.getElementById("score-fill");
      if (fill) fill.style.width = prob + "%";
    });
    return html;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER: Tailored CV  — returns HTML string and also sets DOM
  // ────────────────────────────────────────────────────────────────────────────
  function renderCV(cv, jobSummary, userProfile) {
    resultsBox.classList.remove("hidden");

    // Skills — filtered and ordered by the AI for this specific job
    const skillsHtml = (cv.skills_relevant || [])
      .map(s => `<div style="font-size:11px;color:#1c1c1e;padding:1px 0;">${s}</div>`)
      .join("");

    // Experience — rendered in AI's relevance order from experience_merged
    const profileExpMap = {};
    (userProfile?.experience || []).forEach(e => {
      profileExpMap[`${e.job_title}|${e.company_name}`] = e;
    });

    const expHtmlCombined = (cv.experience_merged || []).map(merged => {
      const profile = profileExpMap[merged.role_key];
      const bullets = merged.bullets || (profile?.key_achievements) || [];
      if (profile) {
        // Real experience — use profile metadata with AI bullets
        const start = profile.start_date || "";
        const end = profile.end_date || "Present";
        return `<div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:600;color:#1c1c1e;">${profile.job_title || ""}</span>
            <span style="font-size:10px;color:#888;">${start}${start ? " – " : ""}${end}</span>
          </div>
          <div style="font-size:11px;color:#6b7280;">${profile.company_name || ""}${profile.location ? " · " + profile.location : ""}</div>
          ${bullets.map(b => `<div style="font-size:11.5px;color:#333;padding-left:10px;margin-top:2px;">▸ ${mdToHtml(b)}</div>`).join("")}
        </div>`;
      } else {
        // PRO/Freelance project — no profile match
        const parts = merged.role_key.split("|");
        return `<div style="margin-bottom:12px; border-left: 2px solid #5C2D91; padding-left: 8px; background: #fdfaff;">
          <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:600;color:#5C2D91;">${parts[0] || "Consultant"}</span>
            <span style="font-size:9.5px;color:#8b5cf6;font-weight:700;">PRO</span>
          </div>
          <div style="font-size:11px;color:#5C2D91;font-weight:500;">${parts[1] || "Freelance Project"} · Remote</div>
          ${bullets.map(b => `<div style="font-size:11.5px;color:#333;padding-left:10px;margin-top:2px;">▸ ${mdToHtml(b)}</div>`).join("")}
        </div>`;
      }
    }).join("");



    const eduHtml = (userProfile?.education || []).map(e =>
      `<div style="margin-bottom:8px;">
        <div style="font-size:11px;font-weight:600;color:#1c1c1e;">${[e.degree, e.field_of_study].filter(Boolean).join(" / ") || ""}</div>
        <div style="font-size:10.5px;color:#6b7280;">${e.institution_name || ""}</div>
      </div>`
    ).join("");

    const html = `
      <div class="result-header">
        <h4>${cv.tagline || jobSummary?.job_title || "CV"}</h4>
        <button id="dl-pdf-btn" style="background:#5C2D91;color:white;border:none;padding:5px 11px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;">⬇ PDF</button>
      </div>

      <div style="display:grid;grid-template-columns:130px 1fr;gap:20px;margin-top:10px;align-items:start;">
        <div style="border-right:1px solid #f3f4f6;padding-right:10px;">
          ${skillsHtml ? `<div style="margin-bottom:15px;">
            <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#5C2D91;margin-bottom:5px;">Skills</div>
            ${skillsHtml}
          </div>` : ""}
          ${eduHtml ? `<div style="margin-bottom:15px;">
            <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#5C2D91;margin-bottom:5px;">Education</div>
            ${eduHtml}
          </div>` : ""}
        </div>
        <div>
          ${cv.summary ? `<div style="margin-bottom:15px;">
            <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#5C2D91;margin-bottom:4px;">Profile</div>
            <div style="font-size:11.5px;color:#333;line-height:1.5;">${cv.summary}</div>
          </div>` : ""}
          ${expHtmlCombined ? `<div>
            <div style="font-size:9px;font-weight:800;text-transform:uppercase;color:#5C2D91;margin-bottom:4px;">Experience</div>
            ${expHtmlCombined}
          </div>` : ""}
        </div>
      </div>
    `;
    resultsBox.innerHTML = html;

    const dlBtn = document.getElementById("dl-pdf-btn");
    if (dlBtn) dlBtn.addEventListener("click", () => openCVAsPDF(cv, jobSummary, userProfile));
    return html;
  }


  // ────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────────────────
  // ────────────────────────────────────────────────────────────────────────────
  function hideResults() {
    resultsBox.classList.add("hidden");
    paywallBox.classList.add("hidden");
  }
  function showPaywall() {
    // Compute next UTC midnight in the user's local timezone
    const now = new Date();
    const nextUTCMidnight = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1
    ));
    const resetTimeLocal = nextUTCMidnight.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const paywallMsg = paywallBox.querySelector("p");
    if (paywallMsg) paywallMsg.textContent = `5 free daily credits used. Resets at ${resetTimeLocal} (your time), or upgrade now.`;
    paywallBox.classList.remove("hidden");
    resultsBox.classList.add("hidden");
  }
  function resetBtn(btn, label) {
    btn.textContent = label;
    btn.disabled = false;
  }
});
