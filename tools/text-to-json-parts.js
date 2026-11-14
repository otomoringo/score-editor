// 複数パート・歌詞つきの簡易記法（1行=1小節）から、このエディタのJSONを作る。
//   node tools/text-to-json-parts.js 入力.txt 出力.json
//
// 記法（tools/text-to-json.js と同じものに、次を足した）:
//   「@ensemble female」（mixed / female / male）「@composer 名前」
//   「@part S1」でパートを切り替える。どのパートも1小節目から書く
//   「@key」「@time」は最初のパートに書く。2つ目以降のパートでは書かなくてよい（小節番号で引き継ぐ）
//   「@pickup q」は弱起（アウフタクト）。長さは音符と同じ書き方（q=4分、e=8分、q.=付点4分 など）。
//     最初のパートより前に書く。どのパートも1行目が弱起の小節になる
//   「@fill A2」は、そのパートを曲の長さぶんの休符で埋める
//   音符の後ろに「/歌詞」を付けられる。例 g4:h/God  c5:q/un-
//   「=3-4」は、同じパートの小節をそのまま繰り返す。「=S1:3-4」は別パートの小節を写す
const fs = require('fs');
const path = require('path');
const M = require(path.join(__dirname, '..', 'model.js'));

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('使い方: node tools/text-to-json-parts.js 入力.txt 出力.json');
  process.exit(1);
}

const DUR = { w: 32, h: 16, q: 8, e: 4, s: 2 };
const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/);
const head = {};
for (const raw of lines) {
  const m = /^@(ensemble|title|composer|tempo|pickup)\s+(.*)$/.exec(raw.trim());
  if (m) head[m[1]] = m[2].trim();
}
const score = M.newScore(head.ensemble || 'mixed');
score.title = head.title || '';
score.composer = head.composer || '';
if (head.tempo) score.tempo = Number(head.tempo);

const parts = {}; // id -> [{events}]
const fills = [];
const problems = [];
let partId = score.parts[0].id;
let firstPart = null;
let pickup = 0;
const grid = () => M.grid(score);

function parseMeasure(line, lineNo, key) {
  const events = [];
  for (const tok of line.trim().split(/\s+/)) {
    const m = /^(?:(r)|([a-g])([n#b]?)(\d)):([whqes])(\.?)(~?)(?:\/(.+))?$/.exec(tok);
    if (!m) throw new Error(`${lineNo}行目: 読めない記号「${tok}」`);
    const dur = DUR[m[5]] * (m[6] ? 1.5 : 1);
    if (m[1]) {
      events.push({ rest: true, dur });
    } else {
      const step = m[2].toUpperCase();
      const alter = m[3] === 'n' ? 0 : m[3] === '#' ? 1 : m[3] === 'b' ? -1 : M.keyAlter(key, step);
      events.push({ step, alter, oct: Number(m[4]), dur, tie: !!m[7], lyric: m[8] || '' });
    }
  }
  return events;
}

lines.forEach((raw, i) => {
  const line = raw.trim();
  const lineNo = i + 1;
  if (!line || line.startsWith('#')) return;
  if (line.startsWith('@')) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'pickup') {
      // 拍子が決まってからでないと長さを確かめられないので、最初の小節を読む直前に反映する
      const m = /^([whqes])(\.?)$/.exec(arg);
      if (!m) throw new Error(`${lineNo}行目: 弱起の長さ「${arg}」が読めません`);
      pickup = DUR[m[1]] * (m[2] ? 1.5 : 1);
      return;
    }
    if (['ensemble', 'title', 'composer', 'tempo'].includes(cmd)) return;
    if (cmd === 'part') {
      if (!score.parts.find((p) => p.id === arg)) throw new Error(`${lineNo}行目: パート「${arg}」はこの編成にありません`);
      partId = arg;
      if (!firstPart) firstPart = arg;
      parts[partId] = parts[partId] || [];
    } else if (cmd === 'fill') {
      fills.push(arg);
    } else if (cmd === 'key' || cmd === 'time') {
      if (firstPart && partId !== firstPart) return; // 2つ目以降のパートでは無視
      const at = (parts[partId] || []).length;
      let patch;
      if (cmd === 'key') patch = { key: { fifths: Number(arg), mode: 'major' } };
      else { const [b, t] = arg.split('/').map(Number); patch = { time: { beats: b, beatType: t } }; }
      M.setChange(score, at, patch);
    } else throw new Error(`${lineNo}行目: 知らない指定「@${cmd}」`);
    return;
  }
  if (!firstPart) { firstPart = partId; }
  if (pickup && !score.pickup) {
    score.pickup = pickup;
    if (!M.pickupTicks(score)) throw new Error(`${lineNo}行目: 弱起が1小節以上の長さになっています`);
  }
  const list = parts[partId] || (parts[partId] = []);
  const rep = /^=(?:([A-Za-z0-9]+):)?(\d+)(?:-(\d+))?$/.exec(line);
  if (rep) {
    const srcList = rep[1] ? parts[rep[1]] : list;
    if (!srcList) throw new Error(`${lineNo}行目: パート「${rep[1]}」はまだありません`);
    const from = Number(rep[2]);
    const to = Number(rep[3] || rep[2]);
    for (let n = from; n <= to; n++) {
      const src = srcList[n - 1];
      if (!src) throw new Error(`${lineNo}行目: ${n}小節はまだありません`);
      list.push({ events: src.events.map((e) => ({ ...e })) });
    }
    return;
  }
  const g = grid().at(list.length);
  const events = parseMeasure(line, lineNo, g.key);
  const len = events.reduce((s, e) => s + e.dur, 0);
  if (len !== g.len) problems.push(`${partId} ${list.length + 1}小節（${lineNo}行目）: 長さが合いません（${len / 8}拍。正しくは${g.len / 8}拍）`);
  list.push({ events });
});

const total = Math.max(...Object.values(parts).map((l) => l.length));
for (const [id, list] of Object.entries(parts)) {
  if (list.length !== total) problems.push(`${id}: 小節数が ${list.length}（ほかのパートは ${total}）`);
}
for (const id of fills) {
  const G = grid();
  parts[id] = [];
  for (let m = 0; m < total; m++) parts[id].push({ events: [{ rest: true, dur: G.at(m).len }] });
}
for (const p of score.parts) p.events = (parts[p.id] || []).flatMap((m) => m.events);
fs.writeFileSync(outFile, JSON.stringify(M.toJson(score), null, 1));
console.log(`${total}小節 × ${Object.keys(parts).length}パートを ${outFile} に書き出しました`);
if (problems.length) {
  console.log('問題:');
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 2;
}
