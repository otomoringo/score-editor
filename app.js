// 画面側: キーボード入力、五線の表示（abcjs）、再生、保存と出力
'use strict';
(() => {
  const M = ScoreModel;
  const $ = (id) => document.getElementById(id);
  const AUTOSAVE_KEY = 'score-editor.autosave';
  const PROGRAM = { choir_aahs: 52, acoustic_grand_piano: 0 };
  const DUR_KEYS = { 1: 32, 2: 16, 3: 8, 4: 4, 5: 2 };
  // ホームポジションのまま届く下の段でも長さを選べる
  const DUR_LETTER_KEYS = { KeyZ: 32, KeyX: 16, KeyC: 8, KeyV: 4, KeyB: 2 };
  const DUR_LETTER = { 32: 'Z', 16: 'X', 8: 'C', 4: 'V', 2: 'B' };
  const DUR_LABEL = { 2: '16分', 4: '8分', 8: '4分', 16: '2分', 32: '全' };
  const SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  const FILE_NOTE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MIDI_MIN = 24; // C1
  const MIDI_MAX = 96; // C7（手元に置いた音源ファイルの範囲）
  // 白鍵 A S D F J K L ; = ドレミファソラシド、黒鍵 W E U I O = ド♯ レ♯ ファ♯ ソ♯ ラ♯
  const NOTE_KEYS = {
    KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyJ: 7, KeyK: 9, KeyL: 11, Semicolon: 12,
    KeyW: 1, KeyE: 3, KeyU: 6, KeyI: 8, KeyO: 10,
  };

  let score = M.newScore();
  let cur = { part: 0, idx: 0 };
  let curDur = { base: 8, dot: false };
  let undoStack = [];
  let redoStack = [];
  let toks = [];
  let info = { total: 1, M: 32 };
  let visualObj = null;
  let synth = null;
  let timing = null;
  let playing = false;
  let printing = false;
  let lyricOpen = false;
  let hoverTick = -1;
  let insertMode = false;
  let sel = null; // 範囲選択。{ パート番号: [最初の音符, 最後の音符] }
  let selAnchor = null;
  let clip = null; // コピーした内容。[{ offset: 一番上の段からの段数, events }]
  let justDragged = false;
  let shiftLeft = false;
  let shiftRight = false;
  const octaveShift = () => (shiftRight ? 1 : 0) - (shiftLeft ? 1 : 0);

  const paper = $('paper');
  const scroller = $('scroll');
  const lyricInput = $('lyric');

  const events = () => score.parts[cur.part].events;
  const curTicks = () => curDur.base * (curDur.dot ? 1.5 : 1);
  const say = (text) => { $('msg').textContent = text || ''; };

  function startTick(partIdx, idx) {
    const ev = score.parts[partIdx].events;
    let t = 0;
    for (let i = 0; i < idx && i < ev.length; i++) t += ev[i].dur;
    return t;
  }

  function idxAtTick(partIdx, tick) {
    const ev = score.parts[partIdx].events;
    let t = 0;
    for (let i = 0; i < ev.length; i++) {
      if (tick < t + ev[i].dur) return i;
      t += ev[i].dur;
    }
    return ev.length;
  }

  // ---------- 音（打ち込み時・和音の試聴は自前で音源ファイルを鳴らす） ----------

  let audioCtx = null;
  const buffers = new Map();

  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function loadNote(inst, midi) {
    const key = inst + ':' + midi;
    if (!buffers.has(key)) {
      const name = FILE_NOTE[midi % 12] + (Math.floor(midi / 12) - 1);
      buffers.set(key, fetch(`soundfont/${inst}-mp3/${name}.mp3`)
        .then((r) => { if (!r.ok) throw new Error(name); return r.arrayBuffer(); })
        .then((b) => ctx().decodeAudioData(b))
        .catch(() => null));
    }
    return buffers.get(key);
  }

  async function playNotes(midis, seconds) {
    const list = [...new Set(midis)].filter((m) => m >= MIDI_MIN && m <= MIDI_MAX);
    if (!list.length) return;
    const ac = ctx();
    const bufs = await Promise.all(list.map((m) => loadNote(score.instrument, m)));
    const t0 = ac.currentTime + 0.01;
    for (const buf of bufs) {
      if (!buf) continue;
      const src = ac.createBufferSource();
      const gain = ac.createGain();
      src.buffer = buf;
      gain.gain.setValueAtTime(0.7 / Math.sqrt(list.length), t0);
      gain.gain.setValueAtTime(0.7 / Math.sqrt(list.length), t0 + seconds);
      gain.gain.linearRampToValueAtTime(0, t0 + seconds + 0.15);
      src.connect(gain).connect(ac.destination);
      src.start(t0);
      src.stop(t0 + seconds + 0.2);
    }
  }

  const activeParts = () => [...document.querySelectorAll('.mute')].map((c) => c.checked);

  function chordAt(tick) {
    const on = activeParts();
    const out = [];
    score.parts.forEach((p, pi) => {
      if (!on[pi]) return;
      const e = p.events[idxAtTick(pi, tick)];
      if (e && !e.rest) out.push(M.midi(e));
    });
    return out;
  }

  // ---------- 表示 ----------

  function render() {
    const r = M.toAbc(score, { forEdit: !printing });
    toks = r.toks;
    info = r;
    visualObj = ABCJS.renderAbc('paper', r.abc, {
      add_classes: true,
      staffwidth: 1000,
      responsive: 'resize',
      oneSvgPerLine: true,
      selectionColor: '#000000',
      clickListener: onClickNote,
    })[0];
    mapElements();
    highlight();
    updateStatus();
    syncControls();
    if (!printing) {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(M.toJson(score))); } catch { /* 保存できなくても編集は続けられる */ }
    }
  }

  // abcjs の startChar は直前の空白を含むことがあるので、範囲の重なりで探す
  function findTok(startChar, endChar) {
    const end = endChar > startChar ? endChar : startChar + 1;
    return toks.find((t) => t.start < end && startChar < t.end);
  }

  function mapElements() {
    for (const t of toks) t.els = [];
    if (!visualObj || !visualObj.lines) return;
    for (const line of visualObj.lines) {
      for (const staff of line.staff || []) {
        for (const voice of staff.voices || []) {
          for (const el of voice) {
            if (el.el_type !== 'note' || !el.abselem || !el.abselem.elemset) continue;
            const tok = findTok(el.startChar, el.endChar);
            if (!tok) continue;
            const i = toks.indexOf(tok);
            for (const svgEl of el.abselem.elemset) {
              if (!svgEl || !svgEl.setAttribute) continue;
              svgEl.setAttribute('data-tok', i);
              tok.els.push(svgEl);
            }
          }
        }
      }
    }
  }

  function cursorToks() {
    const len = events().length;
    if (cur.idx >= len) {
      const t = toks.find((x) => x.part === cur.part && x.pad);
      return { list: t ? [t] : [], cls: 'cur-end' };
    }
    return { list: toks.filter((x) => x.part === cur.part && !x.pad && x.idx === cur.idx), cls: 'cur' };
  }

  function highlight() {
    paper.querySelectorAll('.cur, .cur-end, .sel').forEach((el) => el.classList.remove('cur', 'cur-end', 'sel'));
    if (printing) return;
    if (sel) {
      for (const t of toks) {
        const r = sel[t.part];
        if (r && !t.pad && t.idx >= r[0] && t.idx <= r[1]) for (const el of t.els) el.classList.add('sel');
      }
    }
    const { list, cls } = cursorToks();
    let first = null;
    for (const t of list) for (const el of t.els) { el.classList.add(cls); first = first || el; }
    if (first && first.scrollIntoView) first.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function pitchLabel(e) {
    if (e.rest) return '休符';
    const acc = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '♯♯' }[e.alter];
    return e.step + acc + e.oct;
  }

  function durLabel(d) {
    if (DUR_LABEL[d]) return DUR_LABEL[d] + '音符';
    if (DUR_LABEL[(d * 2) / 3]) return '付点' + DUR_LABEL[(d * 2) / 3] + '音符';
    return `${d / 8}拍ぶん`;
  }

  function updateStatus() {
    const part = score.parts[cur.part];
    const tick = startTick(cur.part, cur.idx);
    const mi = info.grid.find(tick);
    const gm = info.grid.at(mi);
    const beat = (tick - gm.start + gm.off) / (32 / gm.time.beatType) + 1;
    const where = gm.pickup ? '<b>弱起</b>' : `<b>${gm.number}</b>小節`;
    const e = part.events[cur.idx];
    $('status').innerHTML =
      `<span>パート: <b>${part.name}</b></span>` +
      `<span>位置: ${where} <b>${Number(beat.toFixed(2))}</b>拍</span>` +
      `<span>カーソル: <b>${e ? pitchLabel(e) + '（' + durLabel(e.dur) + (e.tie ? '・タイ' : '') + '）' : '末尾（ここに追加）'}</b></span>` +
      `<span>次に入れる長さ: <b>${durLabel(curTicks())}</b></span>` +
      `<span>入力: <b>${insertMode ? '挿入' : '上書き'}</b>（Insertで切替）</span>`;
    document.querySelectorAll('#durs button[data-base]').forEach((b) => b.classList.toggle('on', Number(b.dataset.base) === curDur.base));
    $('btnDot').classList.toggle('on', curDur.dot);
    syncControls();
  }

  // 調・拍子の欄が指す小節（0始まり）。「カーソルの小節から」ならカーソルのある小節、それ以外は曲の最初。
  const scopeMeasure = () => ($('scope').value === 'here' ? info.grid.find(startTick(cur.part, cur.idx)) : 0);

  // 弱起の欄の選択肢。曲の最初の拍子の1小節より短い長さだけを出す。
  const PICKUP_CHOICES = [[2, '16分音符ぶん'], [4, '8分音符ぶん'], [6, '付点8分ぶん'], [8, '4分音符ぶん'], [12, '付点4分ぶん'], [16, '2分音符ぶん'], [24, '付点2分ぶん']];
  function syncPickupOptions() {
    const el = $('pickup');
    const full = M.measureTicks(score);
    const now = M.pickupTicks(score);
    const sig = `${full}|${now}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.replaceChildren(new Option('なし', '0'));
    for (const [t, label] of PICKUP_CHOICES) if (t < full) el.add(new Option(label, String(t)));
    if (now && !PICKUP_CHOICES.some(([t]) => t === now)) el.add(new Option(`${now / 8}拍ぶん`, String(now)));
  }

  function syncControls() {
    const set = (el, v) => { if (document.activeElement !== el) el.value = v; };
    const gm = info.grid.at(scopeMeasure());
    set($('title'), score.title);
    set($('composer'), score.composer);
    set($('key'), `${gm.key.fifths}|${gm.key.mode}`);
    set($('time'), `${gm.time.beats}/${gm.time.beatType}`);
    syncPickupOptions();
    set($('pickup'), String(M.pickupTicks(score)));
    set($('tempo'), score.tempo);
    set($('inst'), score.instrument);
    set($('ensemble'), score.ensemble);
    document.querySelectorAll('.mlabel').forEach((el, i) => { el.textContent = score.parts[i].id; });
  }

  // ---------- 編集 ----------

  const snapshot = () => JSON.stringify({ score, cur });

  function mutate(fn) {
    undoStack.push(snapshot());
    if (undoStack.length > 300) undoStack.shift();
    redoStack = [];
    clearSelection();
    fn();
    clampCursor();
    render();
  }

  function restore(from, to) {
    if (!from.length) return;
    stopPlay();
    to.push(snapshot());
    const s = JSON.parse(from.pop());
    score = s.score;
    cur = s.cur;
    clearSelection();
    clampCursor();
    render();
  }

  function clampCursor() {
    cur.part = Math.max(0, Math.min(score.parts.length - 1, cur.part));
    cur.idx = Math.max(0, Math.min(events().length, cur.idx));
  }

  function clearSelection() {
    if (sel) say('');
    sel = null;
    selAnchor = null;
  }

  function moveTo(part, idx) {
    clearSelection();
    cur = { part, idx };
    clampCursor();
    highlight();
    updateStatus();
  }

  // 鍵盤と同じ並び。semitone は「そのパートの基準のド」からの半音数。
  function enterNote(semitone) {
    const m = 12 * (score.parts[cur.part].baseOct + 1 + octaveShift()) + semitone;
    if (m < MIDI_MIN || m > MIDI_MAX) return;
    const [step, alter] = (score.key.fifths < 0 ? FLAT : SHARP)[m % 12];
    const oct = Math.floor(m / 12) - 1;
    const placed = { step, alter, oct, dur: curTicks(), tie: false, lyric: '' };
    mutate(() => { placeEvent(placed); });
    playNotes([M.midi(placed)], 0.5);
  }

  function enterRest() {
    mutate(() => { placeEvent({ rest: true, dur: curTicks() }); });
  }

  // ---------- 小節を箱として扱う編集（上書きモード） ----------
  // 上書きモードでは、編集してもその後ろの音符の位置（拍）は動かない。
  // 入れた音符は、その長さぶんだけ後ろにあるものを上書きする。

  // パートが tick に届いていなければ、小節ごとの休符で埋める
  function fillTo(partIdx, tick) {
    const ev = score.parts[partIdx].events;
    const g = M.grid(score);
    let len = M.partTicks(score.parts[partIdx]);
    while (len < tick) {
      const gm = g.at(g.find(len));
      const end = Math.min(gm.start + gm.len, tick);
      ev.push({ rest: true, dur: end - len });
      len = end;
    }
  }

  // [from, to) の範囲を空ける。範囲の途中から始まる・途中で終わる音符は切り分け、
  // 範囲の後ろにはみ出した残りは休符にする。空けた位置の番号と、from から始まっていた音符の歌詞を返す。
  function carve(partIdx, from, to) {
    fillTo(partIdx, from);
    const ev = score.parts[partIdx].events;
    let t = 0;
    let i = 0;
    while (i < ev.length && t + ev[i].dur <= from) { t += ev[i].dur; i++; }
    let lyric = '';
    if (i < ev.length && t < from) {
      const e = ev[i];
      ev.splice(i + 1, 0, { rest: true, dur: t + e.dur - from });
      e.dur = from - t;
      if (!e.rest) e.tie = false;
      i++;
    } else if (i < ev.length && !ev[i].rest) {
      lyric = ev[i].lyric || '';
    }
    let pos = from;
    while (i < ev.length && pos < to) {
      const e = ev[i];
      if (pos + e.dur <= to) {
        pos += e.dur;
        ev.splice(i, 1);
      } else {
        ev[i] = { rest: true, dur: pos + e.dur - to };
        pos = to;
      }
    }
    if (i > 0 && !ev[i - 1].rest) ev[i - 1].tie = false;
    return { at: i, lyric };
  }

  // カーソル位置に音符・休符を置く（mutate の中から呼ぶ）
  function placeEvent(e) {
    const ev = events();
    if (insertMode || cur.idx >= ev.length) {
      ev.splice(cur.idx, 0, e);
      cur.idx++;
      return;
    }
    const tick = startTick(cur.part, cur.idx);
    const { at, lyric } = carve(cur.part, tick, tick + e.dur);
    if (!e.rest && !e.lyric) e.lyric = lyric;
    ev.splice(at, 0, e);
    cur.idx = at + 1;
  }

  // 音符の長さを変える。上書きモードでは、伸ばしたぶんは後ろを上書きし、縮めたぶんは休符になる。
  function resizeEvent(idx, dur) {
    const ev = events();
    const e = ev[idx];
    if (insertMode || idx === ev.length - 1 || dur === e.dur) { e.dur = dur; return; }
    const end = startTick(cur.part, idx) + e.dur;
    if (dur > e.dur) {
      carve(cur.part, end, end + dur - e.dur);
      e.dur = dur;
    } else {
      ev.splice(idx + 1, 0, { rest: true, dur: e.dur - dur });
      e.dur = dur;
      if (!e.rest) e.tie = false;
    }
  }

  // 音符を消す。上書きモードでは同じ長さの休符に変える（パートの最後の音符だけは取り除く）。
  function eraseRange(partIdx, from, to) {
    const ev = score.parts[partIdx].events;
    if (insertMode || to === ev.length - 1) {
      ev.splice(from, to - from + 1);
      return;
    }
    for (let i = from; i <= to; i++) ev[i] = { rest: true, dur: ev[i].dur };
    if (from > 0 && !ev[from - 1].rest) ev[from - 1].tie = false;
  }

  // 長さキーは「次に入れる長さ」を決めるだけ。Alt を押しながらなら、カーソルの音符の長さも変える。
  function setBase(base, resize) {
    curDur = { base, dot: false };
    if (resize && cur.idx < events().length) mutate(() => { resizeEvent(cur.idx, curTicks()); });
    else updateStatus();
  }

  function toggleDot(resize) {
    curDur.dot = !curDur.dot;
    if (resize && cur.idx < events().length) mutate(() => { resizeEvent(cur.idx, curTicks()); });
    else updateStatus();
  }

  function shiftPitch(semitones, octave) {
    const e = events()[cur.idx];
    if (!e || e.rest) return;
    let next;
    if (octave) {
      next = { step: e.step, alter: e.alter, oct: e.oct + octave };
    } else {
      const m = M.midi(e) + semitones;
      const f = score.key.fifths;
      const table = f < 0 ? FLAT : f > 0 ? SHARP : semitones > 0 ? SHARP : FLAT;
      const [step, alter] = table[((m % 12) + 12) % 12];
      next = { step, alter, oct: Math.floor(m / 12) - 1 };
    }
    const mm = M.midi(next);
    if (mm < MIDI_MIN || mm > MIDI_MAX) return;
    mutate(() => { Object.assign(events()[cur.idx], next, { tie: false }); });
    playNotes([mm], 0.5);
  }

  function toggleTie() {
    const ev = events();
    const t = cur.idx < ev.length ? cur.idx : ev.length - 1;
    const e = ev[t];
    if (!e || e.rest) return;
    const next = ev[t + 1];
    if (next && !next.rest && M.samePitch(e, next)) {
      mutate(() => { e.tie = !e.tie; });
      return;
    }
    mutate(() => {
      cur.idx = t + 1;
      placeEvent({ step: e.step, alter: e.alter, oct: e.oct, dur: curTicks(), tie: false, lyric: '' });
      e.tie = true;
    });
    playNotes([M.midi(e)], 0.5);
  }

  // ---------- 範囲選択とコピー・貼り付け ----------

  function setSelection(ranges) {
    const parts = Object.keys(ranges);
    sel = parts.length ? ranges : null;
    if (sel) {
      const n = parts.reduce((s, p) => s + ranges[p][1] - ranges[p][0] + 1, 0);
      say(n + '個を選択中（Ctrl+C コピー／Ctrl+X 切り取り／Delete 削除／Esc 解除）');
    } else {
      say('');
    }
    highlight();
  }

  // Shift+←→: カーソルのパートで選択範囲を伸び縮みさせる
  function extendSelection(dir) {
    const anchor = selAnchor === null ? cur.idx : selAnchor;
    const idx = Math.max(0, Math.min(events().length, cur.idx + dir));
    cur = { part: cur.part, idx };
    const from = Math.min(anchor, idx);
    const to = Math.max(anchor, idx) - 1;
    setSelection(to >= from ? { [cur.part]: [from, to] } : {});
    selAnchor = anchor;
    updateStatus();
  }

  // 画面上の四角形（マウスで囲んだ範囲）に入った音符を、パートごとに連続した範囲として選ぶ
  function selectInRect(x0, y0, x1, y1) {
    const ranges = {};
    for (const t of toks) {
      if (t.pad) continue;
      const hit = t.els.some((el) => {
        const r = el.getBoundingClientRect();
        return r.right >= x0 && r.left <= x1 && r.bottom >= y0 && r.top <= y1;
      });
      if (!hit) continue;
      const r = ranges[t.part];
      if (!r) ranges[t.part] = [t.idx, t.idx];
      else { r[0] = Math.min(r[0], t.idx); r[1] = Math.max(r[1], t.idx); }
    }
    const parts = Object.keys(ranges).map(Number).sort((a, b) => a - b);
    if (parts.length) cur = { part: parts[0], idx: ranges[parts[0]][0] };
    selAnchor = null;
    setSelection(ranges);
    updateStatus();
  }

  function copySelection() {
    if (!sel) return false;
    const parts = Object.keys(sel).map(Number).sort((a, b) => a - b);
    clip = parts.map((p) => ({
      offset: p - parts[0],
      events: score.parts[p].events.slice(sel[p][0], sel[p][1] + 1).map((e) => ({ ...e })),
    }));
    say('コピーしました（Ctrl+V でカーソル位置に貼り付け）');
    return true;
  }

  function deleteSelection() {
    if (!sel) return false;
    const ranges = sel;
    const parts = Object.keys(ranges).map(Number).sort((a, b) => a - b);
    mutate(() => {
      for (const p of parts) eraseRange(p, ranges[p][0], ranges[p][1]);
      cur = { part: parts[0], idx: ranges[parts[0]][0] };
    });
    return true;
  }

  // カーソル位置に差し込む。複数段をコピーしていたら、カーソルの段から下へ同じ拍の位置に入れる。
  function paste() {
    if (!clip || !clip.length) { say('コピーした内容がありません'); return; }
    const tick = startTick(cur.part, cur.idx);
    const top = cur.part;
    const topIdx = cur.idx;
    mutate(() => {
      for (const row of clip) {
        const p = top + row.offset;
        if (p >= score.parts.length) continue;
        const ev = score.parts[p].events;
        let at;
        if (!insertMode) {
          const total = row.events.reduce((s, e) => s + e.dur, 0);
          at = carve(p, tick, tick + total).at;
        } else if (p === top) {
          at = topIdx;
        } else {
          const len = M.partTicks(score.parts[p]);
          if (len < tick) ev.push({ rest: true, dur: tick - len });
          at = len <= tick ? ev.length : idxAtTick(p, tick);
        }
        ev.splice(at, 0, ...row.events.map((e) => ({ ...e })));
        if (p === top) cur = { part: top, idx: at + row.events.length };
      }
    });
  }

  function deleteAt(idx) {
    if (idx < 0 || idx >= events().length) return;
    mutate(() => {
      eraseRange(cur.part, idx, idx);
      cur.idx = idx;
    });
  }

  function switchPart(delta) {
    const part = cur.part + delta;
    if (part < 0 || part >= score.parts.length) return;
    moveTo(part, idxAtTick(part, startTick(cur.part, cur.idx)));
  }

  function moveMeasure(delta) {
    const tick = startTick(cur.part, cur.idx);
    const mi = info.grid.find(tick);
    const gm = info.grid.at(mi);
    const target = delta > 0 ? gm.start + gm.len : tick > gm.start ? gm.start : info.grid.at(Math.max(0, mi - 1)).start;
    moveTo(cur.part, idxAtTick(cur.part, target));
  }

  // ---------- 歌詞 ----------

  const isTiedInto = (ev, i) => i > 0 && !ev[i - 1].rest && ev[i - 1].tie && !ev[i].rest && M.samePitch(ev[i - 1], ev[i]);

  function nextSingable(from, dir) {
    const ev = events();
    for (let i = from; i >= 0 && i < ev.length; i += dir) {
      if (!ev[i].rest && !isTiedInto(ev, i)) return i;
    }
    return -1;
  }

  function openLyric(idx) {
    const target = nextSingable(Math.min(idx, events().length - 1), 1);
    if (target < 0) { closeLyric(); return; }
    moveTo(cur.part, target);
    const tok = toks.find((x) => x.part === cur.part && !x.pad && x.idx === target);
    const el = tok && tok.els[0];
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    lyricInput.style.left = `${r.left - s.left + scroller.scrollLeft - 10}px`;
    lyricInput.style.top = `${r.bottom - s.top + scroller.scrollTop + 10}px`;
    lyricInput.style.display = 'block';
    lyricInput.value = events()[target].lyric || '';
    lyricOpen = true;
    lyricInput.focus();
    lyricInput.select();
  }

  function commitLyric() {
    const e = events()[cur.idx];
    const v = lyricInput.value.trim();
    if (e && !e.rest && (e.lyric || '') !== v) mutate(() => { events()[cur.idx].lyric = v; });
  }

  function closeLyric() {
    if (!lyricOpen) return;
    lyricOpen = false;
    lyricInput.style.display = 'none';
    lyricInput.blur();
  }

  lyricInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 日本語変換中のキーは変換に使わせる
    if (e.key === ' ' || e.key === 'Tab') {
      e.preventDefault();
      commitLyric();
      const dir = e.shiftKey ? -1 : 1;
      const next = nextSingable(cur.idx + dir, dir);
      if (next < 0) closeLyric();
      else openLyric(next);
    } else if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      commitLyric();
      closeLyric();
    }
  });
  lyricInput.addEventListener('blur', () => {
    if (!lyricOpen) return;
    commitLyric();
    lyricOpen = false;
    lyricInput.style.display = 'none';
  });

  // ---------- マウス ----------

  function onClickNote(abcElem) {
    const tok = findTok(abcElem.startChar, abcElem.endChar);
    if (!tok || justDragged) return;
    closeLyric();
    // まだ何も書いていない先の小節をクリックしたら、そこまで休符で埋めて、その小節から書けるようにする
    if (tok.pad && tok.tick > M.partTicks(score.parts[tok.part])) {
      mutate(() => {
        fillTo(tok.part, tok.tick);
        cur = { part: tok.part, idx: score.parts[tok.part].events.length };
      });
      return;
    }
    moveTo(tok.part, tok.pad ? score.parts[tok.part].events.length : tok.idx);
    if (!playing) playNotes(chordAt(tok.tick), 1.0);
  }

  // マウスで囲んで範囲選択
  let band = null;
  let dragStart = null;
  paper.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragStart = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    if (!band) {
      if (Math.abs(e.clientX - dragStart.x) < 5 && Math.abs(e.clientY - dragStart.y) < 5) return;
      closeLyric();
      band = document.createElement('div');
      band.id = 'band';
      document.body.appendChild(band);
    }
    band.style.left = Math.min(e.clientX, dragStart.x) + 'px';
    band.style.top = Math.min(e.clientY, dragStart.y) + 'px';
    band.style.width = Math.abs(e.clientX - dragStart.x) + 'px';
    band.style.height = Math.abs(e.clientY - dragStart.y) + 'px';
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragStart) return;
    const s = dragStart;
    dragStart = null;
    if (!band) return;
    band.remove();
    band = null;
    selectInRect(Math.min(e.clientX, s.x), Math.min(e.clientY, s.y), Math.max(e.clientX, s.x), Math.max(e.clientY, s.y));
    justDragged = true; // 直後に来るクリックでカーソルが動いて選択が消えるのを防ぐ
    setTimeout(() => { justDragged = false; }, 0);
  });

  paper.addEventListener('mouseover', (e) => {
    if (!$('hover').checked || playing || lyricOpen || band) return;
    const g = e.target.closest && e.target.closest('[data-tok]');
    if (!g) return;
    const tok = toks[Number(g.getAttribute('data-tok'))];
    if (!tok || tok.tick === hoverTick) return;
    hoverTick = tok.tick;
    playNotes(chordAt(tok.tick), 0.8);
  });
  paper.addEventListener('mouseleave', () => { hoverTick = -1; });

  // ---------- 再生（abcjs） ----------

  function synthOptions() {
    const on = activeParts();
    const off = on.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    return { soundFontUrl: 'soundfont/', program: PROGRAM[score.instrument] || 0, voicesOff: off.length ? off : false };
  }

  function clearPlaying() {
    paper.querySelectorAll('.playing').forEach((el) => el.classList.remove('playing'));
  }

  function stopPlay() {
    if (timing) { timing.stop(); timing = null; }
    if (synth) { try { synth.stop(); } catch { /* 準備中に止めた場合 */ } synth = null; }
    playing = false;
    clearPlaying();
  }

  async function play(fromTick) {
    stopPlay();
    closeLyric();
    if (!score.parts.some((p) => p.events.some((e) => !e.rest))) { say('音符がまだありません'); return; }
    say('');
    playing = true;
    const mine = new ABCJS.synth.CreateSynth();
    synth = mine;
    try {
      await mine.init({ audioContext: ctx(), visualObj, options: synthOptions() });
      await mine.prime();
    } catch (err) {
      if (synth === mine) { stopPlay(); say('再生の準備に失敗しました: ' + (err && err.message ? err.message : err)); }
      return;
    }
    if (synth !== mine) return; // 準備中に止められた
    const frac = Math.min(0.999, Math.max(0, fromTick / info.totalTicks));
    timing = new ABCJS.TimingCallbacks(visualObj, {
      eventCallback: (ev) => {
        if (!ev) { stopPlay(); return; }
        clearPlaying();
        for (const set of ev.elements || []) for (const el of set) el.classList.add('playing');
      },
    });
    if (frac > 0) mine.seek(frac);
    mine.start();
    timing.start(frac);
  }

  // ---------- 保存・読込・出力 ----------

  const baseName = () => (score.title || '楽譜').replace(/[\\/:*?"<>|]/g, '_');

  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  async function saveJson() {
    const text = JSON.stringify(M.toJson(score), null, 1);
    const name = baseName() + '.json';
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: '楽譜（JSON）', accept: { 'application/json': ['.json'] } }] });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        say('');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    download(name, new Blob([text], { type: 'application/json' }));
  }

  function loadScore(next) {
    stopPlay();
    undoStack.push(snapshot());
    redoStack = [];
    score = next;
    cur = { part: 0, idx: 0 };
    render();
  }

  $('file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      loadScore(M.fromJson(JSON.parse(await f.text())));
      say('');
    } catch (err) {
      say('読み込めませんでした: ' + err.message);
    }
  });

  function exportMidi() {
    const abc = M.toAbc(score).abc;
    let data = ABCJS.synth.getMidiFile(abc, { midiOutputType: 'binary', program: PROGRAM[score.instrument] || 0 });
    if (Array.isArray(data)) data = data[0];
    download(baseName() + '.mid', new Blob([data], { type: 'audio/midi' }));
  }

  async function exportWav() {
    say('WAVを作成中…');
    try {
      const v = ABCJS.renderAbc('wavHost', M.toAbc(score).abc)[0];
      const s = new ABCJS.synth.CreateSynth();
      await s.init({ audioContext: ctx(), visualObj: v, options: synthOptions() });
      await s.prime();
      const blob = await (await fetch(s.download())).blob();
      download(baseName() + '.wav', blob);
      say('');
    } catch (err) {
      say('WAVを作成できませんでした: ' + (err && err.message ? err.message : err));
    } finally {
      $('wavHost').innerHTML = '';
    }
  }

  function printScore() {
    stopPlay();
    closeLyric();
    printing = true;
    render();
    window.print();
  }
  window.addEventListener('afterprint', () => {
    if (!printing) return;
    printing = false;
    render();
  });

  // ---------- キーボード ----------

  const trackShift = (e, down) => {
    if (e.code === 'ShiftLeft') shiftLeft = down;
    if (e.code === 'ShiftRight') shiftRight = down;
    if (!e.shiftKey) { shiftLeft = false; shiftRight = false; }
  };
  document.addEventListener('keydown', (e) => trackShift(e, true), true);
  document.addEventListener('keyup', (e) => trackShift(e, false), true);
  window.addEventListener('blur', () => { shiftLeft = false; shiftRight = false; });

  document.addEventListener('keydown', (e) => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const ctrl = e.ctrlKey || e.metaKey;
    const code = e.code;
    let handled = true;
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);

    if (ctrl && code === 'KeyZ') restore(e.shiftKey ? redoStack : undoStack, e.shiftKey ? undoStack : redoStack);
    else if (ctrl && code === 'KeyY') restore(redoStack, undoStack);
    else if (ctrl && code === 'KeyS') saveJson();
    else if (ctrl && code === 'KeyC') copySelection();
    else if (ctrl && code === 'KeyX') { if (copySelection()) deleteSelection(); }
    else if (ctrl && code === 'KeyV') paste();
    else if (ctrl && code === 'ArrowLeft') moveMeasure(-1);
    else if (ctrl && code === 'ArrowRight') moveMeasure(1);
    else if (ctrl && code === 'ArrowUp') shiftPitch(0, 1);
    else if (ctrl && code === 'ArrowDown') shiftPitch(0, -1);
    else if (ctrl) handled = false;
    else if (e.altKey && code === 'ArrowUp') switchPart(-1);
    else if (e.altKey && code === 'ArrowDown') switchPart(1);
    else if (e.altKey && code in DUR_LETTER_KEYS) setBase(DUR_LETTER_KEYS[code], true);
    else if (e.altKey && digit && DUR_KEYS[digit[1]]) setBase(DUR_KEYS[digit[1]], true);
    else if (e.altKey && (code === 'Period' || code === 'NumpadDecimal')) toggleDot(true);
    else if (e.altKey) handled = false;
    else if (code in NOTE_KEYS) enterNote(NOTE_KEYS[code]);
    else if (code === 'Insert') { insertMode = !insertMode; updateStatus(); }
    else if (code === 'KeyR' || (digit && digit[1] === '0')) enterRest();
    else if (digit && DUR_KEYS[digit[1]]) setBase(DUR_KEYS[digit[1]]);
    else if (code === 'Period' || code === 'NumpadDecimal') toggleDot();
    else if (code in DUR_LETTER_KEYS) setBase(DUR_LETTER_KEYS[code]);
    else if (code === 'Escape') { clearSelection(); highlight(); }
    else if (e.shiftKey && code === 'ArrowLeft') extendSelection(-1);
    else if (e.shiftKey && code === 'ArrowRight') extendSelection(1);
    else if (code === 'KeyT') toggleTie();
    else if (code === 'KeyH') playNotes(chordAt(startTick(cur.part, cur.idx)), 1.2);
    else if (code === 'Enter' || code === 'NumpadEnter') openLyric(cur.idx);
    else if (code === 'ArrowLeft') moveTo(cur.part, cur.idx - 1);
    else if (code === 'ArrowRight') moveTo(cur.part, cur.idx + 1);
    else if (code === 'ArrowUp') shiftPitch(1, 0);
    else if (code === 'ArrowDown') shiftPitch(-1, 0);
    else if (code === 'Home') moveTo(cur.part, 0);
    else if (code === 'End') moveTo(cur.part, events().length);
    else if (code === 'PageUp') switchPart(-1);
    else if (code === 'PageDown') switchPart(1);
    else if (code === 'Delete') { if (!deleteSelection()) deleteAt(cur.idx); }
    else if (code === 'Backspace') { if (!deleteSelection()) deleteAt(cur.idx - 1); }
    else if (code === 'Space') {
      if (playing) stopPlay();
      else play(e.shiftKey ? 0 : startTick(cur.part, cur.idx));
    } else handled = false;

    if (handled) e.preventDefault();
  });

  // ---------- ツールバー ----------

  function setupControls() {
    const key = $('key');
    for (let f = -7; f <= 7; f++) {
      const sig = f === 0 ? '' : f > 0 ? `（♯${f}）` : `（♭${-f}）`;
      key.add(new Option(`${M.MAJOR[f + 7]} 長調${sig}`, `${f}|major`));
    }
    for (let f = -7; f <= 7; f++) {
      const sig = f === 0 ? '' : f > 0 ? `（♯${f}）` : `（♭${-f}）`;
      key.add(new Option(`${M.MINOR[f + 7]} 短調${sig}`, `${f}|minor`));
    }
    for (const t of ['2/4', '3/4', '4/4', '5/4', '6/4', '2/2', '3/8', '6/8', '9/8', '12/8']) $('time').add(new Option(t, t));
    $('scope').addEventListener('change', (e) => { syncControls(); e.target.blur(); });

    const durs = $('durs');
    durs.append('長さ ');
    for (const [k, base] of Object.entries(DUR_KEYS)) {
      const b = document.createElement('button');
      b.textContent = `${DUR_LABEL[base]} (${DUR_LETTER[base]}/${k})`;
      b.dataset.base = base;
      b.addEventListener('click', () => { setBase(base); b.blur(); });
      durs.append(b);
    }
    const dot = document.createElement('button');
    dot.id = 'btnDot';
    dot.textContent = '付点 (.)';
    dot.addEventListener('click', () => { toggleDot(); dot.blur(); });
    durs.append(dot);

    const onChange = (id, fn) => $(id).addEventListener('change', (e) => { mutate(() => fn(e.target.value)); e.target.blur(); });
    onChange('title', (v) => { score.title = v; });
    onChange('composer', (v) => { score.composer = v; });
    onChange('key', (v) => { const [f, mode] = v.split('|'); M.setChange(score, scopeMeasure(), { key: { fifths: Number(f), mode } }); });
    onChange('time', (v) => { const [b, t] = v.split('/').map(Number); M.setChange(score, scopeMeasure(), { time: { beats: b, beatType: t } }); });
    onChange('pickup', (v) => { M.setPickup(score, Number(v)); });
    onChange('tempo', (v) => { score.tempo = Math.max(30, Math.min(240, Math.round(Number(v)) || 90)); });
    onChange('inst', (v) => { score.instrument = v; });
    for (const [id, def] of Object.entries(M.ENSEMBLES)) $('ensemble').add(new Option(def.label, id));
    onChange('ensemble', (v) => { M.setEnsemble(score, v); });
    for (const id of ['title', 'composer', 'tempo']) {
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.target.blur(); });
    }

    const click = (id, fn) => $(id).addEventListener('click', (e) => { e.currentTarget.blur(); fn(); });
    click('btnNew', () => { if (confirm('今の楽譜を閉じて、新しい楽譜を始めますか？（Ctrl+Z で戻せます）')) loadScore(M.newScore(score.ensemble)); });
    click('btnOpen', () => $('file').click());
    click('btnSave', saveJson);
    click('btnPlay', () => play(startTick(cur.part, cur.idx)));
    click('btnPlayTop', () => play(0));
    click('btnStop', stopPlay);
    click('btnPdf', printScore);
    click('btnMidi', exportMidi);
    click('btnWav', exportWav);
    click('btnXml', () => download(baseName() + '.musicxml', new Blob([M.toMusicXml(score)], { type: 'application/vnd.recordare.musicxml+xml' })));
    const themeLabel = () => { $('btnTheme').textContent = document.documentElement.dataset.theme === 'light' ? '🌙 暗くする' : '☀ 明るくする'; };
    themeLabel();
    click('btnTheme', () => {
      const light = document.documentElement.dataset.theme !== 'light';
      if (light) document.documentElement.dataset.theme = 'light';
      else delete document.documentElement.dataset.theme;
      try { localStorage.setItem('score-editor.theme', light ? 'light' : 'dark'); } catch { /* 記憶できなくても切り替えは効く */ }
      themeLabel();
    });
    document.querySelectorAll('.mute').forEach((c) => c.addEventListener('change', () => c.blur()));
    $('hover').addEventListener('change', (e) => e.target.blur());
  }

  setupControls();
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) score = M.fromJson(JSON.parse(saved));
  } catch { /* 壊れた自動保存は無視して空の楽譜から始める */ }
  render();

  window.__editor = { get score() { return score; }, get cur() { return cur; }, get toks() { return toks; }, get visualObj() { return visualObj; } };
})();
