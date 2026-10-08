/**
 * venue/app.js — 場主 LIFF 頁面
 * 頁面：shifts 我的排班／checkin 現場簽到／report 收班回報／profile 我的資料
 * 網址：https://liff.line.me/{LIFF_ID}?page=checkin（可加 &shift=排班ID）
 */
(function () {
  'use strict';

  const { esc, toast, money } = LiffKit;
  const CFG = window.APP_CONFIG || {};
  const PAGES = ['shifts', 'checkin', 'report', 'profile'];
  const POLL_MS = 30000;

  const state = { me: null, page: 'shifts', shiftId: '', roster: null, pollTimer: null, busy: false };
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const tabs = document.getElementById('tabs');

  const api = (action, data) => LiffKit.call(CFG.GAS_URL, action, data);

  /* ---------- 啟動 ---------- */

  async function boot() {
    try {
      await LiffKit.init(CFG.LIFF_ID);
      const p = LiffKit.params();
      state.page = PAGES.indexOf(p.get('page')) >= 0 ? p.get('page') : 'shifts';
      state.shiftId = p.get('shift') || '';
      state.me = await api('me');
      document.getElementById('who').textContent = state.me.profile ? state.me.profile.name : state.me.lineName;
      route();
    } catch (e) {
      showFatal(e);
    }
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
    if (s === 'pending') return renderNotice('審核中', '資料已送出，總場主核准後就能使用排班與簽到。核准後重新開啟即可。');
    if (s === 'inactive') return renderNotice('帳號停用', '你的帳號目前停用，如有疑問請直接在聊天室留言給總場主。');

    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.page === state.page));
    if (state.page === 'shifts') return renderShifts();
    if (state.page === 'checkin') return renderCheckin();
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
    app.innerHTML = '<div class="loading">' + esc(text || '載入中…') + '</div>';
  }

  /** 執行寫入動作：防止連點，錯誤統一提示 */
  async function act(fn, okMsg) {
    if (state.busy) return null;
    state.busy = true;
    document.body.classList.add('busy');
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, 'ok');
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

  /* ---------- 我的排班 ---------- */

  async function renderShifts() {
    loading();
    let list;
    try {
      list = await api('myShifts');
    } catch (e) {
      return showFatal(e);
    }
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
          <button class="btn" data-go="checkin" data-shift="${esc(s.shiftId)}">現場簽到</button>
          <button class="btn ghost" data-go="report" data-shift="${esc(s.shiftId)}">收班回報</button>
        </div>` : ''}
      </div>`).join('');

    app.querySelectorAll('[data-go]').forEach((b) =>
      b.addEventListener('click', () => go(b.dataset.go, b.dataset.shift)));
  }

  /** 沒有指定排班時：今天只有一場就直接用，多場就讓人選 */
  async function pickShift(page) {
    if (state.shiftId) return state.shiftId;
    loading();
    const list = (await api('myShifts')).filter((s) => s.editable && s.sessionStatus !== '取消');
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

  /* ---------- 現場簽到 ---------- */

  async function renderCheckin() {
    let shiftId;
    try {
      shiftId = await pickShift('checkin');
      if (!shiftId) return;
      loading();
      state.roster = await api('roster', { shiftId: shiftId });
    } catch (e) {
      state.shiftId = '';
      return showFatal(e);
    }
    drawRoster();
    startPoll();
  }

  function drawRoster() {
    const r = state.roster;
    const s = r.session;
    const sum = r.summary;
    const arrived = r.shift.arrive === '已到場' || r.shift.arrive === '遲到';
    const can = s.editable;

    app.innerHTML = `
      <div class="card head">
        <div class="title">${esc(s.name)}</div>
        <div class="muted">${esc(s.date)}　${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
        <div class="stats">
          <div><b>${sum.present}</b><span>已簽到</span></div>
          <div><b>${sum.registered}</b><span>報名／上限 ${s.capacity || '—'}</span></div>
          <div><b>${sum.walkinPending}</b><span>待確認</span></div>
          <div><b>${money(sum.systemTotal)}</b><span>我收的款</span></div>
        </div>
        ${arrived
          ? `<div class="arrived">✓ ${esc(r.shift.arrive)}　${esc(r.shift.arriveTime)}</div>`
          : can ? '<button class="btn block" id="btnArrive">我已到場</button>' : ''}
        ${!can ? '<p class="muted">此場次目前不可修改（只能在球敘當天或隔天操作）。</p>' : ''}
      </div>
      <div class="listhead">
        <span>名單（${r.people.length}）</span>
        <button class="link" id="btnRefresh">重新整理</button>
      </div>
      ${r.people.length ? r.people.map((p) => personRow(p, can)).join('') : '<div class="card muted">目前沒有報名者</div>'}
      ${sum.waitlist ? `<p class="muted center">另有候補 ${sum.waitlist} 人（由系統自動遞補）</p>` : ''}
    `;

    const btnArrive = document.getElementById('btnArrive');
    if (btnArrive) btnArrive.addEventListener('click', async () => {
      const res = await act(() => api('arrive', { shiftId: state.shiftId }), '已記錄到場');
      if (res) { state.roster = res; drawRoster(); }
    });
    document.getElementById('btnRefresh').addEventListener('click', refreshRoster);
    app.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', onPersonAction));
  }

  function personRow(p, can) {
    const pending = p.status === '現場待確認';
    const present = p.attend === '出席';
    const tags = [
      pending ? '<span class="tag orange">現場待確認</span>' : '',
      p.isNew ? '<span class="tag blue">新人</span>' : '',
      p.isFree ? '<span class="tag">免費體驗</span>' : '',
      p.source === '現場' && !pending ? '<span class="tag">現場</span>' : '',
    ].join('');
    const pay = !p.hasAr ? '' : p.unpaid > 0
      ? `<span class="due">未收 ${money(p.unpaid)}</span>`
      : `<span class="paid">已收清</span>`;

    let buttons = '';
    if (can && pending) {
      buttons = `
        <button class="btn sm" data-act="accept" data-id="${esc(p.regId)}">接受</button>
        <button class="btn sm ghost" data-act="decline" data-id="${esc(p.regId)}">婉拒</button>`;
    } else if (can) {
      buttons = present
        ? `<button class="btn sm ghost" data-act="undo" data-id="${esc(p.regId)}">取消簽到</button>`
        : `<button class="btn sm" data-act="present" data-id="${esc(p.regId)}">簽到</button>`;
      if (p.hasAr && p.unpaid > 0) buttons += `<button class="btn sm amber" data-act="collect" data-id="${esc(p.regId)}">收款</button>`;
    }

    return `
      <div class="card person ${present ? 'present' : ''} ${pending ? 'pending' : ''}">
        <div class="row">
          <div>
            <div class="name">${esc(p.name)} ${tags}</div>
            <div class="muted">${present ? '✓ ' + esc(p.time) + ' 簽到' : pending ? '超過上限的現場報名' : '尚未簽到'}　${pay}</div>
          </div>
          <div class="btns">${buttons}</div>
        </div>
      </div>`;
  }

  async function onPersonAction(ev) {
    const b = ev.currentTarget;
    const regId = b.dataset.id;
    const person = state.roster.people.find((p) => p.regId === regId);
    const shiftId = state.shiftId;
    let res = null;

    switch (b.dataset.act) {
      case 'present':
        res = await act(() => api('checkin', { shiftId, regId, attend: '出席' }), person.name + ' 已簽到');
        break;
      case 'undo':
        if (!confirm('取消 ' + person.name + ' 的簽到？')) return;
        res = await act(() => api('checkin', { shiftId, regId, attend: '未簽到' }), '已取消簽到');
        break;
      case 'accept':
        if (!confirm('接受 ' + person.name + ' 的現場報名？\n會成立報名、建立應收並完成簽到。')) return;
        res = await act(() => api('walkin', { shiftId, regId, decision: 'accept' }), '已接受');
        break;
      case 'decline':
        if (!confirm('婉拒 ' + person.name + ' 的現場報名？')) return;
        res = await act(() => api('walkin', { shiftId, regId, decision: 'decline' }), '已婉拒');
        break;
      case 'collect':
        return openCollect(person);
      default:
        return;
    }
    if (res) { state.roster = res; drawRoster(); }
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
    document.getElementById('cOk').addEventListener('click', async () => {
      const res = await act(() => api('collect', {
        shiftId: state.shiftId,
        regId: p.regId,
        amount: document.getElementById('cAmount').value,
        method: method.value,
        last5: document.getElementById('cLast5').value,
        note: document.getElementById('cNote').value,
      }), '已記錄收款');
      if (res) { closeModal(); state.roster = res; drawRoster(); }
    });
  }

  function closeModal() {
    modal.hidden = true;
    modal.innerHTML = '';
  }

  async function refreshRoster() {
    if (state.busy || !modal.hidden) return;
    try {
      state.roster = await api('roster', { shiftId: state.shiftId });
      if (state.page === 'checkin') drawRoster();
    } catch (e) {
      if (e.code === 'AUTH_EXPIRED') { stopPoll(); toast(e.message, 'error'); }
    }
  }

  /** 學員會用據點 QR 自助簽到，名單每 30 秒自動更新 */
  function startPoll() {
    stopPoll();
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshRoster();
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
      loading();
      r = state.roster = await api('roster', { shiftId: shiftId });
    } catch (e) {
      state.shiftId = '';
      return showFatal(e);
    }
    const s = r.session;
    const sh = r.shift;
    const sum = r.summary;

    app.innerHTML = `
      <h1>收班回報</h1>
      <div class="card head">
        <div class="title">${esc(s.name)}</div>
        <div class="muted">${esc(s.date)}　${esc(s.start)}–${esc(s.end)}　${esc(s.venue)}</div>
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
      if (res) state.roster = res;
    });
  }

  /* ---------- 我的資料（註冊／修改） ---------- */

  function renderProfile(isRegister) {
    const p = state.me.profile || {};
    app.innerHTML = `
      <h1>${isRegister ? '場主註冊' : '我的資料'}</h1>
      <form id="fProfile" class="card form">
        ${isRegister ? '<p class="muted">送出後由總場主審核，核准後即可使用排班與簽到。</p>' : ''}
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
        if (res) { state.me = await api('me'); route(); }
      } else {
        const res = await act(() => api('updateProfile', data), '已儲存');
        if (res) state.me = res;
      }
    });
  }

  boot();
})();
