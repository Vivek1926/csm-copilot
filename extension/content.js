// Light glue in the Meet tab. Injects nothing heavy; just answers "does this
// look like an active call?" so the panel can warn before starting capture.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_MEET_STATE') {
    // Meet call URLs look like /abc-defg-hij
    const inCall = /^\/[a-z]{3}-[a-z]{4,}-[a-z]{3}/i.test(location.pathname);
    sendResponse({ inCall, url: location.href });
  }
  return false;
});
