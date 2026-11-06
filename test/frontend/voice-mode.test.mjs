import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div class="messages"></div>'
  + '<div id="input-bar"><div class="input-row"><textarea id="msg-input"></textarea></div></div>'
  + '<div id="voiceSettings" hidden><input id="voiceAutoRead" type="checkbox"><input id="voiceBriefDefault" type="checkbox">'
  + '<input id="voiceAutoSend" type="checkbox"><button data-brief-threshold="200"></button><button data-brief-threshold="500"></button>'
  + '<button data-voice-language="auto"></button><button data-voice-language="zh-CN"></button></div>',
{ url: 'https://baton.test/', pretendToBeVisual: true });
const { window } = dom;
let hidden = false;
Object.defineProperty(window.document, 'hidden', { get: () => hidden });
Object.assign(globalThis, {
  window, document: window.document, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
});

const { state } = await import('../../web/js/state.js');
const voice = await import('../../web/js/voice-mode.js');

const posts = [];
const played = [];
class FakeAudio {
  constructor(url) { this.url = url; }
  play() { played.push(this.url); return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() {}
}
window.Audio = FakeAudio;
globalThis.Audio = FakeAudio;
window.apiPost = async (path, body) => {
  posts.push({ path, body });
  return { url: 'https://audio/' + posts.length, mode: body.text.length > body.threshold && body.brief ? 'brief' : 'original' };
};

function reset(session = 'session-a') {
  localStorage.clear();
  sessionStorage.clear();
  posts.length = 0;
  played.length = 0;
  hidden = false;
  voice.stopVoicePlayback();
  state.appState = { device: 'd', project: { hash: 'p' }, session };
  state.rootSessionId = '';
  document.querySelector('.messages').innerHTML = '';
}

function reply(text, { preview = false } = {}) {
  document.querySelector('.messages').insertAdjacentHTML('beforeend',
    '<div class="msg-user"><div class="msg-text">问题</div></div>'
    + '<div class="assistant-turn' + (preview ? ' stream-preview' : '') + '">'
    + '<div class="tl-item assistant-text" data-message-text="先看一下。"></div>'
    + '<div class="tl-item tool-node"></div>'
    + '<div class="tl-item assistant-text" data-message-text="' + text + '"></div></div>');
}

const settle = () => new Promise(resolve => setImmediate(resolve));
async function endTurn(t) {
  window.onVoiceTurnEnd();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(400); await settle(); }
}

test('sessions start in text mode with no voice bar', () => {
  reset();
  assert.equal(voice.voiceModeActive(), false);
  assert.match(voice.voiceModeControl(), /aria-pressed="false"/);
  window.refreshVoiceUi();
  assert.equal(document.getElementById('voice-bar'), null);
});

test('voice mode is remembered per Session', () => {
  reset();
  window.toggleVoiceMode();
  assert.equal(voice.voiceModeActive(), true);
  assert.equal(document.getElementById('voice-bar').hidden, false);
  state.appState.session = 'session-b';
  assert.equal(voice.voiceModeActive(), false);
  window.refreshVoiceUi();
  assert.equal(document.getElementById('voice-bar').hidden, true);
  state.appState.session = 'session-a';
  assert.equal(voice.voiceModeActive(), true);
  window.toggleVoiceMode();
  assert.equal(voice.voiceModeActive(), false);
  assert.equal(localStorage.getItem('baton-voice:session-a'), null);
});

test('the New Session view never enters voice mode', () => {
  reset('__new__');
  window.toggleVoiceMode();
  assert.equal(voice.voiceModeActive(), false);
});

test('brief follows Settings for new Sessions and the chip per Session', () => {
  reset();
  voice.saveVoiceSettings({ brief: false });
  assert.equal(voice.sessionVoice().brief, false);
  window.toggleVoiceMode();
  window.toggleVoiceBrief();
  assert.equal(voice.sessionVoice().brief, true);
  assert.equal(voice.sessionVoice('other').brief, false);
});

test('latest reply is the last text of the latest completed turn', () => {
  reset();
  reply('全部测试通过。');
  assert.equal(voice.latestReplyText(), '全部测试通过。');
  reply('还在输出', { preview: true });
  assert.equal(voice.latestReplyText(), '');
  document.querySelector('.messages').insertAdjacentHTML('beforeend', '<div class="msg-user"></div>');
  assert.equal(voice.latestReplyText(), '');
});

test('a finished turn is read once in voice mode', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  window.toggleVoiceMode();
  reply('全部测试通过。');
  await endTurn(t);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], { path: '/api/voice/speak', body: { text: '全部测试通过。', brief: true, threshold: 300 } });
  assert.deepEqual(played, ['https://audio/1']);
  await endTurn(t);
  assert.equal(posts.length, 1);
});

test('text mode and auto-read off stay silent', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  reply('完成。');
  await endTurn(t);
  window.toggleVoiceMode();
  voice.saveVoiceSettings({ autoRead: false });
  await endTurn(t);
  assert.equal(posts.length, 0);
});

test('a reply that ends while hidden plays on return', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  window.toggleVoiceMode();
  reply('后台完成。');
  hidden = true;
  await endTurn(t);
  assert.equal(posts.length, 0);
  hidden = false;
  document.dispatchEvent(new window.Event('visibilitychange'));
  await settle();
  assert.equal(posts.length, 1);
});

test('the voice bar replays the latest reply and leaving voice mode stops it', async () => {
  reset();
  window.toggleVoiceMode();
  reply('再读一遍。');
  window.refreshVoiceUi();
  document.querySelector('[data-voice-action="play"]').click();
  await settle();
  assert.equal(posts.at(-1).body.text, '再读一遍。');
  assert.match(document.getElementById('voice-bar').textContent, /Reading reply/);
  window.toggleVoiceMode();
  assert.equal(document.getElementById('voice-bar').hidden, true);
});

test('Settings switches persist voice preferences', () => {
  reset();
  voice.mountVoiceSettings();
  const root = document.getElementById('voiceSettings');
  assert.equal(root.hidden, false);
  assert.equal(root.querySelector('#voiceAutoRead').checked, true);
  assert.equal(root.querySelector('#voiceAutoSend').checked, false);
  root.querySelector('#voiceAutoSend').click();
  root.querySelector('[data-brief-threshold="500"]').click();
  assert.equal(voice.voiceSettings().autoSend, true);
  assert.equal(voice.voiceSettings().threshold, 500);
  assert.equal(root.querySelector('[data-brief-threshold="500"]').getAttribute('aria-pressed'), 'true');
  assert.equal(root.querySelector('[data-voice-language="auto"]').getAttribute('aria-pressed'), 'true');
  root.querySelector('[data-voice-language="zh-CN"]').click();
  assert.equal(voice.voiceSettings().language, 'zh-CN');
});
