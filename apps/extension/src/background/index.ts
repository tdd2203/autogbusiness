import { runOnce } from "./runner";

const ALARM_NAME = "autogpt.poll";
const POLL_INTERVAL_MINUTES = 0.5;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
  console.log("[autogpt] installed, alarm scheduled");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_INTERVAL_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const result = await runOnce();
  console.log("[autogpt] alarm tick →", result);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "poll-now") {
    runOnce()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  }
  return undefined;
});

console.log("[autogpt] background service worker booted");
