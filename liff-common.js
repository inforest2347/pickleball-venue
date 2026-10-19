/**
 * liff-common.js — 場主 LIFF 頁面的共用函式
 * 需先載入 LIFF SDK：https://static.line-scdn.net/liff/edge/2/sdk.js
 */
(function () {
  'use strict';

  /** v2.3：SDK 改為非同步載入，用到時才等它 */
  function sdkReady() {
    if (window.liff) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const el = document.getElementById('liffSdk');
      if (!el) return reject(new Error('找不到 LIFF SDK'));
      el.addEventListener('load', function () { resolve(); });
      el.addEventListener('error', function () { reject(Object.assign(new Error('LINE 元件載入失敗，請檢查網路後重新開啟'), { code: 'NETWORK' })); });
      if (window.liff) resolve();
    });
  }

  async function init(liffId) {
    if (!liffId) throw new Error('尚未設定 LIFF_ID');
    await sdkReady();
    await liff.init({ liffId: liffId });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return new Promise(function () {}); // 等待跳轉
    }
    return liff;
  }

  /** 讀網址參數；同時處理 liff.line.me/{id}?page=x 轉址時包在 liff.state 裡的參數 */
  function params() {
    const p = new URLSearchParams(location.search);
    const state = p.get('liff.state');
    if (state) {
      const q = state.indexOf('?');
      if (q >= 0) new URLSearchParams(state.slice(q + 1)).forEach(function (v, k) { p.set(k, v); });
    }
    return p;
  }

  /** 呼叫 GAS；text/plain 可避免瀏覽器先送 OPTIONS 預檢（GAS 不支援） */
  async function call(gasUrl, action, data) {
    const idToken = liff.getIDToken();
    let res;
    try {
      res = await fetch(gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: action, idToken: idToken, data: data || {} }),
      });
    } catch (e) {
      throw Object.assign(new Error('網路連線失敗，請稍後再試'), { code: 'NETWORK' });
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw Object.assign(new Error('伺服器回應格式錯誤'), { code: 'BAD_RESPONSE' });
    }
    if (!json.ok) throw Object.assign(new Error(json.message || '發生錯誤'), { code: json.code });
    return json.data;
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  let toastTimer;
  function toast(msg, type) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'toast show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 2600);
  }

  function money(n) {
    return 'NT$' + Number(n || 0).toLocaleString('zh-TW');
  }

  window.LiffKit = { init: init, params: params, call: call, esc: esc, toast: toast, money: money };
})();
