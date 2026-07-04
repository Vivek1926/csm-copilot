// Typed message constants + thin wrappers over chrome.runtime messaging.
// Every message carries { target, type, ...payload }. Contexts filter on `target`.

export const TARGET = {
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
  PANEL: 'panel',
};

export const MSG = {
  // panel -> background
  PANEL_START: 'PANEL_START',
  PANEL_STOP: 'PANEL_STOP',
  // background -> offscreen
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',
  // offscreen -> panel
  STATUS: 'STATUS',
  MODEL_PROGRESS: 'MODEL_PROGRESS',
  INTERIM_HINT: 'INTERIM_HINT',
  TRANSCRIPT_SEGMENT: 'TRANSCRIPT_SEGMENT',
  QUESTION_EVENT: 'QUESTION_EVENT',
  ANSWER_UPDATE: 'ANSWER_UPDATE',
  // panel -> offscreen
  MANUAL_ASK: 'MANUAL_ASK',
  GET_STATE: 'GET_STATE',
  // background/panel -> offscreen (offscreen docs can't read chrome.storage,
  // so Stage-2 config is pushed to them)
  CONFIG_UPDATE: 'CONFIG_UPDATE',
};

/**
 * Fire-and-forget broadcast. chrome.runtime.sendMessage rejects when no
 * listener is alive (e.g. panel closed) — that is fine, swallow it.
 */
export function broadcast(msg) {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Request/response helper (uses the same channel, awaits the reply). */
export function request(msg) {
  return chrome.runtime.sendMessage(msg);
}
