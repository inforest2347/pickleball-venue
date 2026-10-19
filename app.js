/**
 * venue/app.js — 場主 LIFF 頁面　v2.3（2026/10/19：開頁更快；含 v2.2 讀取優化、v2.1 我已到場定位）
 * v2.3：LINE 登入（liff.init）完成前就先顯示上次的畫面；切回 LINE 時立刻更新；排班頁預先載入今天的名單
 * v2.2：開頁一次 init、先顯示上次的資料再更新、30 秒輪詢只比對簽章、比分與簽到先更新畫面
 * 頁面：shifts 我的排班／checkin 今日球敘（點名・輪轉・比分・積分）／report 收班回報／profile 我的資料
 * 網址：https://liff.line.me/{LIFF_ID}?page=checkin（可加 &shift=排班ID&tab=score）
 */
(function () {
  'use strict';

  const { esc, toast, money } = LiffKit;
  const CFG = window.APP_CONFIG || {};
  const PAGES = ['shifts', 'checkin', 'report', 'profile'];
  const TABS = [
    ['roll', '點名'],
    ['rotation', '輪轉'],
    ['score', '比分'],
    ['rank', '積分'],
  ];
  const POLL_MS = 30000;
  const FLUSH_MS = 15000;
  const QUEUE_KEY = 'venue.pendingScores.v1';
  const SNAP_KEY = 'venue.snapshot.v2';   // 上次的 me、排班、名單（開頁先顯示）
  const FULL_EVERY = 5;                    // 輪詢每 5 次（約 2.5 分鐘）抓一次完整名單（含收款變化）

  const state = {
    me: null, page: 'shifts', tab: 'roll', shiftId: '', roster: null, court: '',
    pollTimer: null, flushTimer: null, busy: false, flushing: false,
    shifts: null, stale: false, pollCount: 0,
  };
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const tabs = document.getElementById('tabs');

  const api = (action, data) => LiffKit.call(CFG.GAS_URL, action, data);

  /* ---------- 啟動 ---------- */

  async function boot() {
    try {
      const p = LiffKit.params();
      state.page = PAGES.indexOf(p.get('page')) >= 0 ? p.get('page') : 'shifts';
      state.shiftId = p.get('shift') || '';
      if (TABS.some((t) => t[0] === p.get('tab'))) state.tab = p.get('tab');
      window.addEventListener('online', flushScores);
      state.flushTimer = setInterval(flushScores, FLUSH_MS);

      // 先用上次的資料畫出畫面（標示更新中），同時向伺服器要最新資料
      const snap = loadSnap();
      if (snap && snap.me && snap.me.state === 'active') {
        state.me = snap.me;
        state.shifts = snap.shifts || null;
        if (!state.shiftId && state.page !== 'shifts' && snap.roster && snap.roster.session.date === todayStr()) state.shiftId = snap.shiftId;
        if (snap.roster && snap.shiftId === state.shiftId) state.roster = snap.roster;
        setStale(true);
        showWho();
        const canShow = state.page === 'profile' || (state.page === 'shifts' && state.shifts) ||
          ((state.page === 'checkin' || state.page === 'report') && state.roster);
        if (canShow) route();
      }

      await LiffKit.init(CFG.LIFF_ID); // v2.3：上次的畫面已先顯示，這裡才等 LINE 登入
      const init = await api('init', { page: state.page, shiftId: state.shiftId });
      state.me = init.me;
      state.shifts = init.shifts || null;
      if (init.shiftId) state.shiftId = init.shiftId;
      state.roster = init.roster || (state.shiftId && init.shiftId === state.shiftId ? state.roster : null);
      if (state.shiftId && !init.roster && state.page !== 'shifts') state.shiftId = '';
      state.shiftsStale = false;
      setStale(false);
      saveSnap();
      showWho();
      route();
      flushScores();
      document.addEventListener('visibilitychange', onVisible);
    } catch (e) {
      if (state.stale) {
        // 已經顯示上次的畫面：不要整頁換成錯誤，提示即可
        toast(e.message || '無法更新，請稍後再試', 'error');
        const bar = document.querySelector('.stalebar');
        if (bar) bar.textContent = '目前顯示上次的資料（無法更新：' + (e.message || '連線問題') + '）';
      } else {
        showFatal(e);
      }
    }
  }

  /** v2.3：從背景切回 LINE 時立刻檢查一次，不必等 30 秒 */
  let lastVisibleCheck = 0;
  function onVisible() {
    if (document.visibilityState !== 'visible' || state.stale) return;
    if (Date.now() - lastVisibleCheck < 10000) return;
    lastVisibleCheck = Date.now();
    if (state.page === 'checkin' && state.roster) pollRoster(true);
  }

  /** v2.3：在排班頁時，背景先載入「今天唯一一場」的名單，點進今日球敘就不用等 */
  async function prefetchToday() {
    if (state.stale || !state.shifts) return;
    const today = state.shifts.filter((s) => s.isToday && s.editable && s.sessionStatus !== '取消');
    if (today.length !== 1) return;
    const id = today[0].shiftId;
    if (state.roster && state.roster.shift.shiftId === id) return;
    try {
      state.prefetch = { id: id, p: api('roster', { shiftId: id }) };
      const r = await state.prefetch.p;
      state.prefetch = null;
      if (!state.roster || state.page !== 'checkin') {
        state.roster = r;
        if (!state.shiftId) state.shiftId = id;
        saveSnap();
      }
    } catch (e) { state.prefetch = null; /* 背景載入失敗不影響 */ }
  }

  function showWho() {
    document.getElementById('who').textContent = state.me.profile ? state.me.profile.name : state.me.lineName;
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** 顯示上次資料時：按鈕暫停使用，頂端顯示「更新中」 */
  function setStale(on) {
    state.stale = on;
    document.body.classList.toggle('stale', on);
  }

  function loadSnap() {
    try {
      return JSON.parse(localStorage.getItem(SNAP_KEY) || 'null');
    } catch (e) {
      return null;
    }
  }

  function saveSnap() {
    try {
      localStorage.setItem(SNAP_KEY, JSON.stringify({
        at: Date.now(), me: state.me, shifts: state.shifts, shiftId: state.shiftId, roster: state.roster,
      }));
    } catch (e) { /* 手機不能存時略過 */ }
  }

  function showFatal(e) {
    app.innerHTML = '<div class="card notice error"><h2>無法開啟</h2><p>' + esc(e.message) + '</p>' +
      (e.code ? '<p class="muted">代碼：' + esc(e.code) + '</p>' : '') + '</div>';
  }

  function route() {
    stopPoll();
    closeModal();
    const s = state.me.state;
    tabs.hidden = s !== 'active';
    if (s === 'unregistered') return renderProfile(true);
    if (s === 'pending') return renderNotice('審核中', '資料已送出，總場主核准後就能使用排班與點名。核准後重新開啟即可。');
    if (s === 'inactive') return renderNotice('帳號停用', '你的帳號目前停用，如有疑問請直接在聊天室留言給總場主。');

    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.page === state.page));
    if (state.page === 'shifts') return renderShifts();
    if (state.page === 'checkin') return renderSession();
    if (state.page === 'report') return renderReport();
    return renderProfile(false);
  }

  function go(page, shiftId) {
    state.page = page;
    if (shiftId !== undefined) state.shiftId = shiftId;
    window.scrollTo(0, 0);
    route();
  }

  tabs.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-page]');
    if (b) go(b.dataset.page);
  });

  function renderNotice(title, text) {
    app.innerHTML = '<div class="card notice"><h2>' + esc(title) + '</h2><p>' + esc(text) + '</p></div>';
  }

  function loading(text) {
    app.innerHTML = '<div class="skeleton" aria-label="' + esc(text || '載入中') + '">' +
      '<div class="sk-card"><i style="width:60%"></i><i style="width:85%"></i><i style="width:40%"></i></div>' +
      '<div class="sk-card"><i style="width:70%"></i><i style="width:50%"></i></div>' +
      '<div class="sk-card"><i style="width:65%"></i><i style="width:45%"></i></div></div>';
  }

  /** 執行寫入動作：防止連點，錯誤統一提示 */
  /** v2.1：取得定位 { lat, lng, acc }；失敗回傳 { error } */
  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ error: 'UNSUPPORTED' });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => resolve({ error: e.code === 1 ? 'DENIED' : 'UNAVAILABLE' }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
      );
    });
  }

  async function act(fn, okMsg) {
    if (state.busy) return null;
    state.busy = true;
    document.body.classList.add('busy');
    try {
      const r = await fn();
      const msg = (r && r.message) || okMsg;
      if (msg) toast(msg, 'ok');
      return r;
    } catch (e) {
      toast(e.message, 'error');
      if (e.code === 'AUTH_EXPIRED') stopPoll();
      return null;
    } finally {
      state.busy = false;
      document.body.classList.remove('busy');
    }
  }

  /** 場次相關的寫入：成功時更新資料並重畫 */
  async function rosterAct(action, data, okMsg) {
    const res = await act(() => api(action, Object.assign({ shiftId: state.shiftId }, data)), okMsg);
    if (res) {
      applyResult(res);
      closeModal();
      drawSession();
    }
    return res;
  }

  /** 輪轉、比分類動作只回傳 game 與簽章；其他動作回傳完整名單 */
  function applyResult(res) {
    if (res.people) state.roster = res;
    else if (res.game && state.roster) {
      state.roster.game = res.game;
      state.roster.sig = res.sig;
    }
    saveSnap();
  }

  /* ---------- 我的排班 ---------- */

  async function renderShifts() {
    let list = state.shifts;
    if (!list || state.shiftsStale) {
      if (list) drawShifts(list); else loading();
      try {
        list = state.shifts = await api('myShifts');
        state.shiftsStale = false;
        saveSnap();
      } catch (e) {
        if (!state.shifts) return showFatal(e);
        toast(e.message, 'error');
        return null;
      }
      if (state.page !== 'shifts') return null;
    }
    state.shiftsStale = true; // 下次切回排班頁時重新整理
    const out = drawShifts(list);
    setTimeout(prefetchToday, 300);
    return out;
  }

  function drawShifts(list) {
    if (!list.length) return renderNotice('目前沒有排班', '排班由營運安排，有新的排班時會在前一晚提醒你。');

    app.innerHTML = '<h1>我的排班</h1>' + list.map((s) => `
      <div class="card shift ${s.isToday ? 'today' : ''} ${s.sessionStatus === '取消' ? 'cancelled' : ''}">
        <div class="row">
          <div>
            <div class="date">${esc(s.date)}${s.isToday ? '<span class="tag green">今天</span>' : ''}</div>
            <div class="title">${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
            <div class="muted">${esc(s.sessionName)}${s.sessionStatus === '取消' ? '（已取消）' : ''}</div>
          </div>
          <span class="tag">${esc(s.arrive)}</span>
        </div>
        ${s.editable && s.sessionStatus !== '取消' ? `
        <div class="actions">
          <button class="btn" data-go="checkin" data-shift="${esc(s.shiftId)}">今日球敘</button>
          <button class="btn ghost" data-go="report" data-shift="${esc(s.shiftId)}">收班回報</button>
        </div>` : ''}
      </div>`).join('');

    app.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => go(b.dataset.go, b.dataset.shift)));
  }

  /** 沒有指定排班時：今天只有一場就直接用，多場就讓人選 */
  async function pickShift(page) {
    if (state.shiftId) return state.shiftId;
    if (!state.shifts) {
      loading();
      state.shifts = await api('myShifts');
    }
    const list = state.shifts.filter((s) => s.editable && s.sessionStatus !== '取消');
    const today = list.filter((s) => s.isToday);
    const candidates = today.length ? today : list;
    if (candidates.length === 1) return (state.shiftId = candidates[0].shiftId);
    if (!candidates.length) {
      renderNotice('今天沒有你的排班', '如果你正在現場，請確認營運是否已排班，或在聊天室告訴總場主。');
      return '';
    }
    app.innerHTML = '<h1>選擇場次</h1>' + candidates.map((s) => `
      <button class="card pick" data-shift="${esc(s.shiftId)}">
        <div class="date">${esc(s.date)}</div>
        <div class="title">${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
        <div class="muted">${esc(s.sessionName)}</div>
      </button>`).join('');
    app.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => go(page, b.dataset.shift)));
    return '';
  }

  /* ---------- 今日球敘 ---------- */

  async function renderSession() {
    let shiftId;
    try {
      shiftId = await pickShift('checkin');
      if (!shiftId) return;
      if (!state.roster || state.roster.shift.shiftId !== shiftId) {
        loading();
        // 排班頁正在預先載入同一場時，等它就好，不重複呼叫
        state.roster = state.prefetch && state.prefetch.id === shiftId
          ? await state.prefetch.p : await api('roster', { shiftId: shiftId });
        saveSnap();
      }
    } catch (e) {
      state.shiftId = '';
      return showFatal(e);
    }
    drawSession();
    if (!state.stale) startPoll();
  }

  function drawSession() {
    const r = state.roster;
    if (!r || state.page !== 'checkin') return;
    const s = r.session;
    const sum = r.summary;
    const arrived = r.shift.arrive === '已到場' || r.shift.arrive === '遲到';
    const pendingN = Object.keys(loadQueue()).length;
    if (!state.court || !r.courts.some((c) => c.id === state.court)) state.court = r.courts.length ? r.courts[0].id : '';

    const body = {
      roll: drawRoll,
      rotation: drawRotation,
      score: drawScores,
      rank: drawRank,
    }[state.tab]();

    app.innerHTML = `
      <div class="card head">
        <div class="title">${esc(s.name)} <span class="tag ${s.type === '不限' ? '' : 'blue'}">${esc(s.type)}</span></div>
        <div class="muted">${esc(s.date)}　${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
        <div class="stats">
          <div><b>${sum.present}</b><span>在場</span></div>
          <div><b>${sum.registered}</b><span>報名／上限 ${s.capacity || '—'}</span></div>
          <div><b>${sum.walkinPending + (s.started ? sum.waitlist : 0)}</b><span>待處理</span></div>
          <div><b>${money(sum.systemTotal)}</b><span>我收的款</span></div>
        </div>
        ${arrived
          ? `<div class="arrived">✓ ${esc(r.shift.arrive)}　${esc(r.shift.arriveTime)}</div>`
          : s.editable ? '<button class="btn block" id="btnArrive">我已到場</button><p class="muted" style="text-align:center;margin:6px 0 0">開始前 30 分鐘起、在場地附近才能簽到</p>' : ''}
        ${!s.editable ? '<p class="muted">此場次目前不可修改（只能在球敘當天或隔天操作）。</p>' : ''}
        ${pendingN ? `<div class="offline">⚠ ${pendingN} 筆比分待上傳，恢復連線後會自動送出</div>` : ''}
        ${state.stale ? '<div class="stalebar">顯示上次的資料，更新中…</div>' : ''}
      </div>
      <div class="seg" role="tablist">
        ${TABS.map((t) => `<button data-tab="${t[0]}" class="${state.tab === t[0] ? 'on' : ''}">${t[1]}</button>`).join('')}
      </div>
      ${body}
    `;

    const btnArrive = document.getElementById('btnArrive');
    // v2.1：開始前 30 分鐘起、在據點附近才能簽到 → 先取得定位再送出
    if (btnArrive) btnArrive.addEventListener('click', async () => {
      if (state.busy) return;
      btnArrive.disabled = true;
      btnArrive.textContent = '確認位置中…';
      const loc = await getLocation();
      btnArrive.disabled = false;
      btnArrive.textContent = '我已到場';
      if (loc.error) {
        return toast(loc.error === 'DENIED' ? '簽到需要定位，請允許 LINE 使用定位後再按一次' : '目前無法取得定位，請確認手機已開啟定位', 'error');
      }
      rosterAct('arrive', loc, '已記錄到場');
    });
    app.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      drawSession();
    }));
    app.querySelectorAll('[data-court]').forEach((b) => b.addEventListener('click', () => {
      state.court = b.dataset.court;
      drawSession();
    }));
    const btnRefresh = document.getElementById('btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', refreshRoster);
    app.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onAction));
  }

  function courtChips() {
    const r = state.roster;
    if (r.courts.length < 2) return '';
    return '<div class="chips">' + r.courts.map((c) =>
      `<button data-court="${esc(c.id)}" class="${state.court === c.id ? 'on' : ''}">${esc(c.name)}</button>`).join('') + '</div>';
  }

  function gameOf(courtId) {
    return state.roster.game.find((g) => g.id === courtId);
  }

  /* ----- 點名 ----- */

  function drawRoll() {
    const r = state.roster;
    const can = r.session.editable;
    const walkins = r.people.filter((p) => p.status === '現場待確認');
    const groups = r.courts.map((c) => ({ id: c.id, name: c.name, people: r.people.filter((p) => p.status === '已報名' && p.court === c.id) }));
    const none = r.people.filter((p) => p.status === '已報名' && !r.courts.some((c) => c.id === p.court));
    if (none.length) groups.push({ id: '', name: '未分面', people: none });

    let html = `<div class="listhead"><span>名單（${r.summary.registered}）</span><button class="link" id="btnRefresh">重新整理</button></div>`;
    if (walkins.length) {
      html += '<div class="group-title">現場待確認</div>' + walkins.map((p) => personRow(p, can)).join('');
    }
    groups.forEach((g) => {
      const here = g.people.filter((p) => p.attend === '出席' && !p.left).length;
      html += `<div class="group-title">${esc(g.name)}<span class="muted">　在場 ${here}／${g.people.length}</span></div>`;
      html += g.people.length ? g.people.map((p) => personRow(p, can)).join('') : '<div class="card muted">沒有人</div>';
    });
    if (r.waitlist.length) {
      html += `<div class="group-title">候補（${r.waitlist.length}）</div>`;
      if (!r.session.started) html += '<p class="muted">開打前由系統自動遞補，開打後可在這裡讓現場的候補者上場。</p>';
      html += r.waitlist.map((w) => `
        <div class="card person">
          <div class="row">
            <div><div class="name">${w.rank}. ${esc(w.name)}</div><div class="muted">${esc(w.courtName || '未指定球面')}</div></div>
            ${can && r.session.started ? `<div class="btns"><button class="btn sm" data-act="acceptWait" data-id="${esc(w.regId)}">接受上場</button></div>` : ''}
          </div>
        </div>`).join('');
    }
    return html;
  }

  function personRow(p, can) {
    const pending = p.status === '現場待確認';
    const present = p.attend === '出席';
    const tags = [
      pending ? '<span class="tag orange">現場待確認</span>' : '',
      p.left ? `<span class="tag">離場 ${esc(p.leftTime)}</span>` : '',
      p.isNew ? '<span class="tag blue">新人</span>' : '',
      p.isFree ? '<span class="tag">免費體驗</span>' : '',
      p.source === '現場' && !pending ? '<span class="tag">現場</span>' : '',
      p.dupr ? `<span class="tag">DUPR ${esc(p.dupr)}</span>` : '',
    ].join('');
    let pay = '';
    if (p.hasAr) {
      if (p.unpaid > 0) pay = `<span class="due">未收 ${money(p.unpaid)}</span>${p.deadline ? `<span class="muted">（期限 ${esc(p.deadline)}）</span>` : ''}`;
      else if (p.pending > 0) pay = '<span class="paid">已付・待對帳</span>';
      else pay = '<span class="paid">已收清</span>';
    }

    let buttons = '';
    if (can && pending) {
      buttons = `
        <button class="btn sm" data-act="accept" data-id="${esc(p.regId)}">接受</button>
        <button class="btn sm ghost" data-act="decline" data-id="${esc(p.regId)}">婉拒</button>`;
    } else if (can) {
      if (!present) buttons += `<button class="btn sm" data-act="present" data-id="${esc(p.regId)}">簽到</button>`;
      if (p.hasAr && p.unpaid > 0) buttons += `<button class="btn sm amber" data-act="collect" data-id="${esc(p.regId)}">收款</button>`;
      buttons += `<button class="btn sm ghost" data-act="more" data-id="${esc(p.regId)}">更多</button>`;
    }

    const status = present ? (p.left ? '已離場' : '✓ ' + esc(p.time) + ' 簽到') : pending ? '超過上限的現場報名' : '尚未簽到';
    return `
      <div class="card person ${present && !p.left ? 'present' : ''} ${pending ? 'pending' : ''} ${p.left ? 'left' : ''}">
        <div class="row">
          <div>
            <div class="name">${esc(p.name)} ${tags}</div>
            <div class="muted">${status}　${pay}</div>
          </div>
          <div class="btns">${buttons}</div>
        </div>
      </div>`;
  }

  /* ----- 輪轉 ----- */

  function drawRotation() {
    const r = state.roster;
    const g = gameOf(state.court);
    if (!g) return '<div class="card muted">這場球敘沒有設定使用場地，請營運在 AppSheet 補上。</div>';
    const can = r.session.editable;
    const n = g.players.length;
    let html = courtChips();
    html += `<div class="card">
      <div class="row"><div class="title">${esc(g.name)}　<span class="muted">上場 ${n} 人</span></div>
      ${g.total ? `<span class="tag green">${g.done}／${g.total} 場</span>` : ''}</div>
      <div class="letters">${g.players.map((p) => `<span><b>${p.letter}</b>${esc(p.name)}</span>`).join('') || '<span class="muted">還沒有人簽到</span>'}</div>
    </div>`;

    if (!g.total) {
      if (n < 4) html += '<div class="card muted">這一面要 4～8 位已簽到的人才能產生輪轉表。人數不夠時可在「點名」把人換到這一面。</div>';
      else if (n > 8) html += '<div class="card muted">超過 8 人，請先在「點名」把人分到其他面（每面 4～8 人）。</div>';
      else if (can) {
        html += `<div class="card">
          ${g.options.length > 1 ? `<label class="inline">場數
            <select id="gGames">${g.options.map((o) => `<option value="${o}" ${o === g.defaultGames ? 'selected' : ''}>${o} 場（每人 ${o * 4 / n} 場）</option>`).join('')}</select></label>
            <p class="muted">${n} 人沒有完美的排法，系統以上場數平均、不重複搭檔、休息不連續為優先。</p>`
            : `<p class="muted">${n} 人共 ${g.defaultGames} 場${n === 8 ? '，每兩人當隊友剛好一次、每人打 7 場' : n === 5 ? '，每場 1 人休息' : '，每兩人當一次隊友'}。</p>`}
          <button class="btn block" data-act="generate">產生輪轉表</button>
          <p class="muted">產生前請確認點名與分面；已有比分後不能重新產生，只能補場或改人。</p>
        </div>`;
      }
      return html;
    }

    html += roundsTable(g, can);
    if (can) {
      html += '<div class="actions">';
      if (!g.done) html += '<button class="btn ghost" data-act="regen">重新產生</button><button class="btn ghost" data-act="clear">清除</button>';
      html += '<button class="btn ghost" data-act="addMatch">補場</button></div>';
    }
    return html;
  }

  function roundsTable(g, can) {
    const byRound = {};
    g.matches.forEach((m) => { (byRound[m.round] = byRound[m.round] || []).push(m); });
    const queue = loadQueue();
    return '<div class="card rounds">' + Object.keys(byRound).map(Number).sort((a, b) => a - b).map((rd) => `
      <div class="round"><div class="rno">第 ${rd} 輪</div><div class="games">
        ${byRound[rd].map((m) => {
          const q = queue[m.id];
          const score = q ? `<span class="tag orange">待上傳 ${q.sa}:${q.sb}</span>` : m.done ? `<b class="sc">${m.sa}:${m.sb}</b>` : '';
          return `<button class="game ${m.done ? 'done' : ''} ${m.hasInactive ? 'warn' : ''}" ${can && !m.done ? `data-act="editMatch" data-id="${esc(m.id)}"` : 'disabled'}>
            <span>${teamText(m.a)}</span><span class="vs">vs</span><span>${teamText(m.b)}</span>${score}
            ${m.hasInactive ? '<span class="tag orange">含離場或已換面的人</span>' : ''}
          </button>`;
        }).join('')}
      </div></div>`).join('') + '</div>';
  }

  function teamText(team) {
    return team.map((p) => esc(p.name)).join('・');
  }

  /* ----- 比分 ----- */

  function drawScores() {
    const r = state.roster;
    const g = gameOf(state.court);
    let html = courtChips();
    if (!g || !g.total) return html + '<div class="card muted">這一面還沒有輪轉表，請先到「輪轉」產生。</div>';
    const queue = loadQueue();
    html += '<p class="muted">點一場 → 輸入兩隊比分 → 儲存，會自動跳到下一場。已完成的也可以點開修改。</p>';
    html += g.matches.map((m) => {
      const q = queue[m.id];
      const sa = q ? q.sa : m.sa;
      const sb = q ? q.sb : m.sb;
      const has = !!(q || m.done);
      const st = q ? '<span class="tag orange">待上傳</span>' : m.done ? '<span class="tag green">已完成</span>' : '<span class="tag">未開始</span>';
      return `<button class="card scorecard ${has ? 'done' : ''}" ${r.session.editable ? `data-act="score" data-id="${esc(m.id)}"` : 'disabled'}>
        <div class="row"><span class="muted">第 ${m.round} 輪・第 ${m.seq} 場</span>${st}</div>
        <div class="teams">
          <div><span>${teamText(m.a)}</span><b>${has ? sa : ''}</b></div>
          <div><span>${teamText(m.b)}</span><b>${has ? sb : ''}</b></div>
        </div>
      </button>`;
    }).join('');
    return html;
  }

  /** 比分輸入：直接填兩隊分數（不選勝隊、不限分數、可平手） */
  function openScore(m) {
    const q = loadQueue()[m.id];
    const sa = q ? q.sa : m.sa;
    const sb = q ? q.sb : m.sb;

    modal.innerHTML = `
      <div class="sheet">
        <h2>第 ${m.round} 輪・第 ${m.seq} 場</h2>
        <p class="muted">輸入兩隊的比分（可平手）。</p>
        <div class="scoreinputs">
          <label>${teamText(m.a)}<input id="sA" type="number" inputmode="numeric" min="0" max="99"></label>
          <label>${teamText(m.b)}<input id="sB" type="number" inputmode="numeric" min="0" max="99"></label>
        </div>
        <div id="sErr" class="warn-text"></div>
        <div class="actions">
          ${m.done ? '<button class="btn ghost" id="sReset">清除比分</button>' : ''}
          <button class="btn ghost" id="sCancel">取消</button>
          <button class="btn" id="sOk">儲存</button>
        </div>
      </div>`;
    modal.hidden = false;
    const inA = document.getElementById('sA');
    const inB = document.getElementById('sB');
    const errEl = document.getElementById('sErr');
    if (sa !== null && sa !== undefined) inA.value = sa;
    if (sb !== null && sb !== undefined) inB.value = sb;
    inA.focus();
    inA.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') inB.focus(); });
    inB.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') document.getElementById('sOk').click(); });
    document.getElementById('sCancel').addEventListener('click', closeModal);
    const reset = document.getElementById('sReset');
    if (reset) reset.addEventListener('click', () => {
      if (!confirm('清除這一場的比分？')) return;
      removeQueued(m.id);
      rosterAct('resetScore', { matchId: m.id });
    });
    document.getElementById('sOk').addEventListener('click', () => {
      const a = inA.value === '' ? NaN : Number(inA.value);
      const b = inB.value === '' ? NaN : Number(inB.value);
      const e = scoreError(a, b);
      if (e) { errEl.textContent = e; return; }
      saveScore(m, a, b);
    });
  }

  /** 與 GAS scoreError_ 相同的檢查：0 以上的整數即可 */
  function scoreError(sa, sb) {
    if (!isFinite(sa) || !isFinite(sb) || sa < 0 || sb < 0 || sa % 1 || sb % 1) return '比分要填 0 以上的整數';
    if (sa > 99 || sb > 99) return '比分太大，請確認';
    return '';
  }

  /** 先存在手機，再送出；斷線時留在「待上傳」，恢復連線後自動送出 */
  function saveScore(m, sa, sb) {
    const q = loadQueue();
    q[m.id] = { shiftId: state.shiftId, matchId: m.id, sa: sa, sb: sb, at: Date.now() };
    saveQueue(q);
    const g = gameOf(state.court);
    const idx = g.matches.findIndex((x) => x.id === m.id);
    const queued = loadQueue();
    const next = g.matches.slice(idx + 1).concat(g.matches.slice(0, idx))
      .find((x) => !x.done && !queued[x.id]);
    closeModal();
    drawSession();
    flushScores();
    if (next) openScore(next);
    else toast('這一面的比分都輸入完了', 'ok');
  }

  async function flushScores() {
    if (state.flushing) return;
    const q = loadQueue();
    const ids = Object.keys(q);
    if (!ids.length) return;
    state.flushing = true;
    let changed = false;
    try {
      for (const id of ids) {
        const item = q[id];
        try {
          const res = await api('saveScore', { shiftId: item.shiftId, matchId: item.matchId, sa: item.sa, sb: item.sb });
          removeQueued(id);
          changed = true;
          if (item.shiftId === state.shiftId) applyResult(res);
        } catch (e) {
          if (e.code === 'NETWORK' || e.code === 'BAD_RESPONSE') break; // 還是斷線，下次再送
          removeQueued(id);
          changed = true;
          toast('比分沒有存成功：' + e.message, 'error');
        }
      }
    } finally {
      state.flushing = false;
    }
    if (changed && state.page === 'checkin' && modal.hidden) drawSession();
  }

  function loadQueue() {
    try {
      return JSON.parse(localStorage.getItem(QUEUE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveQueue(q) {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    } catch (e) { /* 無法存在手機時仍會直接送出 */ }
  }

  function removeQueued(id) {
    const q = loadQueue();
    delete q[id];
    saveQueue(q);
  }

  /* ----- 積分 ----- */

  function drawRank() {
    const g = gameOf(state.court);
    let html = courtChips();
    if (!g || !g.standings.length) return html + '<div class="card muted">還沒有場次。</div>';
    html += `<div class="card rank">
      <div class="row"><div class="title">${esc(g.name)}</div><span class="muted">已完成 ${g.done}／${g.total} 場</span></div>
      <table>
        <thead><tr><th>#</th><th class="l">玩家</th><th>場</th><th>勝</th><th>敗</th><th>得</th><th>失</th><th>差</th></tr></thead>
        <tbody>${g.standings.map((x) => `<tr>
          <td>${x.rank}</td><td class="l">${esc(x.name)}</td><td>${x.played}</td><td><b>${x.win}</b></td><td>${x.lose}</td>
          <td>${x.pf}</td><td>${x.pa}</td><td class="${x.diff > 0 ? 'pos' : x.diff < 0 ? 'neg' : ''}">${x.diff > 0 ? '+' : ''}${x.diff}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="muted">排序：勝場 → 分差 → 得分。學員在學員帳號的球敘頁重新整理即可看到。</p>
    </div>`;
    return html;
  }

  /* ----- 動作 ----- */

  function onAction(ev) {
    const b = ev.currentTarget;
    const id = b.dataset.id;
    const r = state.roster;
    const person = r.people.find((p) => p.regId === id);
    const g = gameOf(state.court);

    switch (b.dataset.act) {
      case 'present': {
        // 先更新畫面，再送出；失敗時 rosterAct 會提示，並重新整理名單
        const now = new Date();
        person.attend = '出席';
        person.time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        drawSession();
        return rosterAct('checkin', { regId: id, attend: '出席' }, person.name + ' 已簽到')
          .then((res) => { if (!res) refreshRoster(true); });
      }
      case 'accept':
        return chooseCourt('接受 ' + person.name + ' 的現場報名', '會成立報名、建立應收並完成簽到。', person.court,
          (courtId) => rosterAct('walkin', { regId: id, decision: 'accept', courtId: courtId }, '已接受'));
      case 'decline':
        if (!confirm('婉拒 ' + person.name + ' 的現場報名？')) return null;
        return rosterAct('walkin', { regId: id, decision: 'decline' }, '已婉拒');
      case 'acceptWait': {
        const w = r.waitlist.find((x) => x.regId === id);
        return chooseCourt('讓候補的 ' + w.name + ' 上場', '會改為已報名、建立應收並完成簽到。', w.court,
          (courtId) => rosterAct('acceptWait', { regId: id, courtId: courtId }, '已接受上場'));
      }
      case 'collect':
        return openCollect(person);
      case 'more':
        return openMore(person);
      case 'generate': {
        const sel = document.getElementById('gGames');
        return rosterAct('generate', { courtId: state.court, games: sel ? Number(sel.value) : undefined });
      }
      case 'regen':
        if (!confirm('重新產生 ' + g.name + ' 的輪轉表？目前的場次會被取代。')) return null;
        return rosterAct('generate', { courtId: state.court, games: g.options.length > 1 ? g.total : undefined });
      case 'clear':
        if (!confirm('清除 ' + g.name + ' 的輪轉表？')) return null;
        return rosterAct('clearRotation', { courtId: state.court });
      case 'addMatch':
        return openMatchEditor(null);
      case 'editMatch':
        return openMatchEditor(g.matches.find((m) => m.id === id));
      case 'score':
        return openScore(g.matches.find((m) => m.id === id));
      default:
        return null;
    }
  }

  /** 選球面：只有一面時直接用 */
  function chooseCourt(title, note, preset, done) {
    const courts = state.roster.courts;
    if (courts.length <= 1) {
      if (!confirm(title + '？\n' + note)) return;
      done(courts.length ? courts[0].id : '');
      return;
    }
    modal.innerHTML = `
      <div class="sheet">
        <h2>${esc(title)}</h2>
        <p class="muted">${esc(note)}請選擇球面：</p>
        <div class="choice">${courts.map((c) => `<button class="btn ${c.id === preset ? '' : 'ghost'}" data-c="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>
        <div class="actions"><button class="btn ghost" id="mCancel">取消</button></div>
      </div>`;
    modal.hidden = false;
    document.getElementById('mCancel').addEventListener('click', closeModal);
    modal.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => done(b.dataset.c)));
  }

  /** 更多：換面、離場、取消簽到 */
  function openMore(p) {
    const r = state.roster;
    const present = p.attend === '出席';
    const g = r.game.find((x) => x.id === p.court);
    const hasTodo = g && g.matches.some((m) => !m.done);
    const others = r.courts.filter((c) => c.id !== p.court);
    modal.innerHTML = `
      <div class="sheet">
        <h2>${esc(p.name)}</h2>
        <p class="muted">${esc(p.courtName || '未分面')}　${present ? (p.left ? '已離場' : '在場') : '尚未簽到'}</p>
        ${others.length ? `<div class="group-title">換到其他面</div>
          ${p.inMatch
            ? '<p class="muted">他已排進這一面的輪轉表，不能換面。還沒有比分時先到「輪轉」清除；已有比分時請用下方「離場並重排」，再換面並取消離場。</p>'
            : `<div class="choice">${others.map((c) => `<button class="btn ghost" data-move="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</div>`}` : ''}
        <div class="group-title">中途離場</div>
        ${p.left
          ? '<button class="btn ghost block" id="mUndoLeave">取消離場</button>'
          : present
            ? (hasTodo
              ? `<button class="btn block" id="mLeaveRe">離場並重排剩餘場次</button>
                 <button class="btn ghost block" id="mLeave">只標記離場（之後自己改人）</button>
                 <p class="muted">重排：這一面未開始的場次會用剩下的人重新排；已完成的比分保留。</p>`
              : '<button class="btn ghost block" id="mLeave">標記離場</button>')
            : '<p class="muted">尚未簽到。</p>'}
        ${present && !p.left ? '<button class="btn ghost block" id="mUndoCheck">取消簽到（簽錯人時）</button>' : ''}
        <div class="actions"><button class="btn ghost" id="mCancel">關閉</button></div>
      </div>`;
    modal.hidden = false;
    const on = (sel, fn) => { const el = document.getElementById(sel); if (el) el.addEventListener('click', fn); };
    on('mCancel', closeModal);
    on('mUndoLeave', () => rosterAct('leave', { regId: p.regId, undo: true }));
    on('mLeaveRe', () => rosterAct('leave', { regId: p.regId, reschedule: true }));
    on('mLeave', () => rosterAct('leave', { regId: p.regId }));
    on('mUndoCheck', () => rosterAct('checkin', { regId: p.regId, attend: '未簽到' }, '已取消簽到'));
    modal.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () =>
      rosterAct('moveCourt', { regId: p.regId, courtId: b.dataset.move }, '已換到 ' + b.textContent)));
  }

  /** 補場（m＝null）或改人／刪除未開始的場次 */
  function openMatchEditor(m) {
    const g = gameOf(state.court);
    if (g.players.length < 4) { toast('這一面在場不到 4 人', 'error'); return; }
    const cur = m ? m.a.concat(m.b).map((x) => x.id) : g.players.slice(0, 4).map((x) => x.id);
    const sel = (i) => `<select data-slot="${i}">${g.players.map((p) =>
      `<option value="${esc(p.id)}" ${p.id === cur[i] ? 'selected' : ''}>${p.letter} ${esc(p.name)}</option>`).join('')}
      ${cur[i] && !g.players.some((p) => p.id === cur[i]) ? '<option value="" selected>（不在這一面，請換人）</option>' : ''}</select>`;
    modal.innerHTML = `
      <div class="sheet">
        <h2>${m ? '第 ' + m.round + ' 輪・第 ' + m.seq + ' 場' : '補一場（' + esc(g.name) + '）'}</h2>
        <div class="teamedit"><div><b>A 隊</b>${sel(0)}${sel(1)}</div><div><b>B 隊</b>${sel(2)}${sel(3)}</div></div>
        <div class="actions">
          ${m ? '<button class="btn ghost" id="eDel">刪除這一場</button>' : ''}
          <button class="btn ghost" id="eCancel">取消</button>
          <button class="btn" id="eOk">${m ? '儲存' : '新增'}</button>
        </div>
      </div>`;
    modal.hidden = false;
    document.getElementById('eCancel').addEventListener('click', closeModal);
    const del = document.getElementById('eDel');
    if (del) del.addEventListener('click', () => {
      if (!confirm('刪除這一場？')) return;
      rosterAct('deleteMatch', { matchId: m.id });
    });
    document.getElementById('eOk').addEventListener('click', () => {
      const players = Array.from(modal.querySelectorAll('[data-slot]')).map((s) => s.value);
      if (new Set(players).size !== 4 || players.some((x) => !x)) { toast('四位選手不可重複', 'error'); return; }
      if (m) rosterAct('editMatch', { matchId: m.id, players: players });
      else rosterAct('addMatch', { courtId: state.court, players: players });
    });
  }

  function openCollect(p) {
    const methods = state.roster.payMethods;
    modal.innerHTML = `
      <div class="sheet">
        <h2>收款：${esc(p.name)}</h2>
        <p class="muted">應收 ${money(p.due)}　已收 ${money(p.paid)}　未收 <b>${money(p.unpaid)}</b></p>
        <label>金額<input id="cAmount" type="number" inputmode="numeric" min="1" value="${p.unpaid}"></label>
        <label>付款方式
          <select id="cMethod">${methods.map((m) => `<option>${esc(m)}</option>`).join('')}</select>
        </label>
        <label id="cLast5Wrap" hidden>帳號末五碼<input id="cLast5" inputmode="numeric" maxlength="5"></label>
        <label>備註<input id="cNote" maxlength="200"></label>
        <p class="muted">送出後為「待確認」，由營運對帳後確認。</p>
        <div class="actions">
          <button class="btn ghost" id="cCancel">取消</button>
          <button class="btn" id="cOk">確認收款</button>
        </div>
      </div>`;
    modal.hidden = false;
    const method = document.getElementById('cMethod');
    method.addEventListener('change', () => {
      document.getElementById('cLast5Wrap').hidden = method.value !== '轉帳';
    });
    document.getElementById('cCancel').addEventListener('click', closeModal);
    document.getElementById('cOk').addEventListener('click', () => rosterAct('collect', {
      regId: p.regId,
      amount: document.getElementById('cAmount').value,
      method: method.value,
      last5: document.getElementById('cLast5').value,
      note: document.getElementById('cNote').value,
    }, '已記錄收款'));
  }

  function closeModal() {
    modal.hidden = true;
    modal.innerHTML = '';
  }

  /** 抓完整名單（force＝不管是否有視窗開著） */
  async function refreshRoster(force) {
    if (!state.shiftId || (!force && (state.busy || !modal.hidden))) return;
    try {
      state.roster = await api('roster', { shiftId: state.shiftId });
      saveSnap();
      if (state.page === 'checkin' && modal.hidden) drawSession();
    } catch (e) {
      if (e.code === 'AUTH_EXPIRED') { stopPoll(); toast(e.message, 'error'); }
    }
  }

  /** 30 秒輪詢：先比對簽章（只讀報名與對戰），有變動或每 5 次才抓完整名單 */
  async function pollRoster(now) {
    if (state.busy || !modal.hidden || !state.shiftId || !state.roster) return;
    state.pollCount += 1;
    if (!now && state.pollCount % FULL_EVERY === 0) return refreshRoster();
    try {
      const r = await api('poll', { shiftId: state.shiftId, sig: state.roster.sig });
      if (r.changed) refreshRoster();
    } catch (e) {
      if (e.code === 'AUTH_EXPIRED') { stopPoll(); toast(e.message, 'error'); }
    }
  }

  /** 學員會用據點 QR 自助簽到，名單每 30 秒檢查一次 */
  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') pollRoster();
    }, POLL_MS);
  }

  function stopPoll() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /* ---------- 收班回報 ---------- */

  async function renderReport() {
    let r;
    try {
      const shiftId = await pickShift('report');
      if (!shiftId) return;
      if (!state.roster || state.roster.shift.shiftId !== shiftId || state.stale) {
        loading();
        state.roster = await api('roster', { shiftId: shiftId });
        saveSnap();
      }
      r = state.roster;
    } catch (e) {
      state.shiftId = '';
      return showFatal(e);
    }
    const s = r.session;
    const sh = r.shift;
    const sum = r.summary;
    const notDone = r.game.reduce((n, g) => n + (g.total - g.done), 0);

    app.innerHTML = `
      <h1>收班回報</h1>
      <div class="card head">
        <div class="title">${esc(s.name)}</div>
        <div class="muted">${esc(s.date)}　${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
        ${notDone ? `<p class="warn-text">還有 ${notDone} 場沒有比分；沒打的場次可在「輪轉」刪除。</p>` : ''}
      </div>
      <form id="fReport" class="card form">
        <div class="cashbox">
          <div>系統記錄：我收的現金 <b>${money(sum.systemCash)}</b></div>
          <div class="muted">全部收款（含轉帳等）${money(sum.systemTotal)}</div>
        </div>
        <label>實際交接現金<input name="cash" type="number" inputmode="numeric" min="0" value="${esc(sh.cash)}" placeholder="${sum.systemCash}"></label>
        <div id="cashDiff" class="muted"></div>
        ${r.fields.newcomers ? `<label>新人接待人數<input name="newcomers" type="number" inputmode="numeric" min="0" value="${esc(sh.newcomers === '' ? sum.newcomers : sh.newcomers)}"></label>` : ''}
        <label>球具狀況
          <select name="equip">
            <option value="">請選擇</option>
            ${r.equipOptions.map((o) => `<option ${o === sh.equip ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select>
        </label>
        <label>場地異常<textarea name="venueIssue" rows="2" placeholder="沒有可留空">${esc(sh.venueIssue)}</textarea></label>
        <label>現場問題<textarea name="issue" rows="3" placeholder="例如學員反映、受傷、爭議">${esc(sh.issue)}</textarea></label>
        <p class="muted">球具異常、場地異常、現場問題或現金差異，送出後會通知總場主。</p>
        <button class="btn block" type="submit" ${s.editable ? '' : 'disabled'}>送出回報</button>
      </form>`;

    const form = document.getElementById('fReport');
    const diff = document.getElementById('cashDiff');
    const showDiff = () => {
      const v = form.cash.value;
      if (v === '') { diff.textContent = ''; return; }
      const d = Number(v) - sum.systemCash;
      diff.textContent = d === 0 ? '✓ 與系統相符' : '與系統差 ' + (d > 0 ? '+' : '') + d + ' 元，請在現場問題說明原因';
      diff.className = d === 0 ? 'ok-text' : 'warn-text';
    };
    form.cash.addEventListener('input', showDiff);
    showDiff();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const res = await act(() => api('report', {
        shiftId: state.shiftId,
        cash: form.cash.value,
        newcomers: form.newcomers ? form.newcomers.value : '',
        equip: form.equip.value,
        venueIssue: form.venueIssue.value,
        issue: form.issue.value,
      }), '回報已送出');
      if (res) applyResult(res);
    });
  }

  /* ---------- 我的資料（註冊／修改） ---------- */

  function renderProfile(isRegister) {
    const p = state.me.profile || {};
    app.innerHTML = `
      <h1>${isRegister ? '場主註冊' : '我的資料'}</h1>
      <form id="fProfile" class="card form">
        ${isRegister ? '<p class="muted">送出後由總場主審核，核准後即可使用排班與點名。</p>' : ''}
        <label>姓名<input name="name" required maxlength="20" value="${esc(p.name || state.me.lineName || '')}" ${isRegister ? '' : 'disabled'}></label>
        <label>手機<input name="phone" type="tel" inputmode="tel" required placeholder="0912345678" value="${esc(p.phone || '')}"></label>
        <label>Email<input name="email" type="email" required placeholder="常用的 Gmail" value="${esc(p.email || '')}"></label>
        ${isRegister ? '' : '<p class="muted">姓名、角色與費率由管理員設定，需要修改請在聊天室告訴總場主。</p>'}
        <button class="btn block" type="submit">${isRegister ? '送出註冊' : '儲存'}</button>
      </form>`;

    const form = document.getElementById('fProfile');
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = { name: form.name.value, phone: form.phone.value, email: form.email.value };
      if (isRegister) {
        const res = await act(() => api('register', data), '已送出');
        if (res) { state.me = await api('me'); saveSnap(); route(); }
      } else {
        const res = await act(() => api('updateProfile', data), '已儲存');
        if (res) { state.me = res; saveSnap(); }
      }
    });
  }

  boot();
})();
