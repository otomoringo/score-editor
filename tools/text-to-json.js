// 手書きの簡易記法（1行=1小節）から、このエディタのJSONを作る。
//   node tools/text-to-json.js 入力.txt 出力.json
//
// 記法:
//   # で始まる行はコメント。「@title 曲名」「@tempo 90」「@part S」
//   「@key -4」（♭4つ。♯は正の数）「@time 5/4」は、次の小節からの調・拍子
//   音符は「音名+オクターブ:長さ」。例 e5:e  a4:q.  c6:s~
//     長さ w=全 h=2分 q=4分 e=8分 s=16分、末尾の . は付点、~ は次の音へのタイ
//     音名は調号どおりに♯♭が付く。n=ナチュラル、#=シャープ、b=フラットを音名の直後に書ける（例 en5, c#6）
//   休符は r:長さ
//   「@pickup q」は弱起（アウフタクト）。長さは音符と同じ書き方。最初の小節より前に書く。1行目が弱起の小節になる
//   「=3-4」のように書くと、それまでに書いた小節（1始まりの通し番号）をそのまま繰り返す
const fs = require('fs');
const path = require('path');
const M = require(path.join(__dirname, '..', 'model.js'));

const [, , inFile, outFile] = process.argv;
if (!inFile || !outFile) {
  console.error('使い方: node tools/text-to-json.js 入力.txt 出力.json');
  process.exit(1);
}

const DUR = { w: 32, h: 16, q: 8, e: 4, s: 2 };
const score = M.newScore();
let partId = 'S';
let key = score.key;
let time = score.time;
let first = true;
const measures = []; // {events, key, time}
const problems = [];

function parseMeasure(line, lineNo) {
  const events = [];
  for (const tok of line.trim().split(/\s+/)) {
    const m = /^(?:(r)|([a-g])([n#b]?)(\d)):([whqes])(\.?)(~?)$/.exec(tok);
    if (!m) throw new Error(`${lineNo}行目: 読めない記号「${tok}」`);
    const dur = DUR[m[5]] * (m[6] ? 1.5 : 1);
    if (m[1]) {
      events.push({ rest: true, dur });
    } else {
      const step = m[2].toUpperCase();
      const alter = m[3] === 'n' ? 0 : m[3] === '#' ? 1 : m[3] === 'b' ? -1 : M.keyAlter(key, step);
      events.push({ step, alter, oct: Number(m[4]), dur, tie: !!m[7], lyric: '' });
    }
  }
  return events;
}

fs.readFileSync(inFile, 'utf8').split(/\r?\n/).forEach((raw, i) => {
  const line = raw.trim();
  const lineNo = i + 1;
  if (!line || line.startsWith('#')) return;
  if (line.startsWith('@')) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'title') score.title = arg;
    else if (cmd === 'tempo') score.tempo = Number(arg);
    else if (cmd === 'part') partId = arg;
    else if (cmd === 'pickup') {
      const m = /^([whqes])(\.?)$/.exec(arg);
      if (!m) throw new Error(`${lineNo}行目: 弱起の長さ「${arg}」が読めません`);
      score.pickup = DUR[m[1]] * (m[2] ? 1.5 : 1);
    }
    else if (cmd === 'key') {
      key = { fifths: Number(arg), mode: 'major' };
      if (first) score.key = key; else score.changes.push({ measure: measures.length, key });
    } else if (cmd === 'time') {
      const [b, t] = arg.split('/').map(Number);
      time = { beats: b, beatType: t };
      if (first) score.time = time; else score.changes.push({ measure: measures.length, time });
    } else throw new Error(`${lineNo}行目: 知らない指定「@${cmd}」`);
    return;
  }
  first = false;
  const rep = /^=(\d+)(?:-(\d+))?$/.exec(line);
  if (rep) {
    const from = Number(rep[1]);
    const to = Number(rep[2] || rep[1]);
    for (let n = from; n <= to; n++) {
      const src = measures[n - 1];
      if (!src) throw new Error(`${lineNo}行目: ${n}小節はまだありません`);
      // 調が変わっていたら、調号で付いた♯♭を今の調で付け直す
      const events = src.events.map((e) => (e.rest || e.alter !== M.keyAlter(src.key, e.step) ? { ...e } : { ...e, alter: M.keyAlter(key, e.step) }));
      measures.push({ events, key, time });
    }
    return;
  }
  const events = parseMeasure(line, lineNo);
  const len = events.reduce((s, e) => s + e.dur, 0);
  const want = (!measures.length && M.pickupTicks(score)) || (time.beats * 32) / time.beatType;
  if (len !== want) problems.push(`${measures.length + 1}小節（${lineNo}行目）: 長さが合いません（${len / 8}拍。正しくは${want / 8}拍）`);
  measures.push({ events, key, time });
});

const part = score.parts.find((p) => p.id === partId);
part.events = measures.flatMap((m) => m.events);
fs.writeFileSync(outFile, JSON.stringify(M.toJson(score), null, 1));
console.log(`${measures.length}小節を ${outFile} に書き出しました`);
if (problems.length) {
  console.log('長さの合わない小節:');
  for (const p of problems) console.log('  ' + p);
  process.exitCode = 2;
}
