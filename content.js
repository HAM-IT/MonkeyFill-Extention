// content.js
// This script runs directly on the webpage (job boards)

console.log("MonkeyFill Content Script Injected!");

let userProfile = {};
let learnedFields = {};

// Load user profile and learned mappings from local storage
function loadData(callback) {
  chrome.storage.local.get(['userProfile', 'learnedFields'], (result) => {
    userProfile = result.userProfile || {};
    learnedFields = result.learnedFields || {};
    if(callback) callback();
  });
}

// Emulate a realistic React/Angular input event
function setNativeValue(element, value) {
  const lastValue = element.value;
  element.value = value;
  const event = new Event("input", { bubbles: true });
  const tracker = element._valueTracker;
  if (tracker) {
    tracker.setValue(lastValue);
  }
  element.dispatchEvent(event);
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));
}

function runAutofill() {
  console.log("MonkeyFill: Running Autofill Engine...");
  
  const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
  
  inputs.forEach(input => {
    // If we've already filled it, skip it to avoid messing up manual edits
    if (input.dataset.monkeyFilled) return;

    const nameStr = input.name || "";
    const idStr = input.id || "";
    const placeholder = input.placeholder || "";
    const lowerContext = `${nameStr} ${idStr} ${placeholder}`.toLowerCase();
    
    let matchFound = false;
    let valueToInject = "";
    const personal = userProfile.personal || {};

    // 1. Check "Monkey-Learn" fallback (exact id/name matches from past)
    if (learnedFields[idStr] || learnedFields[nameStr]) {
      valueToInject = learnedFields[idStr] || learnedFields[nameStr];
      matchFound = true;
    }
    // 2. Smart Context Parsing — reads from userProfile.personal.*
    else if (lowerContext.includes('first') || lowerContext.includes('given') || lowerContext.includes('prénom')) {
      valueToInject = personal.first_name;
      matchFound = true;
    }
    else if (lowerContext.includes('last') || lowerContext.includes('family') || lowerContext.includes('nom')) {
      valueToInject = personal.last_name;
      matchFound = true;
    }
    else if (lowerContext.includes('email') || lowerContext.includes('e-mail') || lowerContext.includes('courriel')) {
      valueToInject = personal.email;
      matchFound = true;
    }
    else if (lowerContext.includes('phone') || lowerContext.includes('mobile') || lowerContext.includes('téléphone')) {
      valueToInject = personal.phone;
      matchFound = true;
    }

    if (matchFound && valueToInject) {
      setNativeValue(input, valueToInject);
      input.dataset.monkeyFilled = "true";
      input.style.border = "2px solid #5C2D91"; // Highlight field in Purple (HABOMIC vibe)
    } else {
      // Setup the Monkey-Learn listener for fields we didn't know
      setupMonkeyLearn(input);
    }
  });
}

// Feature: "Monkey-Learn" Fallback
// When the user types an answer into an unknown field and blurs away, remember it.
function setupMonkeyLearn(input) {
  input.addEventListener('blur', (e) => {
    const val = e.target.value.trim();
    if (val !== "" && !e.target.dataset.monkeyFilled) {
      const key = e.target.id || e.target.name;
      if (key) {
        // Save it to learned fields forever
        learnedFields[key] = val;
        chrome.storage.local.set({ learnedFields: learnedFields }, () => {
          console.log(`Monkey-Learn: Saved unknown field mapped to key [${key}]`);
          e.target.style.border = "2px solid #10b981"; // Success Green
        });
      }
    }
  });
}

// Smartly extract job description, ignoring headers/footers
function getSmartJobText() {
  const containers = [
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.getElementById('job-description'),
    document.querySelector('.job-description'),
    document.querySelector('.description'),
    document.querySelector('.posting')
  ];

  let targetContainer = null;
  for (const c of containers) {
    if (c && c.innerText.length > 500) {
      targetContainer = c;
      break;
    }
  }

  if (targetContainer) {
    return targetContainer.innerText.substring(0, 15000);
  }

  const meatyElements = document.querySelectorAll('p, li, h1, h2, h3, h4');
  let text = "";
  meatyElements.forEach(el => text += el.innerText + "\n");
  
  if (text.length > 500) {
    return text.substring(0, 15000);
  }

  return document.body.innerText.substring(0, 15000);
}

// Prepare form string for AI
function scanFormElements() {
  const inputs = document.querySelectorAll('input:not([type="hidden"]), textarea, select');
  const buttons = document.querySelectorAll('button, [role="button"]');
  
  let formRepresentation = [];
  
  inputs.forEach((input, index) => {
    const mfId = "mf-input-" + index;
    input.dataset.mfId = mfId;
    
    let labelText = "";
    if (input.labels && input.labels.length > 0) {
        labelText = input.labels[0].innerText;
    } else {
        labelText = input.placeholder || input.name || input.id;
    }
    
    formRepresentation.push({
      mfId: mfId,
      tag: input.tagName.toLowerCase(),
      type: input.type || '',
      label: labelText.trim(),
      currentValue: input.value
    });
  });

  buttons.forEach((btn, index) => {
    const text = btn.innerText.toLowerCase();
    if (text.includes('add ') || text.includes('+') || text.includes('more ') || text.includes('new ')) {
      const mfId = "mf-btn-" + index;
      btn.dataset.mfId = mfId;
      formRepresentation.push({
        mfId: mfId,
        tag: 'button',
        text: btn.innerText.trim()
      });
    }
  });

  return formRepresentation;
}

// Execute Actions from AI
function executeActions(actions) {
  actions.forEach(act => {
    const element = document.querySelector(`[data-mf-id="${act.mfId}"]`);
    if (!element) return;
    
    if (act.action === "fill" && element.tagName !== 'BUTTON') {
      setNativeValue(element, act.value || "");
      element.dataset.monkeyFilled = "true";
      element.style.border = "2px solid #5C2D91";
    } else if (act.action === "click" && (element.tagName === 'BUTTON' || element.getAttribute('role') === 'button')) {
      element.click();
      element.style.border = "2px solid #5C2D91";
    }
  });
}

// Listen for messages from the Popup to trigger autofill or scraping
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "run_autofill") {
    // Legacy fallback (Free)
    loadData(() => {
      runAutofill();
      sendResponse({ status: "success" });
    });
    return true; // async
  }
  
  if (request.action === "scan_form") {
    const formJson = scanFormElements();
    sendResponse({ form: formJson });
    return true;
  }

  if (request.action === "execute_actions") {
    executeActions(request.actions);
    sendResponse({ status: "success" });
    return true;
  }
  
  if (request.action === "scrape_job_posting") {
    const visibleText = getSmartJobText();
    sendResponse({ text: visibleText });
    return true;
  }
});
