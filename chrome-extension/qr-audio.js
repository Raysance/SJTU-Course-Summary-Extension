const alertAudio = new Audio(chrome.runtime.getURL("assets/qr-alert.wav"));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "qr-audio" || message.action !== "qrPlaySound") return false;
  alertAudio.currentTime = 0;
  alertAudio.play().then(() => sendResponse({ok: true}), error => sendResponse({error: error.message}));
  return true;
});
