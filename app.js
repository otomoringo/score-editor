// 画面側: キーボード入力、五線の表示（abcjs）、再生、保存と出力
'use strict';
(() => {
  const M = ScoreModel;
  const H = ScoreHarmony;
  const FUNC_LABEL = { T: 'トニック', S: 'サブドミナント', D: 'ドミナント' };
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
  // 白鍵 A S D F J K L = ドレミファソラシ、黒鍵 W E U I O = ド♯ レ♯ ファ♯ ソ♯ ラ♯
  // （高いドは 右Shift+A。; は臨時記号の♯に使う）
  const NOTE_KEYS = {
    KeyA: 0, KeyS: 2, KeyD: 4, KeyF: 5, KeyJ: 7, KeyK: 9, KeyL: 11,
    KeyW: 1, KeyE: 3, KeyU: 6, KeyI: 8, KeyO: 10,
  };
  // 臨時記号のキー: ; = ♯、- = ♭、N = ♮
  const ACC_KEYS = { Semicolon: 1, Minus: -1, NumpadSubtract: -1, KeyN: 0 };

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
  let hoverCols = null;
  let hoverBar = null;
  let insertMode = false;
  let lastEntered = null; // 直前に鍵盤で入れた音符（臨時記号のキーはこの音符に付ける）
  // 仮の音符。パートの末尾や空いている休符へ → で進むと出る薄い音符で、高さ・長さ・臨時記号を変えてから → か Enter で確定する。
  // { step, alter, oct, dur, rest } または null
  let ghost = null;
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

  // 最初のクリックやキー入力で音を出せる状態にしておく（そのあとは Shift+マウスだけでも鳴る）
  const unlockAudio = () => {
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    ctx();
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);
  };
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

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

  // 仮の音符を末尾に足した、表示用の楽譜（score そのものは変えない）
  function viewScore() {
    if (!ghost || printing) return score;
    const view = { ...score, parts: score.parts.map((p, i) => (i === cur.part ? { ...p, events: p.events.map((e) => ({ ...e })) } : p)) };
    // 確定したときと同じ置き方（空いている休符なら上書き）を、写しの上でやってみせる
    const keepScore = score;
    const keepCur = { ...cur };
    try {
      score = view;
      cur.idx = ghost.at;
      placeEvent(ghostEvent());
    } finally {
      score = keepScore;
      cur = keepCur;
    }
    return view;
  }

  function render() {
    updateCenterPad();
    const r = M.toAbc(viewScore(), { forEdit: !printing });
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
    decorate();
    // 和音の表示で段の高さが変わるので、付け終わってから真ん中に合わせ直す
    const c = paper.querySelector('.cur, .cur-end');
    if (c) centerLine(c, false);
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

  // 和音の表示（五線の下にコード名と度数）と、主音・下属音・属音の色分け
  function decorate() {
    hoverCols = null; // 段組の位置が変わるので、マウス位置と拍の対応を作り直させる
    paper.querySelectorAll('.hl').forEach((el) => el.remove());
    paper.querySelectorAll('.deg1, .deg4, .deg5').forEach((el) => el.classList.remove('deg1', 'deg4', 'deg5'));
    const showHarmony = $('harm').checked && !printing;
    paper.classList.toggle('harm-on', showHarmony);
    if ($('degree').checked && !printing) {
      for (const t of toks) {
        if (t.pad || t.rest) continue;
        const e = score.parts[t.part].events[t.idx];
        if (!e || e.rest) continue;
        const role = H.scaleRole(e, info.grid.at(info.grid.find(t.tick)).key);
        if (role) for (const el of t.els) el.classList.add('deg' + role);
      }
    }
    if (!showHarmony) return;
    const byTick = new Map();
    for (const t of toks) if (t.els.length && !byTick.has(t.tick)) byTick.set(t.tick, t);
    const pr = paper.getBoundingClientRect();
    for (const d of H.analyze(score)) {
      const t = byTick.get(d.tick);
      const el = t && t.els[0];
      const svg = el && el.ownerSVGElement;
      if (!svg) continue;
      const r = el.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      const div = document.createElement('div');
      div.className = 'hl';
      div.style.left = (r.left - pr.left) + 'px';
      div.style.top = (sr.bottom - pr.top) + 'px';
      const name = document.createElement('b');
      name.textContent = d.name;
      const fn = document.createElement('span');
      fn.className = 'fn f' + (d.func || 'N');
      fn.textContent = d.roman;
      div.append(name, fn);
      paper.appendChild(div);
    }
  }

  function cursorToks() {
    const len = events().length;
    if (ghost && !printing) return { list: toks.filter((x) => x.part === cur.part && !x.pad && x.idx === ghost.at), cls: 'ghost' };
    if (cur.idx >= len) {
      const t = toks.find((x) => x.part === cur.part && x.pad);
      return { list: t ? [t] : [], cls: 'cur-end' };
    }
    return { list: toks.filter((x) => x.part === cur.part && !x.pad && x.idx === cur.idx), cls: 'cur' };
  }

  function highlight() {
    paper.querySelectorAll('.cur, .cur-end, .sel, .ghost').forEach((el) => el.classList.remove('cur', 'cur-end', 'sel', 'ghost'));
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
    if (first) centerLine(first, false);
  }

  // el を含む段（4声ぶんの1段）の中心が、楽譜の表示欄の高さの真ん中に来るようにスクロールする。
  // 同じ段の中で動くあいだは位置が変わらないので、画面は揺れない。
  function centerLine(el, smooth) {
    const svg = el.closest('svg');
    if (!svg) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // 横方向
    const s = scroller.getBoundingClientRect();
    const r = svg.getBoundingClientRect();
    const top = scroller.scrollTop + (r.top + r.height / 2) - (s.top + scroller.clientHeight / 2);
    if (Math.abs(top - scroller.scrollTop) < 2) return;
    scroller.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  // 最初と最後の段も真ん中まで来られるように、楽譜の上下に表示欄の半分の余白を付ける
  function updateCenterPad() {
    scroller.style.setProperty('--center-pad', Math.round(scroller.clientHeight / 2) + 'px');
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
      (ghost
        ? `<span>仮の音符: <b>${pitchLabel(ghost)}（${durLabel(ghost.dur)}）</b> → で確定して次へ／Enter で確定／Esc で取り消し</span>`
        : `<span>カーソル: <b>${e ? pitchLabel(e) + '（' + durLabel(e.dur) + (e.tie ? '・タイ' : '') + '）' : '末尾（ここに追加）'}</b></span>`) +
      `<span>次に入れる長さ: <b>${durLabel(curTicks())}</b></span>` +
      `<span>入力: <b>${insertMode ? '挿入' : '上書き'}</b>（Insertで切替）</span>`;
    document.querySelectorAll('#durs button[data-base]').forEach((b) => b.classList.toggle('on', Number(b.dataset.base) === curDur.base));
    $('btnDot').classList.toggle('on', curDur.dot);
    if ($('harm').checked) {
      const d = H.describe(score, tick, gm.key);
      if (d) {
        const fn = FUNC_LABEL[d.func] ? '・' + FUNC_LABEL[d.func] : '';
        $('status').insertAdjacentHTML('beforeend', `<span>和音: <b>${d.name}</b>（${d.roman}${fn}）</span>`);
      }
    }
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
    set($('tempo'), gm.tempo);
    set($('inst'), score.instrument);
    set($('ensemble'), score.ensemble);
    document.querySelectorAll('.mlabel').forEach((el, i) => { el.textContent = score.parts[i].id; });
  }

  // ---------- 編集 ----------

  const snapshot = () => JSON.stringify({ score, cur });

  function mutate(fn) {
    ghost = null;
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
    ghost = null;
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
    if (ghost) { ghost = null; render(); return; }
    highlight();
    updateStatus();
  }

  // ---------- 仮の音符（→ で、まだ何も書いていない場所に進むと出る） ----------

  // idx の休符が「空いている場所」か。その休符から小節の終わりまで休符しかなければ、空いているとみなす
  // （はじめから入っている全休符や、音符を入れたあとに小節の残りとしてできた休符）。
  function isEmptyRest(partIdx, idx) {
    const ev = score.parts[partIdx].events;
    if (!ev[idx] || !ev[idx].rest) return false;
    const s = startTick(partIdx, idx);
    const g = M.grid(score);
    const gm = g.at(g.find(s));
    const me = gm.start + gm.len;
    let t = s;
    for (let j = idx; j < ev.length && t < me; j++) {
      if (!ev[j].rest) return false;
      t += ev[j].dur;
    }
    return true;
  }

  // → で idx に進む。空いている場所（末尾や、空いている休符）なら仮の音符を出し、音符が書いてあればそこにカーソルを当てる。
  function stepTo(idx) {
    const len = events().length;
    if (idx >= len) openGhost(len);
    else if (!insertMode && isEmptyRest(cur.part, idx)) openGhost(idx);
    else moveTo(cur.part, idx);
  }

  // at は仮の音符を置く位置（末尾なら events().length、空いている休符ならその休符の番号）。
  // 高さは、それより前の最後の音符と同じ（音符がなければ基準のド）。長さは「次に入れる長さ」。
  function openGhost(at) {
    const ev = events();
    let last = null;
    for (let i = Math.min(at, ev.length) - 1; i >= 0; i--) if (!ev[i].rest) { last = ev[i]; break; }
    ghost = last
      ? { step: last.step, alter: last.alter, oct: last.oct, dur: curTicks(), rest: false, at }
      : { step: 'C', alter: 0, oct: score.parts[cur.part].baseOct, dur: curTicks(), rest: false, at };
    cur.idx = at;
    clearSelection();
    render();
    playNotes([M.midi(ghost)], 0.5);
  }

  function ghostEvent() {
    const g = ghost;
    return g.rest ? { rest: true, dur: g.dur } : { step: g.step, alter: g.alter, oct: g.oct, dur: g.dur, tie: false, lyric: '' };
  }

  function updateGhost(patch, sound = true) {
    Object.assign(ghost, patch);
    render();
    if (sound && !ghost.rest) playNotes([M.midi(ghost)], 0.5);
  }

  function cancelGhost() {
    if (!ghost) return;
    ghost = null;
    render();
  }

  // 仮の音符を置く。空いている休符の上なら、その長さぶんを上書きする。確定した音符にカーソルを当てる。
  function commitGhost() {
    const e = ghostEvent();
    const at = ghost.at;
    mutate(() => {
      cur.idx = at;
      placeEvent(e);
      cur.idx--;
    });
  }

  // 仮の音符が出ているときのキー。扱ったら true。扱わないキーは仮の音符を消して、ふだんの動きに回す。
  function ghostKey(e, code, ctrl, digit) {
    const g = ghost;
    const keyAtEnd = () => info.grid.at(info.grid.find(startTick(cur.part, g.at))).key;
    const setPitch = (n) => { if (M.midi(n) >= MIDI_MIN && M.midi(n) <= MIDI_MAX) updateGhost({ ...n, rest: false }); };
    if (code === 'Enter' || code === 'NumpadEnter') { commitGhost(); return true; }
    if (code === 'Escape' || code === 'Delete' || code === 'Backspace') { cancelGhost(); return true; }
    if (code === 'ArrowLeft') { moveTo(cur.part, g.at - 1); return true; } // 取り消して、手前の音符へ
    // → は確定して次へ進む。次が空いていれば、すぐ次の仮の音符が出る（同じ高さ・同じ長さから打ち込める）
    if (code === 'ArrowRight') { commitGhost(); stepTo(cur.idx + 1); return true; }
    if (code === 'ArrowUp' || code === 'ArrowDown') {
      if (g.rest) return true;
      const d = code === 'ArrowUp' ? 1 : -1;
      setPitch(ctrl ? shiftedPitch(g, 0, d) : shiftedPitch(g, d, 0));
      return true;
    }
    if (ctrl) return false;
    const durKey = DUR_LETTER_KEYS[code] || (digit && DUR_KEYS[digit[1]]);
    if (durKey) {
      curDur = { base: durKey, dot: false };
      updateGhost({ dur: durKey }, false);
      return true;
    }
    if (code === 'Period' || code === 'NumpadDecimal') {
      const dotted = g.dur % 3 === 0;
      const next = dotted ? (g.dur * 2) / 3 : g.dur * 1.5;
      if (!dotted && (g.dur < 2 || next > 48)) return true;
      curDur = { base: dotted ? next : g.dur, dot: !dotted };
      updateGhost({ dur: next }, false);
      return true;
    }
    if (code in ACC_KEYS) {
      if (g.rest) return true;
      const alter = ACC_KEYS[code];
      setPitch({ step: g.step, oct: g.oct, alter: g.alter === alter ? M.keyAlter(keyAtEnd(), g.step) : alter });
      return true;
    }
    if (code in NOTE_KEYS) {
      const m = 12 * (score.parts[cur.part].baseOct + 1 + octaveShift()) + NOTE_KEYS[code];
      if (m < MIDI_MIN || m > MIDI_MAX) return true;
      const [step, alter] = (score.key.fifths < 0 ? FLAT : SHARP)[m % 12];
      setPitch({ step, alter, oct: Math.floor(m / 12) - 1 });
      return true;
    }
    if (code === 'KeyR' || (digit && digit[1] === '0')) { updateGhost({ rest: !g.rest }); return true; }
    return false;
  }

  // 鍵盤と同じ並び。semitone は「そのパートの基準のド」からの半音数。
  function enterNote(semitone) {
    const m = 12 * (score.parts[cur.part].baseOct + 1 + octaveShift()) + semitone;
    if (m < MIDI_MIN || m > MIDI_MAX) return;
    const [step, alter] = (score.key.fifths < 0 ? FLAT : SHARP)[m % 12];
    const oct = Math.floor(m / 12) - 1;
    const placed = { step, alter, oct, dur: curTicks(), tie: false, lyric: '' };
    mutate(() => { placeEvent(placed); });
    lastEntered = { part: cur.part, e: placed };
    playNotes([M.midi(placed)], 0.5);
  }

  // 臨時記号を付ける（alter: 1=♯, -1=♭, 0=♮）。同じ記号をもう一度押すと、調号どおりの音に戻す。
  // 付ける相手は、範囲選択があればその中の音符すべて、音符を入れた直後ならその音符、それ以外はカーソルの音符。
  function setAccidental(alter, justEntered) {
    const ev = events();
    let targets = [];
    if (sel) {
      // 範囲選択中は、選んだパートすべての音符に付ける
      const notes = selEvents().filter(({ e }) => !e.rest);
      const keyOf = ({ part, idx }) => info.grid.at(info.grid.find(startTick(part, idx))).key;
      const revert = notes.length === 1 && notes[0].e.alter === alter;
      const changes = notes
        .map((n) => ({ n, next: { step: n.e.step, alter: revert ? M.keyAlter(keyOf(n), n.e.step) : alter, oct: n.e.oct } }))
        .filter(({ next }) => M.midi(next) >= MIDI_MIN && M.midi(next) <= MIDI_MAX);
      if (!changes.length) return;
      const keepSel = sel;
      mutate(() => { for (const { n, next } of changes) Object.assign(n.e, next); });
      sel = keepSel;
      highlight();
      const firsts = new Map();
      for (const { n, next } of changes) if (!firsts.has(n.part)) firsts.set(n.part, M.midi(next));
      playNotes([...firsts.values()], 0.5);
      return;
    } else if (justEntered && justEntered.part === cur.part && ev[cur.idx - 1] === justEntered.e) {
      targets = [cur.idx - 1];
    } else {
      targets = [cur.idx < ev.length ? cur.idx : ev.length - 1];
    }
    targets = targets.filter((i) => ev[i] && !ev[i].rest);
    if (!targets.length) return;
    const one = targets.length === 1 ? ev[targets[0]] : null;
    const keyAt = (i) => info.grid.at(info.grid.find(startTick(cur.part, i))).key;
    // 1つだけなら、すでに同じ記号のときは調号どおりに戻す（切り替え）
    const revert = one && one.alter === alter;
    const changes = targets.map((i) => {
      const e = ev[i];
      const a = revert ? M.keyAlter(keyAt(i), e.step) : alter;
      return { i, next: { step: e.step, alter: a, oct: e.oct } };
    }).filter(({ next }) => M.midi(next) >= MIDI_MIN && M.midi(next) <= MIDI_MAX);
    if (!changes.length) return;
    const keepSel = sel;
    mutate(() => {
      for (const { i, next } of changes) Object.assign(events()[i], next);
    });
    if (keepSel) { sel = keepSel; highlight(); }
    if (justEntered && one) lastEntered = justEntered; // 続けて押しても同じ音符に効くように
    playNotes(changes.map(({ next }) => M.midi(next)), 0.5);
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

  // 長さキーは「次に入れる長さ」を決め、カーソルが音符・休符の上にあればその長さも変える（Alt の有無は問わない）。
  // 範囲選択中は、選んだ音符・休符すべてをその長さにする。末尾（音符がない位置）では次に入れる長さだけ。
  function setBase(base) {
    curDur = { base, dot: false };
    if (sel) resizeSelection(() => curTicks());
    else if (cur.idx < events().length && events()[cur.idx].dur !== curTicks()) mutate(() => { resizeEvent(cur.idx, curTicks()); });
    else updateStatus();
  }

  // 範囲選択中は、選んだものそれぞれの付点を切り替える（全部に付点があれば外し、そうでなければ付ける）
  function toggleDot() {
    if (sel) {
      const dotted = (d) => d % 3 === 0;
      const all = selEvents().every(({ e }) => dotted(e.dur));
      curDur.dot = !all;
      resizeSelection((d) => (all ? (d * 2) / 3 : dotted(d) || d * 1.5 > 48 || d < 2 ? d : d * 1.5));
      return;
    }
    // カーソルが音符・休符の上なら、その音符の付点を切り替える（次に入れる長さもそれに合わせる）
    if (cur.idx < events().length) {
      const d = events()[cur.idx].dur;
      const dotted = d % 3 === 0;
      const next = dotted ? (d * 2) / 3 : d * 1.5;
      if (!dotted && (d < 2 || next > 48)) return;
      curDur = { base: dotted ? next : d, dot: !dotted };
      mutate(() => { resizeEvent(cur.idx, next); });
      return;
    }
    curDur.dot = !curDur.dot;
    updateStatus();
  }

  // 選択中の音符・休符を [{ part, idx, e }] で返す（入力用の末尾の空きは含めない）
  function selEvents() {
    const out = [];
    if (!sel) return out;
    for (const [p, [a, b]] of Object.entries(sel)) {
      const pi = Number(p);
      const ev = score.parts[pi].events;
      for (let i = Math.min(a, b); i <= Math.max(a, b) && i < ev.length; i++) out.push({ part: pi, idx: i, e: ev[i] });
    }
    return out;
  }

  // 選んだ音符・休符の長さを、パートごとにまとめて変える。durOf(今の長さ) が新しい長さ。
  // 上書きモードでは、選んだ範囲が伸びたぶんは後ろを上書きし、縮んだぶんは休符で埋めて、後ろの小節は動かさない。
  // 挿入モードでは、そのパートの後ろがずれる。歌詞・タイ・高さはそのまま。
  function resizeSelection(durOf) {
    const keepSel = sel;
    mutate(() => {
      for (const [p, [a0, b0]] of Object.entries(keepSel)) {
        const pi = Number(p);
        const ev = score.parts[pi].events;
        const a = Math.min(a0, b0);
        const b = Math.min(Math.max(a0, b0), ev.length - 1);
        if (a > b) continue;
        let oldLen = 0;
        let newLen = 0;
        for (let i = a; i <= b; i++) {
          oldLen += ev[i].dur;
          ev[i].dur = durOf(ev[i].dur);
          newLen += ev[i].dur;
        }
        if (insertMode || b === ev.length - 1 || newLen === oldLen) continue;
        if (newLen > oldLen) {
          // 伸びたぶん、選んだ範囲のすぐ後ろを先頭から削る（削りきれない音符は残りを休符にする）
          const rest = ev.splice(b + 1);
          let cut = newLen - oldLen;
          while (cut > 0 && rest.length) {
            const e = rest[0];
            if (e.dur <= cut) { cut -= e.dur; rest.shift(); } else { rest[0] = { rest: true, dur: e.dur - cut }; cut = 0; }
          }
          ev.push(...rest);
        } else {
          ev.splice(b + 1, 0, { rest: true, dur: oldLen - newLen });
          if (!ev[b].rest) ev[b].tie = false;
        }
      }
    });
    sel = keepSel;
    highlight();
    say('選択中の長さを変えました');
  }

  function shiftedPitch(e, semitones, octave) {
    if (octave) return { step: e.step, alter: e.alter, oct: e.oct + octave };
    const m = M.midi(e) + semitones;
    const f = score.key.fifths;
    const table = f < 0 ? FLAT : f > 0 ? SHARP : semitones > 0 ? SHARP : FLAT;
    const [step, alter] = table[((m % 12) + 12) % 12];
    return { step, alter, oct: Math.floor(m / 12) - 1 };
  }

  // 範囲選択中は、選んだ音符すべての高さを変える（1つでも音域の外に出るなら何もしない）。
  // 選んだ音符どうしのタイはそのまま残す（全部が同じだけ動くので、つながりは変わらない）。
  function shiftPitch(semitones, octave) {
    if (sel) {
      const notes = selEvents().filter(({ e }) => !e.rest);
      if (!notes.length) return;
      const nexts = notes.map(({ e }) => shiftedPitch(e, semitones, octave));
      if (nexts.some((n) => M.midi(n) < MIDI_MIN || M.midi(n) > MIDI_MAX)) { say('音域の外に出るので変えられません'); return; }
      const keepSel = sel;
      mutate(() => { notes.forEach(({ e }, i) => Object.assign(e, nexts[i])); });
      sel = keepSel;
      highlight();
      // パートごとに選んだ最初の音を鳴らす（和音として聴ける）
      const firsts = new Map();
      notes.forEach(({ part }, i) => { if (!firsts.has(part)) firsts.set(part, M.midi(nexts[i])); });
      playNotes([...firsts.values()], 0.5);
      return;
    }
    const e = events()[cur.idx];
    if (!e || e.rest) return;
    const next = shiftedPitch(e, semitones, octave);
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
      say(n + '個を選択中（長さキー・↑↓で変更／Ctrl+C コピー／Ctrl+X 切り取り／Delete 削除／Esc 解除）');
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

  // Delete / Backspace で音符を1つ消す。
  // 上書きモードでは、同じ小節の中でそれより後ろの音符・休符を前に詰め、小節の終わりに消した長さぶんの休符を足す
  // （ほかの小節の位置は動かない）。挿入モードでは、そのパートの後ろ全体が詰まる。
  // カーソルは、消した音符の次にあった音符に置く（末尾で手前を消したときは末尾のまま）。
  function deleteAt(idx) {
    const ev = events();
    if (idx < 0 || idx >= ev.length) return;
    const target = idx === cur.idx ? ev[idx + 1] : ev[cur.idx];
    mutate(() => {
      if (insertMode || idx === ev.length - 1) eraseRange(cur.part, idx, idx);
      else removeInMeasure(cur.part, idx);
      const at = target ? events().indexOf(target) : -1;
      cur.idx = at >= 0 ? at : Math.min(idx, events().length);
    });
  }

  function removeInMeasure(partIdx, idx) {
    const ev = score.parts[partIdx].events;
    const e = ev[idx];
    const s = startTick(partIdx, idx);
    const g = M.grid(score);
    const gm = g.at(g.find(s));
    const me = gm.start + gm.len;
    // 小節線をまたいでいる音符は、詰めると次の小節まで動くので、今までどおり休符に戻す
    if (s + e.dur > me) { eraseRange(partIdx, idx, idx); return; }
    // 同じ小節の中に収まっている後ろの音符を数える（小節線をまたぐ音符の手前まで）
    let t = s + e.dur;
    let j = idx + 1;
    while (j < ev.length && t + ev[j].dur <= me) { t += ev[j].dur; j++; }
    ev.splice(idx, 1);
    // 後ろに何も続かないなら、休符を足す必要はない（パートがそこで終わる）
    if (j - 1 < ev.length) ev.splice(j - 1, 0, { rest: true, dur: e.dur });
    if (idx > 0 && !ev[idx - 1].rest) ev[idx - 1].tie = false;
  }

  // 小節ごと削除（4声まとめて）。範囲選択中なら、選んだ音符がかかる小節をすべて消す。
  function deleteMeasuresAtCursor() {
    let from;
    let to;
    if (sel) {
      from = Infinity;
      to = -1;
      for (const [p, [i0, i1]] of Object.entries(sel)) {
        const pi = Number(p);
        const ev = score.parts[pi].events;
        const t0 = startTick(pi, i0);
        const t1 = startTick(pi, i1) + (ev[i1] ? ev[i1].dur : 1) - 1;
        from = Math.min(from, info.grid.find(t0));
        to = Math.max(to, info.grid.find(t1));
      }
    } else {
      from = to = info.grid.find(startTick(cur.part, cur.idx));
    }
    // 何も書いていない末尾の入力用の小節は消せない（消すものがない）
    const written = Math.max(...score.parts.map((p) => M.partTicks(p)));
    if (info.grid.at(from).start >= written) { say('この小節にはまだ何も書かれていません'); return; }
    const label = (m) => (info.grid.at(m).pickup ? '弱起' : info.grid.at(m).number + '小節目');
    const what = from === to ? label(from) : `${label(from)}〜${label(to)}`;
    mutate(() => {
      M.deleteMeasures(score, from, to);
      cur.idx = idxAtTick(cur.part, M.grid(score).at(from).start);
    });
    say(what + 'を削除しました（Ctrl+Z で戻せます）');
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

  // Shift+マウスで和音を聴く: 段組のどこ（音符の上、歌詞、五線の間）にいても、
  // マウスの横位置にある拍の和音を鳴らし、その位置に縦棒を出す。

  // 段組ごとに「どの横位置がどの拍か」を調べる（紙の左上からの位置）。描き直しのたびに作り直す。
  function hoverColumns() {
    if (hoverCols) return hoverCols;
    const pr = paper.getBoundingClientRect();
    const bySvg = new Map();
    for (const t of toks) {
      const el = t.els[0];
      const svg = el && el.ownerSVGElement;
      if (!svg) continue;
      if (!bySvg.has(svg)) bySvg.set(svg, new Map());
      const cols = bySvg.get(svg);
      const head = el.querySelector('.abcjs-notehead');
      const r = (head || el).getBoundingClientRect();
      const x = r.left + r.width / 2 - pr.left;
      const known = cols.get(t.tick);
      // 全休符は小節の真ん中に描かれるので、同じ拍に音符があれば音符の位置を使う
      if (!known || (head && !known.head)) cols.set(t.tick, { x, tick: t.tick, head: !!head });
    }
    hoverCols = [...bySvg].map(([svg, cols]) => {
      const sr = svg.getBoundingClientRect();
      const staffs = [...svg.querySelectorAll('.abcjs-staff')].map((s) => s.getBoundingClientRect());
      return {
        top: sr.top - pr.top,
        bottom: sr.bottom - pr.top + (paper.classList.contains('harm-on') ? 40 : 0),
        barTop: (staffs.length ? Math.min(...staffs.map((s) => s.top)) : sr.top) - pr.top,
        barBottom: (staffs.length ? Math.max(...staffs.map((s) => s.bottom)) : sr.bottom) - pr.top,
        list: [...cols.values()].sort((a, b) => a.x - b.x),
      };
    });
    return hoverCols;
  }

  function hideHoverBar() {
    hoverTick = -1;
    if (hoverBar) hoverBar.style.display = 'none';
  }

  // Shift を押しているあいだだけ鳴らす。マウスを動かしたとき、または段組の上で Shift を押したときに鳴る。
  // Shift+鍵盤（オクターブを変えて入力）で毎回鳴らないように、Shift を押してすぐ別のキーが来たら鳴らさない。
  let lastMouse = null; // 段組の上にあるマウスの位置（画面上の座標）
  let shiftTimer = 0;
  const shiftDown = (e) => e.shiftKey || shiftLeft || shiftRight;

  paper.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    hoverAt(e.clientX, e.clientY, shiftDown(e));
  });
  document.addEventListener('keydown', (e) => {
    clearTimeout(shiftTimer);
    if (e.key !== 'Shift' || e.repeat || !lastMouse) return;
    shiftTimer = setTimeout(() => { if (lastMouse && (shiftLeft || shiftRight)) hoverAt(lastMouse.x, lastMouse.y, true); }, 200);
  });

  function hoverAt(clientX, clientY, shift) {
    if (!shift || !$('hover').checked || playing || lyricOpen || band || printing) { hideHoverBar(); return; }
    const pr = paper.getBoundingClientRect();
    const x = clientX - pr.left;
    const y = clientY - pr.top;
    const sys = hoverColumns().find((s) => y >= s.top && y < s.bottom);
    let col = null;
    // マウスのすぐ左にある拍（音符の少し手前でもその音符を拾う）
    if (sys) for (const c of sys.list) { if (c.x - 7 <= x) col = c; else break; }
    if (!col) { hideHoverBar(); return; }
    if (!hoverBar || !hoverBar.isConnected) {
      hoverBar = document.createElement('div');
      hoverBar.id = 'vbar';
      paper.appendChild(hoverBar);
    }
    hoverBar.style.display = 'block';
    hoverBar.style.left = col.x + 'px';
    hoverBar.style.top = sys.barTop + 'px';
    hoverBar.style.height = (sys.barBottom - sys.barTop) + 'px';
    if (col.tick === hoverTick) return;
    hoverTick = col.tick;
    // ブラウザは、ページを開いてからクリックなどの操作があるまで音を出させない（マウスを動かす・Shift だけでは足りない）
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) {
      say('音を鳴らすには、まず楽譜を一度クリックしてください（ページを開いた直後は、クリックするまでブラウザが音を止めています）');
      return;
    }
    playNotes(chordAt(col.tick), 0.8);
  }
  paper.addEventListener('mouseleave', () => { lastMouse = null; hideHoverBar(); });
  document.addEventListener('keyup', (e) => { if (e.key === 'Shift') { clearTimeout(shiftTimer); hideHoverBar(); } });

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
    // 途中でテンポが変わる曲では、拍の割合と時間の割合がずれるので、時間で位置を決める
    const frac = Math.min(0.999, Math.max(0, M.secondsAt(score, fromTick) / M.secondsAt(score, info.totalTicks)));
    timing = new ABCJS.TimingCallbacks(visualObj, {
      eventCallback: (ev) => {
        if (!ev) { stopPlay(); return; }
        clearPlaying();
        let firstEl = null;
        for (const set of ev.elements || []) for (const el of set) { el.classList.add('playing'); firstEl = firstEl || el; }
        if (firstEl) centerLine(firstEl, true);
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

  // 前回保存したファイルのハンドルを IndexedDB に覚えておき、
  // 次回の保存ダイアログを同じフォルダで開く（localStorage は文字列しか持てず、ハンドルを保存できない）
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('score-editor', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function kvSet(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
      q.onsuccess = () => res();
      q.onerror = () => rej(q.error);
    });
  }

  async function rememberFile(h) {
    try { await kvSet('lastFile', h); } catch { /* 覚えられなくても保存・読込はできている */ }
  }

  // 保存・開くの両ダイアログ共通: 最後に保存／開いたファイルのフォルダで開く。
  // startIn に前回のファイルハンドルを渡すと、そのファイルのあるフォルダで開く。
  // ハンドルが古くて使えない場合は startIn なしで開き直す
  async function pickFile(picker, opts) {
    let last = null;
    try { last = (await kvGet('lastFile')) || (await kvGet('lastSaveFile')); } catch { /* 取れなければ覚えていないのと同じ */ }
    try {
      return await picker(last ? { ...opts, startIn: last } : opts);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      if (last) return await picker(opts);
      throw err;
    }
  }

  async function saveJson() {
    const text = JSON.stringify(M.toJson(score), null, 1);
    const name = baseName() + '.json';
    if (window.showSaveFilePicker) {
      try {
        // id を付けると、ブラウザもこのダイアログ専用に前回の場所を覚える（startIn との二段構え）
        const h = await pickFile((o) => window.showSaveFilePicker(o),
          { id: 'score-json', suggestedName: name, types: [{ description: '楽譜（JSON）', accept: { 'application/json': ['.json'] } }] });
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        await rememberFile(h);
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

  async function openJson() {
    if (!window.showOpenFilePicker) {
      $('file').click();  // 非対応ブラウザは従来のファイル選択
      return;
    }
    let h;
    try {
      [h] = await pickFile((o) => window.showOpenFilePicker(o),
        { id: 'score-json', multiple: false, types: [{ description: '楽譜（JSON）', accept: { 'application/json': ['.json'] } }] });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      $('file').click();  // ダイアログ自体が開けないときだけ従来の方法へ
      return;
    }
    try {
      const f = await h.getFile();
      loadScore(M.fromJson(JSON.parse(await f.text())));
      await rememberFile(h);  // 開いた場所も覚える（次の保存・開くが同じフォルダで開く）
      say('');
    } catch (err) {
      say('読み込めませんでした: ' + err.message);
    }
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
    const justEntered = lastEntered;
    lastEntered = null;
    const ctrl = e.ctrlKey || e.metaKey;
    const code = e.code;
    let handled = true;
    const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);

    if (ghost) {
      if (ghostKey(e, code, ctrl, digit)) { e.preventDefault(); return; }
      cancelGhost();
    }

    if (ctrl && code === 'KeyZ') restore(e.shiftKey ? redoStack : undoStack, e.shiftKey ? undoStack : redoStack);
    else if (ctrl && code === 'KeyY') restore(redoStack, undoStack);
    else if (ctrl && code === 'KeyS') saveJson();
    else if (ctrl && code === 'KeyC') copySelection();
    else if (ctrl && code === 'KeyX') { if (copySelection()) deleteSelection(); }
    else if (ctrl && code === 'KeyV') paste();
    else if (ctrl && (code === 'Delete' || code === 'Backspace')) deleteMeasuresAtCursor();
    else if (ctrl && code === 'ArrowLeft') moveMeasure(-1);
    else if (ctrl && code === 'ArrowRight') moveMeasure(1);
    else if (ctrl && code === 'ArrowUp') shiftPitch(0, 1);
    else if (ctrl && code === 'ArrowDown') shiftPitch(0, -1);
    else if (ctrl) handled = false;
    else if (e.altKey && code === 'ArrowUp') switchPart(-1);
    else if (e.altKey && code === 'ArrowDown') switchPart(1);
    else if (e.altKey && code in DUR_LETTER_KEYS) setBase(DUR_LETTER_KEYS[code]);
    else if (e.altKey && digit && DUR_KEYS[digit[1]]) setBase(DUR_KEYS[digit[1]]);
    else if (e.altKey && (code === 'Period' || code === 'NumpadDecimal')) toggleDot();
    else if (e.altKey) handled = false;
    else if (code in NOTE_KEYS) enterNote(NOTE_KEYS[code]);
    else if (code in ACC_KEYS) setAccidental(ACC_KEYS[code], justEntered);
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
    else if (code === 'ArrowRight') {
      // 次が末尾や空いている休符なら、仮の音符を出す。音符が書いてあれば、そこへ進む
      if (!sel) stepTo(Math.min(cur.idx, events().length) + 1);
      else moveTo(cur.part, cur.idx + 1);
    }
    else if (code === 'ArrowUp') shiftPitch(1, 0);
    else if (code === 'ArrowDown') shiftPitch(-1, 0);
    else if (code === 'Home') moveTo(cur.part, 0);
    else if (code === 'End') moveTo(cur.part, events().length);
    else if (code === 'PageUp') switchPart(-1);
    else if (code === 'PageDown') switchPart(1);
    else if (code === 'Delete') { if (!deleteSelection()) deleteAt(cur.idx); }
    // Backspace も Delete と同じ（カーソルの音符を消す）。末尾にいるときだけは、手前の音符を消す
    else if (code === 'Backspace') { if (!deleteSelection()) deleteAt(cur.idx < events().length ? cur.idx : cur.idx - 1); }
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
    onChange('tempo', (v) => { M.setChange(score, scopeMeasure(), { tempo: Math.max(20, Math.min(240, Math.round(Number(v)) || 90)) }); });
    onChange('inst', (v) => { score.instrument = v; });
    for (const [id, def] of Object.entries(M.ENSEMBLES)) $('ensemble').add(new Option(def.label, id));
    onChange('ensemble', (v) => { M.setEnsemble(score, v); });
    for (const id of ['title', 'composer', 'tempo']) {
      $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.target.blur(); });
    }

    const click = (id, fn) => $(id).addEventListener('click', (e) => { e.currentTarget.blur(); fn(); });
    click('btnNew', () => { if (confirm('今の楽譜を閉じて、新しい楽譜を始めますか？（Ctrl+Z で戻せます）')) loadScore(M.newScore(score.ensemble)); });
    click('btnOpen', () => { openJson(); });
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
    for (const id of ['harm', 'degree']) {
      try { if (localStorage.getItem('score-editor.' + id) === 'off') $(id).checked = false; } catch { /* 記憶が読めなければ既定のまま */ }
      $(id).addEventListener('change', (e) => {
        try { localStorage.setItem('score-editor.' + id, e.target.checked ? 'on' : 'off'); } catch { /* 記憶できなくても切り替えは効く */ }
        decorate();
        updateStatus();
        e.target.blur();
      });
    }
    window.addEventListener('resize', () => { updateCenterPad(); decorate(); });
  }

  setupControls();
  try {
    const saved = localStorage.getItem(AUTOSAVE_KEY);
    if (saved) score = M.fromJson(JSON.parse(saved));
  } catch { /* 壊れた自動保存は無視して空の楽譜から始める */ }
  render();

  window.__editor = { get score() { return score; }, get cur() { return cur; }, get toks() { return toks; }, get visualObj() { return visualObj; } };
})();
