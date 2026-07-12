#!/usr/bin/env node
/**
 * build-data.js — fetches live dynasty rankings and generates ../rankings-data.js
 *
 * Sources:
 *   KTC          — real, scraped from keeptradecut.com (superflex, native 0.5 TE premium "TEP" values)
 *   FantasyPros  — real, scraped from fantasypros.com dynasty superflex ECR,
 *                  with a documented 0.5 TE-premium adjustment (+9% TE value) applied
 *   ESPN         — approximated snapshot (ESPN publishes no machine-readable dynasty SF rankings):
 *                  blend of 35% KTC / 65% FP, slight proven-veteran lean, seeded jitter
 *   Sleeper      — approximated snapshot (Sleeper exposes no public rankings API):
 *                  blend of 60% KTC / 40% FP, slight youth/rookie lean, seeded jitter
 *
 * Usage: node scripts/build-data.js
 * Re-run any time to refresh KTC + FantasyPros to today's values.
 */

const fs = require('fs');
const path = require('path');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// deterministic PRNG so builds are reproducible for a given dataset
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?$/g, '')
    .replace(/[^a-z]/g, '');
}

async function main() {
  console.log('Fetching KeepTradeCut (superflex)...');
  const ktcHtml = await fetchText('https://keeptradecut.com/dynasty-rankings?format=2');
  const ktcMatch = ktcHtml.match(/var playersArray = (\[.*?\]);/s);
  if (!ktcMatch) throw new Error('KTC playersArray not found — page layout may have changed');
  const ktcAll = JSON.parse(ktcMatch[1]);
  // RDP entries are rookie draft picks; this is a startup player mock, so drop them
  const ktc = ktcAll.filter((p) => p.position !== 'RDP');

  console.log('Fetching FantasyPros (dynasty superflex ECR)...');
  const fpHtml = await fetchText('https://www.fantasypros.com/nfl/rankings/dynasty-superflex.php');
  const fpMatch = fpHtml.match(/var ecrData = (\{.*?\});/s);
  if (!fpMatch) throw new Error('FantasyPros ecrData not found — page layout may have changed');
  const fpData = JSON.parse(fpMatch[1]);
  const fp = fpData.players;

  console.log(`KTC players: ${ktc.length}, FP players: ${fp.length}`);

  // ---- merge pools by normalized name + position ----
  const fpByKey = new Map();
  for (const p of fp) fpByKey.set(normName(p.player_name) + '|' + p.player_position_id, p);

  const players = [];
  const usedFpKeys = new Set();

  for (const k of ktc) {
    const key = normName(k.playerName) + '|' + k.position;
    const f = fpByKey.get(key);
    if (f) usedFpKeys.add(key);
    players.push({
      name: k.playerName,
      pos: k.position,
      team: k.team || f?.player_team_id || 'FA',
      age: Math.round(k.age * 10) / 10 || (f ? Number(f.player_age) : null),
      rookie: !!k.rookie,
      bye: k.byeWeek || null,
      ktcVal: k.superflexValues.tep.value, // superflex + 0.5 TE premium, native
      fpEcr: f ? f.rank_ecr : null,
    });
  }
  for (const f of fp) {
    const key = normName(f.player_name) + '|' + f.player_position_id;
    if (usedFpKeys.has(key)) continue;
    players.push({
      name: f.player_name,
      pos: f.player_position_id,
      team: f.player_team_id || 'FA',
      age: Number(f.player_age) || null,
      rookie: false,
      bye: Number(f.player_bye_week) || null,
      ktcVal: null,
      fpEcr: f.rank_ecr,
    });
  }

  // ---- shared value curve: KTC's actual sorted TEP values ----
  const curve = ktc.map((p) => p.superflexValues.tep.value).sort((a, b) => b - a);
  const valAtRank = (r) => curve[Math.min(Math.max(r, 1), curve.length) - 1];

  // fill missing base values deterministically
  for (const p of players) {
    const jitter = mulberry32(hashStr(p.name + p.pos));
    if (p.ktcVal == null) p.ktcVal = Math.round(valAtRank(p.fpEcr) * (0.93 + jitter() * 0.04));
    // FP value: map ECR onto the shared curve, then apply 0.5 TE-premium boost
    let fpVal = p.fpEcr != null ? valAtRank(p.fpEcr) : Math.round(p.ktcVal * (0.93 + jitter() * 0.04));
    if (p.pos === 'TE' && p.fpEcr != null) fpVal = Math.round(fpVal * 1.09);
    p.fpVal = fpVal;
  }

  // ---- approximated snapshots for ESPN & Sleeper ----
  for (const p of players) {
    const rSlp = mulberry32(hashStr('slp|' + p.name + p.pos));
    const rEsp = mulberry32(hashStr('esp|' + p.name + p.pos));

    let slp = 0.6 * p.ktcVal + 0.4 * p.fpVal;
    if (p.rookie) slp *= 1.06;
    else if (p.age != null && p.age <= 23) slp *= 1.05;
    else if (p.age != null && p.age <= 25) slp *= 1.02;
    else if (p.age != null && p.age >= 29 && p.pos !== 'QB') slp *= 0.96;
    slp *= 1 + (rSlp() - 0.5) * 0.06;
    p.slpVal = Math.round(slp);

    let esp = 0.35 * p.ktcVal + 0.65 * p.fpVal;
    if (p.age != null && p.age >= 25 && p.age <= 29) esp *= 1.03;
    if (p.rookie) esp *= 0.95;
    esp *= 1 + (rEsp() - 0.5) * 0.08;
    p.espVal = Math.round(esp);
  }

  // ---- final ranks per source (1..N, no ties) ----
  const rankBy = (key, rankKey) => {
    [...players]
      .sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name))
      .forEach((p, i) => (p[rankKey] = i + 1));
  };
  rankBy('ktcVal', 'ktcRank');
  rankBy('fpVal', 'fpRank');
  rankBy('espVal', 'espRank');
  rankBy('slpVal', 'slpRank');

  players.sort((a, b) => a.ktcRank - b.ktcRank);

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    fpLastUpdated: fpData.last_updated || null,
    sources: {
      ktc: { name: 'KeepTradeCut', real: true, note: 'Live superflex values with native 0.5 TE premium (TEP)' },
      fp: { name: 'FantasyPros', real: true, note: 'Live dynasty superflex ECR with a 0.5 TE-premium adjustment applied' },
      esp: { name: 'ESPN', real: false, note: 'Approximated snapshot — ESPN has no public dynasty SF feed. Blended from live market data with a proven-production lean.' },
      slp: { name: 'Sleeper', real: false, note: 'Approximated snapshot — Sleeper has no public rankings API. Blended from live market data with a youth/rookie lean.' },
    },
    players: players.map((p, i) => ({
      id: i + 1,
      n: p.name,
      pos: p.pos,
      tm: p.team,
      age: p.age,
      rk: p.rookie,
      ranks: { ktc: p.ktcRank, fp: p.fpRank, esp: p.espRank, slp: p.slpRank },
      vals: { ktc: p.ktcVal, fp: p.fpVal, esp: p.espVal, slp: p.slpVal },
    })),
  };

  const dest = path.join(__dirname, '..', 'rankings-data.js');
  fs.writeFileSync(dest, 'window.DMD_DATA = ' + JSON.stringify(out) + ';\n');
  console.log(`Wrote ${dest} — ${out.players.length} players, generated ${out.generated}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
