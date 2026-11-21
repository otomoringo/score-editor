// 楽譜モデルと変換（JSON ⇔ 内部表現、ABC記法・MusicXML への書き出し）
// 画面に依存しないので Node からも require で読み込める。
(function (root) {
  'use strict';

  // 長さの単位は32分音符=1（4分音符=8）。MusicXML の divisions と同じ値。
  const DIV = 8;
  const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const MAJOR = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
  const MINOR = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
  const SHARP_ORDER = 'FCGDAEB';
  const FLAT_ORDER = 'BEADGCF';
  const TYPE_NAMES = { 1: '32nd', 2: '16th', 4: 'eighth', 8: 'quarter', 16: 'half', 32: 'whole' };
  // 1つの音符（付点1つまで）で書ける長さ
  const SINGLE = new Set([1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]);
  const ACC = { '-2': '__', '-1': '_', 0: '=', 1: '^', 2: '^^' };
  // abcjs は clef=treble-8 を「記譜より1オクターブ低く鳴らす」ので、
  // 実音で持っているテノールは ABC 上では1オクターブ上に書く。
  const CLEF_ABC_SHIFT = { 'treble-8': 1 };
  const MEASURES_PER_LINE = 4;

  // 編成。baseOct は、鍵盤入力で Shift なしの「ド」が入るオクターブ。
  const ENSEMBLES = {
    mixed: {
      label: '混声4部（S A T B）',
      parts: [
        { id: 'S', name: 'ソプラノ', clef: 'treble', baseOct: 4 },
        { id: 'A', name: 'アルト', clef: 'treble', baseOct: 4 },
        { id: 'T', name: 'テノール', clef: 'treble-8', baseOct: 3 },
        { id: 'B', name: 'バス', clef: 'bass', baseOct: 3 },
      ],
    },
    female: {
      label: '女声4部（S1 S2 A1 A2）',
      parts: [
        { id: 'S1', name: 'ソプラノ1', clef: 'treble', baseOct: 4 },
        { id: 'S2', name: 'ソプラノ2', clef: 'treble', baseOct: 4 },
        { id: 'A1', name: 'アルト1', clef: 'treble', baseOct: 4 },
        { id: 'A2', name: 'アルト2', clef: 'treble', baseOct: 4 },
      ],
    },
    male: {
      label: '男声4部（T1 T2 B1 B2）',
      parts: [
        { id: 'T1', name: 'テノール1', clef: 'treble-8', baseOct: 3 },
        { id: 'T2', name: 'テノール2', clef: 'treble-8', baseOct: 3 },
        { id: 'B1', name: 'バリトン', clef: 'bass', baseOct: 3 },
        { id: 'B2', name: 'バス', clef: 'bass', baseOct: 2 },
      ],
    },
  };

  // 編成を変える。音符は上から何段目かで引き継ぎ、音の高さは変えない。
  function setEnsemble(score, ensemble) {
    const def = ENSEMBLES[ensemble] || ENSEMBLES.mixed;
    score.ensemble = ENSEMBLES[ensemble] ? ensemble : 'mixed';
    score.parts = def.parts.map((p, i) => ({ ...p, events: (score.parts && score.parts[i] ? score.parts[i].events : []) }));
  }

  function newScore(ensemble) {
    const score = newScoreBase();
    setEnsemble(score, ensemble);
    return score;
  }

  function newScoreBase() {
    return {
      title: '',
      composer: '',
      key: { fifths: 0, mode: 'major' },
      time: { beats: 4, beatType: 4 },
      tempo: 90,
      instrument: 'choir_aahs',
      pickup: 0, // 弱起（アウフタクト）の長さ。0 なら弱起なし
      changes: [],
      parts: [],
    };
  }

  const keyName = (key) => (key.mode === 'minor' ? MINOR[key.fifths + 7] + 'm' : MAJOR[key.fifths + 7]);

  function keyAlter(key, step) {
    const f = key.fifths;
    if (f > 0 && SHARP_ORDER.slice(0, f).includes(step)) return 1;
    if (f < 0 && FLAT_ORDER.slice(0, -f).includes(step)) return -1;
    return 0;
  }

  const midi = (e) => 12 * (e.oct + 1) + STEP_SEMI[e.step] + e.alter;
  const samePitch = (a, b) => a.step === b.step && a.alter === b.alter && a.oct === b.oct;
  const measureTicks = (score) => (score.time.beats * 32) / score.time.beatType;
  const beatTicks = (score) => (score.time.beatType === 8 && score.time.beats % 3 === 0 ? 12 : 32 / score.time.beatType);
  const partTicks = (part) => part.events.reduce((s, e) => s + e.dur, 0);
  // 弱起の長さ。曲の最初の拍子の1小節より短いときだけ有効。
  const pickupTicks = (score) => {
    const p = Math.round(Number(score.pickup) || 0);
    return p > 0 && p < measureTicks(score) ? p : 0;
  };

  // 小節ごとの開始位置・長さ・拍子・調・テンポを返す。score.changes（曲の途中の拍子・調・テンポの変更。
  // {measure: 0始まりの小節番号, time?, key?, tempo?} の配列）を反映する。テンポは4分音符の速さ（♩=）。
  function grid(score) {
    const changes = [...(score.changes || [])].sort((a, b) => a.measure - b.measure);
    const ms = [];
    const pickup = pickupTicks(score);
    let time = score.time;
    let key = score.key;
    let tempo = score.tempo;
    let ci = 0;
    const extend = (n) => {
      while (ms.length <= n) {
        const m = ms.length;
        let timeChanged = false;
        let keyChanged = false;
        let tempoChanged = false;
        while (ci < changes.length && changes[ci].measure <= m) {
          if (changes[ci].time) { time = changes[ci].time; timeChanged = true; }
          if (changes[ci].key) { key = changes[ci].key; keyChanged = true; }
          if (changes[ci].tempo) { tempo = changes[ci].tempo; tempoChanged = true; }
          ci++;
        }
        const start = m ? ms[m - 1].start + ms[m - 1].len : 0;
        const full = (time.beats * 32) / time.beatType;
        // 弱起の小節は短い。off は「本来の小節のどこから始まるか」で、拍の区切りや連桁をそろえるのに使う。
        const pk = m === 0 ? pickup : 0;
        ms.push({ start, len: pk || full, off: pk ? full - pk : 0, pickup: pk > 0, number: pickup ? m : m + 1, time, key, tempo, timeChanged, keyChanged, tempoChanged });
      }
    };
    return {
      at(m) { extend(m); return ms[m]; },
      find(tick) {
        let m = 0;
        while (tick >= this.at(m).start + this.at(m).len) m++;
        return m;
      },
    };
  }

  // measure 小節目（0始まり）からの拍子・調・テンポを設定する。0 なら曲全体の最初の値を変える。
  // 直前と同じ値になった変更は取り除く。
  function setChange(score, measure, patch) {
    if (measure <= 0) {
      if (patch.time) score.time = patch.time;
      if (patch.key) score.key = patch.key;
      if (patch.tempo) score.tempo = patch.tempo;
    } else {
      const list = score.changes || (score.changes = []);
      let c = list.find((x) => x.measure === measure);
      if (!c) { c = { measure }; list.push(c); }
      Object.assign(c, patch);
    }
    tidyChanges(score);
  }

  // 拍子・調・テンポの変更を、小節順に並べて直前と同じ値のものを取り除く
  function tidyChanges(score) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let time = score.time;
    let key = score.key;
    let tempo = score.tempo;
    score.changes = (score.changes || [])
      .sort((a, b) => a.measure - b.measure)
      .map((c) => {
        const out = { measure: c.measure };
        if (c.time && !same(c.time, time)) { out.time = c.time; time = c.time; }
        if (c.key && !same(c.key, key)) { out.key = c.key; key = c.key; }
        if (c.tempo && c.tempo !== tempo) { out.tempo = c.tempo; tempo = c.tempo; }
        return out;
      })
      .filter((c) => c.time || c.key || c.tempo);
  }

  // from〜to 小節目（0始まり、両端を含む）を、全パートから取り除いて後ろを詰める。
  // 小節をまたいで入り込んでいる音符は、残る側の長さだけに縮める。
  // 曲の途中の拍子・調・テンポの変更は、後ろの小節に付いていたものを同じ小節に付いたまま前へずらす。
  // 消した小節の中で始まっていた変更は、消した範囲のすぐ後ろの小節に引き継ぐ（そこから先の調・拍子は変わらない）。
  function deleteMeasures(score, from, to) {
    const g = grid(score);
    from = Math.max(0, Math.floor(from));
    to = Math.max(from, Math.floor(to));
    const a = g.at(from).start;
    const b = g.at(to).start + g.at(to).len;
    const n = to - from + 1;
    for (const p of score.parts) {
      const out = [];
      let t = 0;
      for (const e of p.events) {
        const s = t;
        const end = t + e.dur;
        t = end;
        if (end <= a || s >= b) { out.push(e); continue; }
        // 消す範囲にかかる音符。前か後ろにはみ出した部分だけ残す
        const keep = Math.max(0, a - s) + Math.max(0, end - b);
        if (keep > 0) out.push({ ...e, dur: keep });
      }
      // 消した範囲の手前で終わる音符のタイは外す（詰めた後ろの音と勝手につながらないように）
      let t2 = 0;
      for (const e of out) {
        t2 += e.dur;
        if (t2 === a && e.tie) delete e.tie;
      }
      p.events = out;
    }
    // 弱起の小節を消したら弱起なしにする
    if (from === 0 && pickupTicks(score)) score.pickup = 0;
    // 変更の小節番号をずらす。消した範囲の中の変更は from に集めて、小節の順に重ねる
    // （後ろの小節の変更ほど優先。もともと to+1 小節目にあった変更がいちばん優先）
    const order = [...(score.changes || [])].sort((x, y) => x.measure - y.measure);
    const merged = [];
    for (const c of order) {
      const m = c.measure < from ? c.measure : c.measure <= to ? from : c.measure - n;
      const last = merged[merged.length - 1];
      if (last && last.measure === m) Object.assign(last, c, { measure: m });
      else merged.push({ ...c, measure: m });
    }
    // 小節0に来た変更は、曲の最初の値にする
    for (const c of merged.filter((x) => x.measure <= 0)) {
      if (c.time) score.time = c.time;
      if (c.key) score.key = c.key;
      if (c.tempo) score.tempo = c.tempo;
    }
    score.changes = merged.filter((c) => c.measure > 0);
    tidyChanges(score);
  }

  // 曲の頭から tick までの演奏時間（秒）。小節ごとのテンポで数える。
  function secondsAt(score, tick) {
    const g = grid(score);
    let sec = 0;
    for (let m = 0; ; m++) {
      const gm = g.at(m);
      const take = Math.min(gm.len, tick - gm.start);
      if (take <= 0) break;
      sec += (take / 8) * (60 / gm.tempo);
      if (take < gm.len) break;
    }
    return sec;
  }

  // ABC記法のテンポ。8分の6拍子などの複合拍子では、その拍子の楽譜の書き方に合わせて8分音符で表す。
  const abcTempo = (tempo, time) => (time.beatType === 8 ? `1/8=${tempo * 2}` : `1/4=${tempo}`);

  // 弱起の長さを変える。0 なら弱起なし。
  // どう変えても、音符と小節線の位置関係（何拍目にあるか）は変えない。
  //   弱起を長くする・やめる → 頭に休符を足す
  //   弱起を付ける・短くする → 頭の休符を削る（休符で埋めて書いてあった弱起の曲を、そのまま弱起に直せる）。
  //     削れるだけの休符が頭にないパートがあれば、曲全体を1小節後ろへ送り、弱起の小節を休符で空けておく
  function setPickup(score, ticks) {
    const full = measureTicks(score);
    const old = pickupTicks(score);
    const next = ticks > 0 && ticks < full ? Math.round(ticks) : 0;
    score.pickup = next;
    if (next === old) return;
    // lead は「本来の1小節のうち、曲が始まる前の空き」
    const delta = (next ? full - next : 0) - (old ? full - old : 0);
    const used = score.parts.filter((p) => p.events.length);
    const prepend = (d) => { for (const p of used) p.events.unshift({ rest: true, dur: d }); };
    const leadingRest = (p) => {
      let n = 0;
      for (const e of p.events) { if (!e.rest) break; n += e.dur; }
      return n;
    };
    if (delta < 0) {
      prepend(-delta);
    } else if (used.every((p) => leadingRest(p) >= delta)) {
      for (const p of used) {
        let left = delta;
        while (left > 0) {
          const e = p.events[0];
          if (e.dur <= left) { left -= e.dur; p.events.shift(); } else { e.dur -= left; left = 0; }
        }
      }
    } else if (used.length) {
      prepend(full - delta);
      for (const c of score.changes || []) c.measure += 1;
    }
  }

  const beatOf = (time) => (time.beatType === 8 && time.beats % 3 === 0 ? 12 : 32 / time.beatType);

  // 小節内の位置 pos から長さ d を、書ける音価の並びに分ける
  function decompose(d, pos) {
    if (SINGLE.has(d)) return [d];
    const out = [];
    while (d > 0) {
      let p = 32;
      while (p > 1 && (p > d || pos % p !== 0)) p /= 2;
      out.push(p);
      d -= p;
      pos += p;
    }
    return out;
  }

  // パートごとに、小節線をまたぐ音符をタイで分割しながら小節に割り付ける。
  // pad=true なら全パートを同じ小節数まで休符で埋める（forEdit なら末尾に入力用の空きを必ず作る）。
  function layout(score, { forEdit = false, pad = true } = {}) {
    const g = grid(score);
    const lens = score.parts.map(partTicks);
    const total = forEdit
      ? Math.max(...lens.map((l) => g.find(l) + 1))
      : Math.max(1, ...lens.map((l) => (l > 0 ? g.find(l - 1) + 1 : 1)));
    const end = g.at(total - 1).start + g.at(total - 1).len;
    const parts = score.parts.map((p, pi) => {
      const measures = Array.from({ length: total }, () => []);
      let tick = 0;
      let prev = null;
      const push = (m, item) => {
        item.tieIn = !!(prev && prev.tie);
        measures[m].push(item);
        prev = item;
      };
      p.events.forEach((e, idx) => {
        const next = p.events[idx + 1];
        const tieOk = !e.rest && e.tie && next && !next.rest && samePitch(e, next);
        let left = e.dur;
        let first = true;
        while (left > 0) {
          const m = g.find(tick);
          const pos = tick - g.at(m).start;
          const M = g.at(m).len;
          const chunk = Math.min(left, M - pos);
          const ds = decompose(chunk, pos + g.at(m).off);
          let q = pos;
          ds.forEach((d, k) => {
            const last = left - chunk === 0 && k === ds.length - 1;
            push(m, {
              part: pi, idx, e, tick: g.at(m).start + q, pos: q, dur: d,
              rest: !!e.rest, first, cont: !last, userTie: last && !!e.tie,
              tie: !e.rest && (!last || tieOk),
            });
            first = false;
            q += d;
          });
          tick += chunk;
          left -= chunk;
        }
      });
      if (pad) {
        while (tick < end) {
          const m = g.find(tick);
          const pos = tick - g.at(m).start;
          const M = g.at(m).len;
          if (pos === 0 && !g.at(m).pickup) {
            push(m, { part: pi, idx: p.events.length, pad: true, rest: true, full: true, tick, pos, dur: M });
            tick += M;
          } else {
            let q = pos;
            for (const d of decompose(M - pos, pos + g.at(m).off)) {
              push(m, { part: pi, idx: p.events.length, pad: true, rest: true, tick: g.at(m).start + q, pos: q, dur: d });
              q += d;
            }
            tick = g.at(m).start + M;
          }
        }
      }
      return measures;
    });
    return { M: g.at(0).len, total, parts, grid: g, totalTicks: end };
  }

  // ---------- ABC記法（abcjs に渡す。表示と再生用） ----------

  function abcPitch(step, oct) {
    return oct >= 5 ? step.toLowerCase() + "'".repeat(oct - 5) : step + ','.repeat(4 - oct);
  }

  function lyricToken(text) {
    const t = String(text).replace(/[*|]/g, '').trim().replace(/\\/g, '').replace(/-/g, '\\-').replace(/_/g, '\\_').replace(/\s+/g, '~');
    return t || '*';
  }

  const oneLine = (s) => String(s || '').replace(/[\r\n]+/g, ' ').trim();

  // 戻り値の toks は「ABC文字列の何文字目〜何文字目が、どのパートの何番目の音符か」の対応表。
  // 画面側がクリックや色付けに使う。
  // lineStarts を渡すと、その小節番号（0始まり、弱起の小節も1つと数える）で段を切る。
  // 原本と同じ段組で表示して見比べるとき用（tools/compare/compare.html）。
  function toAbc(score, { forEdit = false, lineStarts = null } = {}) {
    const L = layout(score, { forEdit });
    const toks = [];
    let out = 'X:1\n';
    if (oneLine(score.title)) out += `T:${oneLine(score.title)}\n`;
    if (oneLine(score.composer)) out += `C:${oneLine(score.composer)}\n`;
    out += `M:${score.time.beats}/${score.time.beatType}\nL:1/32\nQ:${abcTempo(score.tempo, score.time)}\n`;
    out += '%%stretchlast 1\n';
    out += `%%score [${score.parts.map((p) => p.id).join(' ')}]\n`;
    for (const p of score.parts) out += `V:${p.id} clef=${p.clef} name="${p.id}"\n`;
    out += `K:${keyName(score.key)}\n`;
    const hasKeyChange = (score.changes || []).some((c) => c.key);
    // パートごとに「直前の音符がタイで終わったか」を、小節や段をまたいで覚えておく
    const tieIn = score.parts.map(() => false);
    // 弱起の小節は1段目のおまけにする（1段目だけ1小節多い）
    const lineEnd = (s) => {
      if (lineStarts && lineStarts.length) {
        const n = lineStarts.find((b) => b > s);
        return Math.min(L.total, n === undefined ? L.total : n);
      }
      return Math.min(L.total, s + MEASURES_PER_LINE + (s === 0 && L.grid.at(0).pickup ? 1 : 0));
    };
    for (let s = 0; s < L.total; s = lineEnd(s)) {
      L.parts.forEach((measures, pi) => {
        const part = score.parts[pi];
        const shift = CLEF_ABC_SHIFT[part.clef] || 0;
        const lyrics = [];
        let hasLyric = false;
        out += `[V:${part.id}] `;
        // abcjs は段の途中の [K:] を、同じ段組の後ろのパートの行頭にまで効かせてしまう。
        // 転調のある曲では、行頭でその時点の調を言い直しておく。
        // [K:] は音部記号をト音に戻してしまうので、音部記号も毎回書く。
        if (hasKeyChange) out += `[K:${keyName(L.grid.at(s).key)} clef=${part.clef}]`;
        for (let m = s; m < lineEnd(s); m++) {
          const state = {};
          const gm = L.grid.at(m);
          const beat = beatOf(gm.time);
          if (m > 0 && gm.timeChanged) out += `[M:${gm.time.beats}/${gm.time.beatType}]`;
          if (m > 0 && gm.keyChanged) out += `[K:${keyName(gm.key)} clef=${part.clef}]`;
          // テンポは曲全体に効くので、いちばん上の段にだけ書く（全段に書くと記号が段の数だけ並ぶ）
          if (m > 0 && gm.tempoChanged && pi === 0) out += `[Q:${abcTempo(gm.tempo, gm.time)}]`;
          for (const it of measures[m]) {
            if (it.pos > 0 && (it.pos + gm.off) % beat === 0) out += ' ';
            const start = out.length;
            if (it.rest) {
              // abcjs は全音符ぶんの休符（z32 や Z）を「1小節休み」とみなし、長さを曲頭の拍子で数える。
              // 曲頭が4分の4拍子でない曲（3拍子で始まり途中から4拍子など）では、表示の小節線も再生のタイミングもずれる。
              // そういう曲では2分休符2つに分けて書く（5曲で表示と再生の両方を確認済み）
              out += it.dur === 32 && measureTicks(score) !== 32 ? 'z16z16' : 'z' + it.dur;
              tieIn[pi] = false;
            } else {
              const e = it.e;
              const k = e.step + e.oct;
              const current = k in state ? state[k] : keyAlter(gm.key, e.step);
              // 前の小節からタイで続く音は、臨時記号を書いても abcjs がその小節の臨時記号として数えない
              // （同じ小節の後ろの同じ音が調号どおりに鳴る）。続きの音は臨時記号を明示し、小節の状態には記録しない。
              // 記譜の決まりとしても、タイの続きの音の臨時記号は後ろの音に効かない。
              const tiedOver = tieIn[pi] && it.pos === 0;
              let acc = '';
              if (tiedOver) {
                if (e.alter !== keyAlter(gm.key, e.step)) acc = ACC[e.alter];
              } else if (e.alter !== current) {
                acc = ACC[e.alter];
                state[k] = e.alter;
              }
              out += acc + abcPitch(e.step, e.oct + shift) + it.dur + (it.tie ? '-' : '');
              tieIn[pi] = !!it.tie;
              if (it.first && e.lyric) {
                hasLyric = true;
                lyrics.push(lyricToken(e.lyric));
              } else {
                lyrics.push('*');
              }
            }
            toks.push({ start, end: out.length, part: pi, idx: it.idx, tick: it.tick, pad: !!it.pad, rest: it.rest });
          }
          out += m === L.total - 1 && !forEdit ? '|]' : '|';
        }
        out += '\n';
        if (hasLyric) out += 'w: ' + lyrics.join(' ') + '\n';
      });
    }
    return { abc: out, toks, total: L.total, M: L.M, grid: L.grid, totalTicks: L.totalTicks };
  }

  // ---------- 保存用JSON（パート→小節→音符。MusicXML とほぼ同じ構造） ----------

  function toJson(score) {
    const L = layout(score, { pad: false });
    return {
      format: 'score-editor',
      version: 1,
      ensemble: score.ensemble,
      title: score.title,
      composer: score.composer,
      key: { ...score.key },
      time: { ...score.time },
      tempo: score.tempo,
      divisions: DIV,
      instrument: score.instrument,
      pickup: pickupTicks(score),
      changes: (score.changes || []).map((c) => ({ ...c })),
      parts: score.parts.map((p, pi) => ({
        id: p.id,
        name: p.name,
        clef: p.clef,
        measures: L.parts[pi]
          .map((items, m) => ({
            number: L.grid.at(m).number,
            ...(L.grid.at(m).pickup ? { implicit: true } : {}),
            notes: items.map((it) => {
              const n = it.rest
                ? { rest: true, duration: it.dur }
                : { step: it.e.step, alter: it.e.alter, octave: it.e.oct, duration: it.dur };
              if (it.userTie) n.tie = true;
              if (it.cont) n.cont = true; // 小節線などで自動分割された続き（読み込み時に1つの音符へ戻す）
              if (!it.rest && it.first && it.e.lyric) n.lyric = it.e.lyric;
              return n;
            }),
          }))
          .filter((m) => m.notes.length),
      })),
    };
  }

  function fromJson(obj) {
    if (!obj || obj.format !== 'score-editor' || !Array.isArray(obj.parts)) {
      throw new Error('このエディタの楽譜ファイルではありません');
    }
    const score = newScore(obj.ensemble);
    score.title = obj.title || '';
    score.composer = obj.composer || '';
    if (obj.key && Number.isInteger(obj.key.fifths) && Math.abs(obj.key.fifths) <= 7) {
      score.key = { fifths: obj.key.fifths, mode: obj.key.mode === 'minor' ? 'minor' : 'major' };
    }
    if (obj.time && obj.time.beats > 0 && [2, 4, 8].includes(obj.time.beatType)) {
      score.time = { beats: obj.time.beats, beatType: obj.time.beatType };
    }
    if (obj.tempo > 0) score.tempo = Math.round(obj.tempo);
    if (obj.instrument) score.instrument = obj.instrument;
    if (obj.pickup > 0) score.pickup = Math.round(obj.pickup * (DIV / (obj.divisions || DIV)));
    score.changes = (Array.isArray(obj.changes) ? obj.changes : [])
      .filter((c) => c && Number.isInteger(c.measure) && c.measure > 0)
      .map((c) => {
        const out = { measure: c.measure };
        if (c.time && c.time.beats > 0 && [2, 4, 8].includes(c.time.beatType)) out.time = { beats: c.time.beats, beatType: c.time.beatType };
        if (c.key && Number.isInteger(c.key.fifths) && Math.abs(c.key.fifths) <= 7) out.key = { fifths: c.key.fifths, mode: c.key.mode === 'minor' ? 'minor' : 'major' };
        if (c.tempo > 0) out.tempo = Math.round(c.tempo);
        return out;
      });
    const scale = DIV / (obj.divisions || DIV);
    score.parts.forEach((part, pi) => {
      const src = obj.parts.find((p) => p.id === part.id) || obj.parts[pi];
      if (!src) return;
      let open = null;
      for (const m of src.measures || []) {
        for (const n of m.notes || []) {
          const dur = Math.round(n.duration * scale);
          if (!(dur > 0)) continue;
          if (open) {
            open.dur += dur;
          } else {
            open = n.rest
              ? { rest: true, dur }
              : { step: n.step, alter: n.alter || 0, oct: n.octave, dur, tie: false, lyric: n.lyric || '' };
            if (!open.rest && !(open.step in STEP_SEMI && Number.isInteger(open.oct))) {
              throw new Error(`音符の内容が正しくありません（${part.name} ${m.number}小節）`);
            }
            part.events.push(open);
          }
          if (!n.cont) {
            if (!open.rest) open.tie = !!n.tie;
            open = null;
          }
        }
      }
    });
    return score;
  }

  // ---------- MusicXML 書き出し ----------

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function durationType(d) {
    if (TYPE_NAMES[d]) return { type: TYPE_NAMES[d], dot: false };
    return { type: TYPE_NAMES[(d * 2) / 3], dot: true };
  }

  function toMusicXml(score) {
    const L = layout(score, {});
    const x = [];
    x.push('<?xml version="1.0" encoding="UTF-8"?>');
    x.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
    x.push('<score-partwise version="4.0">');
    if (score.title) x.push(`  <work><work-title>${esc(score.title)}</work-title></work>`);
    x.push('  <identification>');
    if (score.composer) x.push(`    <creator type="composer">${esc(score.composer)}</creator>`);
    x.push('    <encoding><software>score-editor</software></encoding>');
    x.push('  </identification>');
    x.push('  <part-list>');
    x.push('    <part-group type="start" number="1"><group-symbol>bracket</group-symbol><group-barline>yes</group-barline></part-group>');
    score.parts.forEach((p, i) => {
      x.push(`    <score-part id="P${i + 1}"><part-name>${esc(p.name)}</part-name><part-abbreviation>${esc(p.id)}</part-abbreviation></score-part>`);
    });
    x.push('    <part-group type="stop" number="1"/>');
    x.push('  </part-list>');
    score.parts.forEach((p, pi) => {
      x.push(`  <part id="P${pi + 1}">`);
      L.parts[pi].forEach((items, m) => {
        x.push(`    <measure number="${L.grid.at(m).number}"${L.grid.at(m).pickup ? ' implicit="yes"' : ''}>`);
        if (m === 0) {
          const clef = p.clef === 'bass'
            ? '<sign>F</sign><line>4</line>'
            : '<sign>G</sign><line>2</line>' + (p.clef === 'treble-8' ? '<clef-octave-change>-1</clef-octave-change>' : '');
          x.push('      <attributes>');
          x.push(`        <divisions>${DIV}</divisions>`);
          x.push(`        <key><fifths>${score.key.fifths}</fifths><mode>${score.key.mode}</mode></key>`);
          x.push(`        <time><beats>${score.time.beats}</beats><beat-type>${score.time.beatType}</beat-type></time>`);
          x.push(`        <clef>${clef}</clef>`);
          x.push('      </attributes>');
          if (pi === 0) {
            x.push('      <direction placement="above">');
            x.push(`        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type>`);
            x.push(`        <sound tempo="${score.tempo}"/>`);
            x.push('      </direction>');
          }
        }
        const gm = L.grid.at(m);
        if (m > 0 && gm.tempoChanged && pi === 0) {
          x.push('      <direction placement="above">');
          x.push(`        <direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${gm.tempo}</per-minute></metronome></direction-type>`);
          x.push(`        <sound tempo="${gm.tempo}"/>`);
          x.push('      </direction>');
        }
        if (m > 0 && (gm.timeChanged || gm.keyChanged)) {
          x.push('      <attributes>');
          if (gm.keyChanged) x.push(`        <key><fifths>${gm.key.fifths}</fifths><mode>${gm.key.mode}</mode></key>`);
          if (gm.timeChanged) x.push(`        <time><beats>${gm.time.beats}</beats><beat-type>${gm.time.beatType}</beat-type></time>`);
          x.push('      </attributes>');
        }
        for (const it of items) {
          x.push('      <note>');
          if (it.rest) {
            x.push(it.full ? '        <rest measure="yes"/>' : '        <rest/>');
          } else {
            const e = it.e;
            x.push(`        <pitch><step>${e.step}</step>${e.alter ? `<alter>${e.alter}</alter>` : ''}<octave>${e.oct}</octave></pitch>`);
          }
          x.push(`        <duration>${it.dur}</duration>`);
          if (it.tieIn) x.push('        <tie type="stop"/>');
          if (it.tie) x.push('        <tie type="start"/>');
          x.push('        <voice>1</voice>');
          if (!it.full) {
            const t = durationType(it.dur);
            x.push(`        <type>${t.type}</type>`);
            if (t.dot) x.push('        <dot/>');
          }
          if (it.tieIn || it.tie) {
            x.push(`        <notations>${it.tieIn ? '<tied type="stop"/>' : ''}${it.tie ? '<tied type="start"/>' : ''}</notations>`);
          }
          if (!it.rest && it.first && it.e.lyric) {
            x.push(`        <lyric number="1"><syllabic>single</syllabic><text>${esc(it.e.lyric)}</text></lyric>`);
          }
          x.push('      </note>');
        }
        if (m === L.total - 1) x.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>');
        x.push('    </measure>');
      });
      x.push('  </part>');
    });
    x.push('</score-partwise>');
    return x.join('\n') + '\n';
  }

  const api = {
    DIV, MAJOR, MINOR, STEP_SEMI, ENSEMBLES,
    newScore, setEnsemble, keyName, keyAlter, midi, samePitch, measureTicks, beatTicks, partTicks,
    pickupTicks, setPickup, grid, setChange, deleteMeasures, secondsAt, layout, toAbc, toJson, fromJson, toMusicXml,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScoreModel = api;
})(typeof self !== 'undefined' ? self : this);
