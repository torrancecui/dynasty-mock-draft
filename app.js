/* Dynasty Mock Draft Simulator */
(function () {
  'use strict';

  const DATA = window.DMD_DATA;
  const SOURCES = [
    { key: 'ktc', ...DATA.sources.ktc },
    { key: 'fp', ...DATA.sources.fp },
    { key: 'fc', ...DATA.sources.fc },
    { key: 'esp', ...DATA.sources.esp },
    { key: 'slp', ...DATA.sources.slp },
  ];
  const CPU_PICK_MS = 500;

  // ---------- state ----------
  let settings = null; // {sourceKey, teams, rounds, order, speed, userSlot}
  let draft = null; // active draft state
  let cpuTimer = null;

  const $ = (id) => document.getElementById(id);

  // ================= SETUP SCREEN =================
  let selectedSource = 'ktc';

  function initSetup() {
    $('data-badge').textContent =
      `KTC & FantasyPros data fetched live ${DATA.generated} · ${DATA.players.length} players`;

    const grid = $('source-grid');
    const cards = [...SOURCES, { key: 'mix', name: 'Mixed', real: null, note: 'Each CPU team is randomly assigned one of the four sources.' }];
    grid.innerHTML = '';
    for (const s of cards) {
      const btn = document.createElement('button');
      btn.className = 'source-card' + (s.key === selectedSource ? ' selected' : '');
      const tag =
        s.real === true ? '<span class="sc-tag live">LIVE DATA</span>'
        : s.real === false ? '<span class="sc-tag approx">APPROX</span>'
        : '<span class="sc-tag mix">MIXED</span>';
      btn.innerHTML = `<div class="sc-name">${s.name}</div>${tag}`;
      btn.addEventListener('click', () => {
        selectedSource = s.key;
        grid.querySelectorAll('.source-card').forEach((c) => c.classList.remove('selected'));
        btn.classList.add('selected');
        $('source-note').textContent = s.note;
      });
      grid.appendChild(btn);
    }
    $('source-note').textContent = SOURCES[0].note;

    $('set-rounds').innerHTML = Array.from({ length: 21 }, (_, i) => {
      const r = i + 5;
      return `<option value="${r}"${r === 15 ? ' selected' : ''}>${r}</option>`;
    }).join('');

    const refreshSlots = () => {
      const n = +$('set-teams').value;
      const sel = $('set-slot');
      const prev = sel.value;
      sel.innerHTML = '<option value="rand">Random</option>' +
        Array.from({ length: n }, (_, i) => `<option value="${i + 1}">Slot ${i + 1}</option>`).join('');
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    };
    $('set-teams').addEventListener('change', refreshSlots);
    refreshSlots();

    $('start-btn').addEventListener('click', startDraft);
  }

  // ================= DRAFT ENGINE =================
  function buildPickOrder(teams, rounds, orderType) {
    const order = [];
    for (let r = 0; r < rounds; r++) {
      let seq = Array.from({ length: teams }, (_, i) => i);
      if (orderType === 'snake' && r % 2 === 1) seq.reverse();
      if (orderType === '3rr') {
        // rounds 1: forward, 2: reverse, 3: reverse again, then alternate
        const rev = r === 0 ? false : r === 1 || r === 2 ? true : r % 2 === 1 ? false : true;
        if (rev) seq.reverse();
      }
      for (const t of seq) order.push({ round: r + 1, team: t });
    }
    return order;
  }

  function startDraft() {
    const teams = +$('set-teams').value;
    const rounds = +$('set-rounds').value;
    const slotVal = $('set-slot').value;
    settings = {
      sourceKey: selectedSource,
      teams,
      rounds,
      order: $('set-order').value,
      userSlot: slotVal === 'rand' ? Math.floor(Math.random() * teams) : +slotVal - 1,
    };

    // assign a ranking source to each team
    const teamSources = [];
    for (let t = 0; t < teams; t++) {
      teamSources.push(
        settings.sourceKey === 'mix'
          ? SOURCES[Math.floor(Math.random() * SOURCES.length)].key
          : settings.sourceKey
      );
    }

    // per-CPU positional tendencies for personality
    const tendencies = [];
    for (let t = 0; t < teams; t++) {
      tendencies.push({
        QB: 0.92 + Math.random() * 0.16,
        RB: 0.92 + Math.random() * 0.16,
        WR: 0.92 + Math.random() * 0.16,
        TE: 0.92 + Math.random() * 0.16,
      });
    }

    draft = {
      pickOrder: buildPickOrder(teams, rounds, settings.order),
      picks: [], // {pickNo, round, slot, team, player}
      rosters: Array.from({ length: teams }, () => []),
      available: new Set(DATA.players.map((p) => p.id)),
      cur: 0,
      teamSources,
      tendencies,
      done: false,
    };

    $('setup-screen').classList.add('hidden');
    $('draft-screen').classList.remove('hidden');
    $('results-modal').classList.add('hidden');
    $('autopick-cb').checked = false;
    $('search-input').value = '';
    activePos = 'ALL';
    document.querySelectorAll('#pos-chips .chip').forEach((c) =>
      c.classList.toggle('active', c.dataset.pos === 'ALL'));

    const srcName = settings.sourceKey === 'mix' ? 'Mixed' : SOURCES.find((s) => s.key === settings.sourceKey).name;
    $('dh-settings').textContent =
      `${teams}-team · ${rounds} rds · ${{ snake: 'Snake', '3rr': '3RR', linear: 'Linear' }[settings.order]} · SF 0.5 TEP · CPU: ${srcName} · You: slot ${settings.userSlot + 1}`;

    initViewSourceSelect();
    initTeamsSelect();
    renderAll();
    scheduleNext();
  }

  const byId = new Map(DATA.players.map((p) => [p.id, p]));

  function teamName(t) {
    return t === settings.userSlot ? 'You' : `Team ${t + 1}`;
  }

  function pickLabel(idx) {
    const po = draft.pickOrder[idx];
    const slotInRound = idx % settings.teams;
    return `${po.round}.${String(slotInRound + 1).padStart(2, '0')}`;
  }

  // ---------- CPU pick logic ----------
  function rosterCounts(team) {
    const c = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pk of draft.rosters[team]) c[byId.get(pk).pos]++;
    return c;
  }

  function needMultiplier(pos, counts, round, totalRounds) {
    let m = 1;
    if (pos === 'QB') {
      // superflex: 2 QBs are near-mandatory, 3rd is a luxury
      if (counts.QB >= 4) m = 0.05;
      else if (counts.QB === 3) m = 0.3;
      else if (counts.QB === 2) m = 0.8;
      else if (counts.QB < 2 && round > totalRounds * 0.75) m = 3.2;
      else if (counts.QB === 0 && round > 3) m = 1.9;
      else if (counts.QB < 2 && round > totalRounds * 0.5) m = 1.5;
    } else if (pos === 'TE') {
      if (counts.TE >= 3) m = 0.1;
      else if (counts.TE === 2) m = 0.4;
      else if (counts.TE === 1) m = 0.75;
      else if (counts.TE === 0 && round > totalRounds * 0.5) m = 1.3;
    } else {
      const cap = Math.max(5, Math.round(totalRounds * 0.5));
      if (counts[pos] >= cap) m = 0.5;
    }
    // needs ramp in after the first few rounds — early is mostly best-player-available
    const ramp = Math.min(1, round / 4);
    return 1 + (m - 1) * ramp;
  }

  function adjustedValue(player, team, srcKey) {
    const counts = rosterCounts(team);
    const round = draft.pickOrder[draft.cur].round;
    let v = player.vals[srcKey];
    v *= needMultiplier(player.pos, counts, round, settings.rounds);
    v *= draft.tendencies[team][player.pos];
    return v;
  }

  function cpuChoose(team) {
    const srcKey = draft.teamSources[team];
    const avail = [];
    for (const id of draft.available) avail.push(byId.get(id));
    avail.sort((a, b) => b.vals[srcKey] - a.vals[srcKey]);

    // score a wider window by NEED-ADJUSTED value so scarce positions can surface,
    // then keep the best 12 as realistic candidates
    const candidates = avail
      .slice(0, 40)
      .map((p) => ({ p, adj: adjustedValue(p, team, srcKey) }))
      .sort((a, b) => b.adj - a.adj)
      .slice(0, 12)
      .map((c) => ({ ...c, w: Math.pow(Math.max(c.adj, 1), 5) }));
    // mild preference for earlier board position
    candidates.forEach((c, i) => (c.w *= Math.pow(0.87, i)));

    const total = candidates.reduce((s, c) => s + c.w, 0);
    let roll = Math.random() * total;
    for (const c of candidates) {
      roll -= c.w;
      if (roll <= 0) return c.p;
    }
    return candidates[0].p;
  }

  function userAutoChoose() {
    const srcKey = settings.sourceKey === 'mix' ? 'ktc' : settings.sourceKey;
    let best = null;
    let bestV = -1;
    for (const id of draft.available) {
      const p = byId.get(id);
      const v = adjustedValue(p, settings.userSlot, srcKey);
      if (v > bestV) { bestV = v; best = p; }
    }
    return best;
  }

  function applyPick(player) {
    const po = draft.pickOrder[draft.cur];
    draft.picks.push({
      idx: draft.cur,
      label: pickLabel(draft.cur),
      round: po.round,
      team: po.team,
      player,
    });
    draft.rosters[po.team].push(player.id);
    draft.available.delete(player.id);
    draft.cur++;
    if (draft.cur >= draft.pickOrder.length) draft.done = true;
  }

  function makePick(player) {
    applyPick(player);
    renderAll();
    if (draft.done) {
      showResults();
      return;
    }
    scheduleNext();
  }

  function scheduleNext() {
    clearTimeout(cpuTimer);
    if (draft.done) return;
    const po = draft.pickOrder[draft.cur];
    const isUser = po.team === settings.userSlot;
    if (isUser && !$('autopick-cb').checked) return; // wait for the human
    const delay = isUser ? 350 : CPU_PICK_MS;
    cpuTimer = setTimeout(() => {
      const player = isUser ? userAutoChoose() : cpuChoose(po.team);
      makePick(player);
    }, delay);
  }

  // ================= RENDERING =================
  let activePos = 'ALL';

  function initViewSourceSelect() {
    const sel = $('view-source');
    sel.innerHTML = SOURCES.map((s) => `<option value="${s.key}">${s.name}</option>`).join('');
    sel.value = settings.sourceKey === 'mix' ? 'ktc' : settings.sourceKey;
  }

  function renderAll() {
    renderStatus();
    renderTicker();
    renderPlayers();
    renderBoard();
    renderMyTeam();
    renderTeamsTab();
  }

  function renderStatus() {
    const el = $('dh-status');
    if (draft.done) {
      el.innerHTML = 'Draft complete';
      return;
    }
    const po = draft.pickOrder[draft.cur];
    const label = pickLabel(draft.cur);
    if (po.team === settings.userSlot) {
      el.innerHTML = `Pick ${label} — <span class="on-clock">You're on the clock!</span>`;
    } else {
      el.innerHTML = `Pick ${label} — ${teamName(po.team)} is picking…`;
    }
  }

  function renderTicker() {
    const el = $('ticker');
    const html = [];
    const start = Math.max(0, draft.cur - 6);
    const end = Math.min(draft.pickOrder.length, draft.cur + 8);
    for (let i = start; i < end; i++) {
      const po = draft.pickOrder[i];
      const pick = draft.picks[i];
      const cls = ['tick'];
      if (i === draft.cur && !draft.done) cls.push('current');
      if (po.team === settings.userSlot) cls.push('user-tick');
      html.push(`<div class="${cls.join(' ')}">
        <div class="t-pick">${pickLabel(i)} · ${teamName(po.team)}</div>
        ${pick
          ? `<div class="t-name">${pick.player.n}</div><div class="t-sub">${pick.player.pos} · ${pick.player.tm}</div>`
          : `<div class="t-name" style="color:var(--text-dim)">—</div><div class="t-sub">${i === draft.cur ? 'on the clock' : 'upcoming'}</div>`}
      </div>`);
    }
    el.innerHTML = html.join('');
    const curEl = el.querySelector('.tick.current');
    if (curEl) el.scrollLeft = curEl.offsetLeft - el.clientWidth / 2 + curEl.clientWidth / 2;
  }

  function renderPlayers() {
    const srcKey = $('view-source').value || 'ktc';
    const q = $('search-input').value.trim().toLowerCase();
    const tbody = $('player-tbody');
    const userTurn = !draft.done && draft.pickOrder[draft.cur].team === settings.userSlot;

    const list = [];
    for (const id of draft.available) list.push(byId.get(id));
    list.sort((a, b) => a.ranks[srcKey] - b.ranks[srcKey]);

    const rows = [];
    let shown = 0;
    for (const p of list) {
      if (activePos === 'RK' ? !p.rk : activePos !== 'ALL' && p.pos !== activePos) continue;
      if (q && !p.n.toLowerCase().includes(q)) continue;
      if (++shown > 220) break;
      rows.push(`<tr>
        <td class="col-rank">${p.ranks[srcKey]}</td>
        <td>
          <div class="p-name"><span class="pos-badge pos-${p.pos}">${p.pos}</span>${p.n}${p.rk ? '<span class="rookie-badge">R</span>' : ''}</div>
          <div class="p-sub">${p.tm}${p.age ? '' : ''}</div>
        </td>
        <td class="col-age">${p.age ?? '–'}</td>
        <td class="col-val">${p.vals[srcKey].toLocaleString()}</td>
        <td class="col-act"><button class="draft-btn" data-id="${p.id}" ${userTurn ? '' : 'disabled'}>Draft</button></td>
      </tr>`);
    }
    tbody.innerHTML = rows.join('') ||
      '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px">No players match</td></tr>';
  }

  function renderBoard() {
    const el = $('board-scroll');
    const T = settings.teams;
    const R = settings.rounds;
    // header
    let html = '<table class="board-table"><thead><tr><th class="round-label"></th>';
    for (let t = 0; t < T; t++) {
      html += `<th class="${t === settings.userSlot ? 'user-col' : ''}">${teamName(t)}</th>`;
    }
    html += '</tr></thead><tbody>';

    // map pickIdx -> cell content, arranged by round/team
    const pickByRoundTeam = {};
    draft.pickOrder.forEach((po, i) => (pickByRoundTeam[po.round + '|' + po.team] = i));

    for (let r = 1; r <= R; r++) {
      html += `<tr><td class="round-label">R${r}</td>`;
      for (let t = 0; t < T; t++) {
        const idx = pickByRoundTeam[r + '|' + t];
        const pick = draft.picks[idx];
        const isCur = idx === draft.cur && !draft.done;
        if (pick) {
          const p = pick.player;
          html += `<td class="bcell f-${p.pos}">
            <div class="bc-pick">${pick.label}</div>
            <div class="bc-name">${p.n}</div>
            <div class="bc-sub">${p.pos} · ${p.tm}</div></td>`;
        } else {
          html += `<td class="bcell${isCur ? ' on-clock-cell' : ''}">
            <div class="bc-pick">${pickLabel(idx)}</div></td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  function rosterHTML(team) {
    const groups = { QB: [], RB: [], WR: [], TE: [] };
    for (const pick of draft.picks) {
      if (pick.team === team) groups[pick.player.pos].push(pick);
    }
    const posColors = { QB: 'var(--qb)', RB: 'var(--rb)', WR: 'var(--wr)', TE: 'var(--te)' };
    let html = '<div class="roster-view">';
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      html += `<div class="roster-pos-group">
        <div class="roster-pos-title" style="color:${posColors[pos]}">${pos} (${groups[pos].length})</div>`;
      if (!groups[pos].length) html += '<div class="roster-empty">None yet</div>';
      for (const pk of groups[pos]) {
        html += `<div class="roster-row"><span>${pk.player.n}</span>
          <span class="rr-meta">${pk.player.tm} · Pick ${pk.label}</span></div>`;
      }
      html += '</div>';
    }
    return html + '</div>';
  }

  function renderMyTeam() {
    $('tab-myteam').innerHTML = rosterHTML(settings.userSlot);
  }

  function initTeamsSelect() {
    const sel = $('teams-select');
    sel.innerHTML = Array.from({ length: settings.teams }, (_, t) =>
      `<option value="${t}">${teamName(t)}</option>`).join('');
    sel.value = String(settings.userSlot);
  }

  function renderTeamsTab() {
    const t = +$('teams-select').value;
    const srcName = SOURCES.find((s) => s.key === draft.teamSources[t]).name;
    const note = t === settings.userSlot
      ? ''
      : `<div class="roster-team-note">CPU drafting from: <b>${srcName}</b> rankings</div>`;
    $('teams-roster').innerHTML = note + rosterHTML(t);
  }

  // ---------- results ----------
  function showResults() {
    const totals = [];
    for (let t = 0; t < settings.teams; t++) {
      const total = draft.rosters[t].reduce((s, id) => s + byId.get(id).vals.ktc, 0);
      totals.push({ t, total });
    }
    totals.sort((a, b) => b.total - a.total);
    const medals = ['🥇', '🥈', '🥉'];
    let html = '<p style="color:var(--text-dim);font-size:13px;margin-bottom:12px">Rosters ranked by total market value (KTC superflex 0.5 TEP)</p>';
    totals.forEach((row, i) => {
      html += `<div class="grade-row${row.t === settings.userSlot ? ' user-row' : ''}">
        <span>${medals[i] || `${i + 1}.`} <b>${teamName(row.t)}</b></span>
        <span class="gr-val">${row.total.toLocaleString()}</span></div>`;
    });
    $('results-body').innerHTML = html;
    $('results-modal').classList.remove('hidden');
  }

  function exportCSV() {
    const lines = ['Pick,Round,Team,Player,Position,NFL Team,Age'];
    for (const pk of draft.picks) {
      lines.push([pk.label, pk.round, teamName(pk.team), `"${pk.player.n}"`, pk.player.pos, pk.player.tm, pk.player.age ?? ''].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mock-draft-${DATA.generated}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ================= EVENTS =================
  function initDraftRoomEvents() {
    $('player-tbody').addEventListener('click', (e) => {
      const btn = e.target.closest('.draft-btn');
      if (!btn || btn.disabled) return;
      const po = draft.pickOrder[draft.cur];
      if (draft.done || po.team !== settings.userSlot) return;
      makePick(byId.get(+btn.dataset.id));
    });

    const rerenderFromTop = () => {
      document.querySelector('.player-table-wrap').scrollTop = 0;
      renderPlayers();
    };
    $('search-input').addEventListener('input', rerenderFromTop);
    $('view-source').addEventListener('change', rerenderFromTop);

    $('pos-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      activePos = chip.dataset.pos;
      document.querySelectorAll('#pos-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      document.querySelector('.player-table-wrap').scrollTop = 0;
      renderPlayers();
    });

    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
        for (const name of ['board', 'myteam', 'teams']) {
          $('tab-' + name).classList.toggle('hidden', tab.dataset.tab !== name);
        }
      });
    });

    $('teams-select').addEventListener('change', renderTeamsTab);

    $('autopick-cb').addEventListener('change', () => {
      if ($('autopick-cb').checked) scheduleNext();
    });

    const backToSetup = () => {
      clearTimeout(cpuTimer);
      $('results-modal').classList.add('hidden');
      $('draft-screen').classList.add('hidden');
      $('setup-screen').classList.remove('hidden');
    };
    $('new-draft-btn').addEventListener('click', backToSetup);
    $('results-new').addEventListener('click', backToSetup);
    $('results-close').addEventListener('click', () => $('results-modal').classList.add('hidden'));
    $('export-btn').addEventListener('click', exportCSV);
  }

  // ================= INIT =================
  initSetup();
  initDraftRoomEvents();
})();
