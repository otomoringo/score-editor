// 和音の分析: 同じ拍で鳴っている音からコード名を判定し、調の中での度数（ローマ数字）と機能（T/S/D）を求める。
// 画面に依存しないので Node からも require で読み込める。
(function (root) {
  'use strict';
  const M = typeof module !== 'undefined' && module.exports ? require('./model.js') : root.ScoreModel;

  const STEPS = 'CDEFGAB';
  const ACC = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '♯♯' };
  const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
  const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];
  const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  // その調の音階の上にできる三和音（副属和音の行き先を書くのに使う）
  const DIATONIC = { major: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'], minor: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'] };
  const FUNCTION = { major: ['T', 'S', 'T', 'S', 'D', 'T', 'D'], minor: ['T', 'S', 'T', 'S', 'D', 'T', 'D'] };

  // 上にあるものほど優先。iv は根音からの半音数。lower はローマ数字を小文字で書く和音。
  // mark は度数に付ける記号、seventh は七の和音（転回形の数字が変わる）。
  const TEMPLATES = [
    { suffix: '', iv: [0, 4, 7], mark: '' },
    { suffix: 'm', iv: [0, 3, 7], lower: true, mark: '' },
    { suffix: '7', iv: [0, 4, 7, 10], mark: '', seventh: true, dominant: true },
    { suffix: 'm7', iv: [0, 3, 7, 10], lower: true, mark: '', seventh: true },
    { suffix: 'maj7', iv: [0, 4, 7, 11], mark: 'M', seventh: true },
    { suffix: 'dim', iv: [0, 3, 6], lower: true, mark: '°' },
    { suffix: 'm7♭5', iv: [0, 3, 6, 10], lower: true, mark: 'ø', seventh: true },
    { suffix: 'dim7', iv: [0, 3, 6, 9], lower: true, mark: '°', seventh: true },
    { suffix: 'aug', iv: [0, 4, 8], mark: '+' },
    { suffix: 'mMaj7', iv: [0, 3, 7, 11], lower: true, mark: 'M', seventh: true },
    { suffix: '6', iv: [0, 4, 7, 9], mark: '', figure: 'add6' },
    { suffix: 'm6', iv: [0, 3, 7, 9], lower: true, mark: '', figure: 'add6' },
    { suffix: 'sus4', iv: [0, 5, 7], mark: '', figure: 'sus4' },
    { suffix: '7sus4', iv: [0, 5, 7, 10], mark: '', figure: '7sus4' },
    // 第5音を省いた七の和音
    { suffix: '7', iv: [0, 4, 10], mark: '', seventh: true, dominant: true },
    { suffix: 'm7', iv: [0, 3, 10], lower: true, mark: '', seventh: true },
    { suffix: 'maj7', iv: [0, 4, 11], mark: 'M', seventh: true },
    { suffix: '7', iv: [0, 7, 10], mark: '', seventh: true, dominant: true },
    // 2音だけ（3度は三和音とみなす。5度だけなら長短は決めない）
    { suffix: '', iv: [0, 4], mark: '' },
    { suffix: 'm', iv: [0, 3], lower: true, mark: '' },
    { suffix: '5', iv: [0, 7], mark: '', figure: '5' },
  ];

  const mod12 = (n) => ((n % 12) + 12) % 12;
  const noteName = (e) => e.step + ACC[e.alter];

  function tonicOf(key) {
    const name = key.mode === 'minor' ? M.MINOR[key.fifths + 7] : M.MAJOR[key.fifths + 7];
    const alter = name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0;
    return { step: STEPS.indexOf(name[0]), pc: mod12(M.STEP_SEMI[name[0]] + alter) };
  }

  // tick の時点で鳴っている音符（休符は除く）
  function soundingAt(score, tick, activeParts) {
    const out = [];
    score.parts.forEach((p, pi) => {
      if (activeParts && !activeParts[pi]) return;
      let t = 0;
      for (const e of p.events) {
        if (tick < t + e.dur) {
          if (tick >= t && !e.rest) out.push(e);
          break;
        }
        t += e.dur;
      }
    });
    return out;
  }

  // 音符の集まりからコードを判定する。判定できなければ null。
  function identify(notes) {
    if (notes.length < 2) return null;
    const sorted = [...notes].sort((a, b) => M.midi(a) - M.midi(b));
    const names = {};
    const steps = {};
    for (const e of sorted) {
      const pc = mod12(M.midi(e));
      if (!(pc in names)) { names[pc] = noteName(e); steps[pc] = STEPS.indexOf(e.step); }
    }
    const pcs = Object.keys(names).map(Number);
    if (pcs.length < 2) return null;
    const bass = mod12(M.midi(sorted[0]));
    let best = null;
    for (const r of pcs) {
      const rel = pcs.map((pc) => mod12(pc - r)).sort((a, b) => a - b).join(',');
      TEMPLATES.forEach((t, prio) => {
        if (t.iv.join(',') !== rel) return;
        const cost = prio + (r === bass ? 0 : 100);
        if (!best || cost < best.cost) best = { cost, root: r, t };
      });
    }
    if (!best) return null;
    const { root, t } = best;
    return {
      root,
      rootStep: steps[root],
      bass,
      template: t,
      bassInterval: mod12(bass - root),
      name: names[root] + t.suffix + (bass === root ? '' : '/' + names[bass]),
    };
  }

  // 転回形の数字（数字付き低音）
  function inversionFigure(chord) {
    const t = chord.template;
    if (t.figure) return t.figure;
    const iv = chord.bassInterval;
    const third = iv === 3 || iv === 4;
    const fifth = iv === 6 || iv === 7 || iv === 8;
    if (t.seventh) return iv === 0 ? '7' : third ? '65' : fifth ? '43' : '42';
    return iv === 0 ? '' : third ? '6' : fifth ? '64' : '';
  }

  // 調の中での度数（ローマ数字）と機能を求める
  function romanOf(chord, key) {
    const tonic = tonicOf(key);
    const scale = key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
    const degree = (chord.rootStep - tonic.step + 7) % 7;
    const diff = ((chord.root - tonic.pc - scale[degree] + 18) % 12) - 6;
    const t = chord.template;
    // 短調の第7音は、導音（半音上げた音）もそのまま VII と書く
    const leading = key.mode === 'minor' && degree === 6 && diff === 1;
    const altered = diff !== 0 && !leading;
    // 属七の形をした和音が V 以外にあれば、副属和音（V7/行き先）とみなす
    if (t.dominant && !(degree === 4 && !altered)) {
      const target = mod12(chord.root + 5 - tonic.pc);
      const d = scale.indexOf(target);
      if (d >= 0) {
        const fig = inversionFigure(chord);
        return { roman: 'V' + fig + '/' + DIATONIC[key.mode][d], func: 'D', secondary: true };
      }
    }
    let numeral = NUMERALS[degree];
    if (t.lower) numeral = numeral.toLowerCase();
    const prefix = !altered ? '' : diff === -1 ? '♭' : diff === 1 ? '♯' : '?';
    const roman = prefix + numeral + t.mark + inversionFigure(chord);
    return { roman, func: altered ? '' : FUNCTION[key.mode][degree] };
  }

  function describe(score, tick, key, activeParts) {
    const chord = identify(soundingAt(score, tick, activeParts));
    if (!chord) return null;
    return { tick, name: chord.name, ...romanOf(chord, key) };
  }

  // 曲全体を拍ごとに調べ、和音が変わった拍だけを返す
  function analyze(score) {
    const g = M.grid(score);
    const end = Math.max(0, ...score.parts.map(M.partTicks));
    const out = [];
    let prev = '';
    for (let m = 0; g.at(m).start < end; m++) {
      const gm = g.at(m);
      const beat = gm.time.beatType === 8 && gm.time.beats % 3 === 0 ? 12 : 32 / gm.time.beatType;
      for (let pos = 0; pos < gm.len; pos++) {
        if ((pos + gm.off) % beat !== 0) continue;
        const tick = gm.start + pos;
        if (tick >= end) break;
        const d = describe(score, tick, gm.key);
        const sig = d ? d.name + '|' + d.roman : '';
        if (d && sig !== prev) out.push(d);
        prev = sig;
      }
    }
    return out;
  }

  // 音が調の主音・下属音・属音のどれに当たるか（当たらなければ 0）
  function scaleRole(e, key) {
    const d = mod12(M.midi(e) - tonicOf(key).pc);
    return d === 0 ? 1 : d === 5 ? 4 : d === 7 ? 5 : 0;
  }

  const api = { identify, soundingAt, romanOf, describe, analyze, scaleRole, tonicOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScoreHarmony = api;
})(typeof self !== 'undefined' ? self : this);
