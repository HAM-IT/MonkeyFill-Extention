// background.js
// Service worker — handles first-install setup.

console.log("MonkeyFill Background Service Worker initialized!");

// When the extension is first installed, set up default data
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["coachCredits", "lastResetDate", "isPremium"], (res) => {
    if (res.coachCredits === undefined) {
      chrome.storage.sync.set(
        {
          coachCredits: 5,
          lastResetDate: new Date().toDateString(),
          isPremium: false,
        },
        () => {
          console.log("MonkeyFill: Initialized default data in chrome.storage.sync");
        }
      );
    }
  });
});
