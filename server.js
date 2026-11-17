// 简易局域网影音服务器：零依赖，Node 18+，需要 ffmpeg/ffprobe 在 PATH 中
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const cfg = Object.assign({
  root: 'E:\\',
  port: 8090,
  password: '',
  exclude: ['$RECYCLE.BIN', 'System Volume Information', 'media-server'],
  rescanMinutes: 10,
  allowDelete: true, // 网页上能否删除（移到回收站）
}, fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {});

const ROOT = path.resolve(cfg.root);
const CACHE = path.join(__dirname, '.cache');
const THUMBS = path.join(CACHE, 'thumbs');
const HLS_DIR = path.join(CACHE, 'hls');
const PROBE_FILE = path.join(CACHE, 'probe.json');
const PUBLIC = path.join(__dirname, 'public');
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.wmv', '.flv', '.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.rmvb', '.rm', '.3gp', '.vob']);
const SEG = 6; // HLS 分片秒数
const excludeSet = new Set(cfg.exclude.map(s => s.toLowerCase()));

fs.mkdirSync(THUMBS, { recursive: true });
fs.rmSync(HLS_DIR, { recursive: true, force: true });
fs.mkdirSync(HLS_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

function run(cmd, args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 50e6, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(stdout));
  });
}

function limiter(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

// ---------- 扫描 ----------
let files = [];            // [{p, name, dir, size, mtime}]
let fileMap = new Map();
let scanning = null;

// ---------- 字幕 ----------
const SUB_EXT = { '.ass': 0, '.ssa': 1, '.vtt': 2, '.srt': 3 }; // 数字越小越优先（同一语言多种格式时，ASS 带样式优先）
const TEXT_SUB_CODECS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const LANG_NAMES = {
  'zh-cn': '中文', zh: '中文', chs: '中文', sc: '中文', chi: '中文', zho: '中文', 'zh-hans': '中文', '简体': '中文', 'zh-tw': '繁体', 'zh-hk': '繁体', cht: '繁体', tc: '繁体', 'zh-hant': '繁体', '繁体': '繁体',
  ja: '日文', jp: '日文', jpn: '日文', en: '英文', eng: '英文', ko: '韩文', kor: '韩文',
  source: '原文', bilingual: '双语', default: '默认', forced: '强制',
};
const stripExt = n => n.slice(0, n.length - path.extname(n).length);

function subLabel(rest) {
  if (!rest) return '默认';
  return rest.split(/[.\s_]+/).filter(Boolean).map(x => LANG_NAMES[x.toLowerCase()] || x).join('·');
}

// 找出属于某个视频的外挂字幕：同目录下以“视频名.”开头的字幕；目录里只有一个视频时，所有字幕都归它
function matchSubs(videoName, names, videoCount) {
  const base = stripExt(videoName).toLowerCase();
  const byLabel = new Map();
  for (const n of names) {
    const ext = path.extname(n).toLowerCase();
    if (!(ext in SUB_EXT)) continue;
    const b = stripExt(n), bl = b.toLowerCase();
    let rest;
    if (bl === base) rest = '';
    else if (bl.startsWith(base + '.')) rest = b.slice(base.length + 1);
    else if (videoCount === 1) rest = b;
    else continue;
    const label = subLabel(rest);
    const old = byLabel.get(label);
    if (!old || SUB_EXT[ext] < SUB_EXT[path.extname(old).toLowerCase()]) byLabel.set(label, n);
  }
  return [...byLabel].map(([label, name]) => ({ label, name }))
    .sort((a, b) => subRank(a.label) - subRank(b.label) || a.label.localeCompare(b.label, 'zh'));
}
const subRank = l => (l === '中文' ? 0 : l.startsWith('中文') ? 1 : /双语/.test(l) ? 2 : l === '原文' ? 9 : 5);

async function dirListing(absDir) {
  try { return await fsp.readdir(absDir); } catch { return []; }
}

// 一个视频的全部字幕：外挂文件 + 内嵌的文字字幕流
async function subsFor(f, info) {
  const absDir = path.dirname(absOf(f));
  const names = await dirListing(absDir);
  const videoCount = names.filter(n => VIDEO_EXT.has(path.extname(n).toLowerCase())).length;
  const list = matchSubs(f.name, names, videoCount).map(s => ({ label: s.label, file: path.join(absDir, s.name) }));
  for (const s of (info && info.subs) || []) {
    const lang = s.lang ? (LANG_NAMES[s.lang.toLowerCase()] || s.lang) : '';
    list.push({ label: '内嵌' + (s.title ? '·' + s.title : lang ? '·' + lang : '#' + (s.n + 1)), stream: s.n, codec: s.codec });
  }
  return list;
}

function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.slice(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gb18030').decode(buf); } catch {}
  return buf.toString('latin1');
}

const vttTime = sec => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = ms / 3600000 | 0, m = (ms % 3600000) / 60000 | 0, s = (ms % 60000) / 1000 | 0;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
// 中日文字幕常按固定字数硬换行，手机上会被二次折行；把同一语言的连续行接回去，交给浏览器自动换行
// （双语字幕里中文行和日文行按有无假名区分，仍分开显示）
function joinCjkLines(text) {
  const cjk = l => /[\u3040-\u30ff\u3400-\u9fff]/.test(l);
  const kana = l => /[\u3040-\u30ff]/.test(l);
  const out = [];
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (prev && cjk(prev) && cjk(line) && kana(prev) === kana(line) && !/^[-－–—]/.test(line)) out[out.length - 1] = prev + line;
    else out.push(line);
  }
  return out.join('\n');
}
const cleanCueText = t => joinCjkLines(t.replace(/<(?!\/?[biu]>)[^>]*>/gi, ''));

function srtToVtt(text) {
  const out = ['WEBVTT', ''];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex(l => /-->/.test(l));
    if (ti < 0) continue;
    const tm = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/.exec(lines[ti]);
    if (!tm) continue;
    const t = i => +tm[i] * 3600 + +tm[i + 1] * 60 + +tm[i + 2] + +('0.' + tm[i + 3]);
    const body = cleanCueText(lines.slice(ti + 1).join('\n'));
    if (body) out.push(`${vttTime(t(1))} --> ${vttTime(t(5))}`, body, '');
  }
  return out.join('\n');
}

// ---------- ASS 解析：保留样式（字体、字号、颜色、描边、阴影、粗斜体、对齐、边距）----------
// 输出 WebVTT：每段文字包在 <c.kN> 里，样式表另由 /sub?fmt=style 以 JSON 给前端；
// cue 的 id 写成 "cN 对齐 左边距 右边距 垂直边距 [pos.x pos.y]"，供前端定位
function assColor(s, def) {
  const m = /&?H?([0-9a-f]{1,8})/i.exec(s || '');
  if (!m) return def;
  const v = m[1].padStart(8, '0');
  const a = parseInt(v.slice(0, 2), 16), b = parseInt(v.slice(2, 4), 16), g = parseInt(v.slice(4, 6), 16), r = parseInt(v.slice(6, 8), 16);
  return a === 0 ? '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('') : `rgba(${r},${g},${b},${+(1 - a / 255).toFixed(3)})`;
}
const legacyAlign = a => { a = +a; return a >= 9 ? a - 5 : a >= 5 ? a + 2 : a; }; // v4 的 \a → \an

function parseAss(text) {
  const res = { resX: 0, resY: 0, styles: {}, cues: [], classes: {} };
  let section = '', sfmt = null, efmt = null, legacy = false;
  const tsec = s => { const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]) : 0; };
  const fields = (line, fmt) => {
    const parts = line.slice(line.indexOf(':') + 1).split(',');
    const rec = {};
    fmt.forEach((k, i) => { rec[k] = i === fmt.length - 1 ? parts.slice(i).join(',').replace(/^\s+/, '') : (parts[i] || '').trim(); });
    return rec;
  };
  const dialogues = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) { section = line.toLowerCase(); continue; }
    if (section === '[script info]') {
      let m;
      if ((m = /^playresx\s*:\s*(\d+)/i.exec(line))) res.resX = +m[1];
      else if ((m = /^playresy\s*:\s*(\d+)/i.exec(line))) res.resY = +m[1];
      else if (/^scripttype\s*:\s*v4\.00\s*$/i.test(line)) legacy = true;
    } else if (/styles\]$/.test(section)) {
      if (/^format\s*:/i.test(line)) sfmt = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase());
      else if (/^style\s*:/i.test(line) && sfmt) {
        const r = fields(line, sfmt);
        const bold = +r.bold;
        res.styles[r.name] = {
          fn: r.fontname || 'Arial', fs: +r.fontsize || 20,
          c: assColor(r.primarycolour, '#ffffff'), oc: assColor(r.outlinecolour, '#000000'), bc: assColor(r.backcolour, '#000000'),
          b: bold === -1 || bold === 1 || bold >= 600, i: +r.italic !== 0, u: +r.underline !== 0, s: +r.strikeout !== 0,
          bord: +r.outline || 0, shad: +r.shadow || 0, bs: +r.borderstyle || 1,
          an: legacy ? legacyAlign(r.alignment || 2) : (+r.alignment || 2),
          ml: +r.marginl || 0, mr: +r.marginr || 0, mv: +r.marginv || 0,
        };
      }
    } else if (section === '[events]') {
      if (/^format\s*:/i.test(line)) efmt = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase());
      else if (/^dialogue\s*:/i.test(line)) dialogues.push(fields(line, efmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']));
    }
  }
  if (!res.resX && !res.resY) { res.resX = 384; res.resY = 288; }
  else if (!res.resY) res.resY = res.resX === 1280 ? 1024 : Math.round(res.resX * 3 / 4);
  else if (!res.resX) res.resX = res.resY === 1024 ? 1280 : Math.round(res.resY * 4 / 3);
  const fallback = { fn: 'Arial', fs: 20, c: '#ffffff', oc: '#000000', bc: '#000000', b: false, i: false, u: false, s: false, bord: 2, shad: 2, bs: 1, an: 2, ml: 10, mr: 10, mv: 10 };
  const styleOf = name => res.styles[name] || res.styles[(name || '').replace(/^\*/, '')] || res.styles.Default || Object.values(res.styles)[0] || fallback;

  const classIds = new Map();
  const classOf = st => {
    const props = { fn: st.fn, fs: +(+st.fs).toFixed(2), c: st.c, oc: st.oc, bc: st.bc, b: st.b, i: st.i, u: st.u, s: st.s, bord: st.bord, shad: st.shad, bs: st.bs };
    const key = JSON.stringify(props);
    if (!classIds.has(key)) { const id = 'k' + classIds.size; classIds.set(key, id); res.classes[id] = props; }
    return classIds.get(key);
  };
  const flag = v => v === '' ? true : +v !== 0;

  for (const d of dialogues) {
    let t = d.text || '';
    if (/\{[^}]*\\p[1-9]/.test(t)) continue; // 绘图指令，不是文字
    const base = styleOf(d.style);
    let st = Object.assign({}, base), an = base.an, pos = null;
    const segs = [];
    const re = /\{([^}]*)\}|([^{]+)/g;
    let m;
    while ((m = re.exec(t))) {
      if (m[1] !== undefined) {
        const block = m[1].replace(/\\t\([^)]*\)/g, '');
        for (const tag of block.split('\\').slice(1)) {
          let x;
          if ((x = /^fn(.*)$/.exec(tag))) st.fn = x[1] || base.fn;
          else if ((x = /^fs([\d.]+)$/.exec(tag))) st.fs = +x[1];
          else if ((x = /^bord([\d.]+)$/.exec(tag))) st.bord = +x[1];
          else if ((x = /^shad([\d.]+)$/.exec(tag))) st.shad = +x[1];
          else if ((x = /^1?c(&?H[0-9a-f]+&?)$/i.exec(tag))) st.c = assColor(x[1], st.c);
          else if ((x = /^3c(&?H[0-9a-f]+&?)$/i.exec(tag))) st.oc = assColor(x[1], st.oc);
          else if ((x = /^4c(&?H[0-9a-f]+&?)$/i.exec(tag))) st.bc = assColor(x[1], st.bc);
          else if ((x = /^b(\d*)$/.exec(tag))) st.b = x[1] === '' ? base.b : (+x[1] === 1 || +x[1] >= 600);
          else if ((x = /^i(\d*)$/.exec(tag))) st.i = x[1] === '' ? base.i : flag(x[1]);
          else if ((x = /^u(\d*)$/.exec(tag))) st.u = x[1] === '' ? base.u : flag(x[1]);
          else if ((x = /^s(\d*)$/.exec(tag))) st.s = x[1] === '' ? base.s : flag(x[1]);
          else if ((x = /^r(.*)$/.exec(tag))) st = Object.assign({}, x[1] ? styleOf(x[1]) : base);
          else if ((x = /^an([1-9])$/.exec(tag))) an = +x[1];
          else if ((x = /^a(\d+)$/.exec(tag))) an = legacyAlign(x[1]);
          else if ((x = /^(?:pos|move)\(\s*([-\d.]+)\s*,\s*([-\d.]+)/.exec(tag))) pos = [+x[1], +x[2]];
        }
      } else {
        const s = m[2].replace(/\\N/g, '\n').replace(/\\n/g, ' ').replace(/\\h/g, '\u00a0');
        if (s) segs.push({ k: classOf(st), t: s });
      }
    }
    if (!segs.some(s => s.t.trim())) continue;
    res.cues.push({
      s: tsec(d.start), e: tsec(d.end), an,
      ml: +d.marginl || base.ml, mr: +d.marginr || base.mr, mv: +d.marginv || base.mv,
      pos, segs,
    });
  }
  res.cues.sort((a, b) => a.s - b.s);
  return res;
}

const vttEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function assToVtt(text) {
  const a = parseAss(text);
  const out = ['WEBVTT', ''];
  a.cues.forEach((c, n) => {
    const h = (c.an - 1) % 3, v = c.an >= 7 ? 0 : c.an >= 4 ? 1 : 2;
    const settings = [v === 0 ? 'line:0' : v === 1 ? 'line:50%' : '', h === 0 ? 'align:left' : h === 2 ? 'align:right' : ''].filter(Boolean).join(' ');
    const body = c.segs.map(s => `<c.${s.k}>${vttEsc(s.t)}</c>`).join('').replace(/^\n+|\n+$/g, '').replace(/\n{2,}/g, '\n');
    out.push(`c${n} ${c.an} ${c.ml} ${c.mr} ${c.mv}${c.pos ? ` ${c.pos[0]} ${c.pos[1]}` : ''}`,
      `${vttTime(c.s)} --> ${vttTime(c.e)}${settings ? ' ' + settings : ''}`, body, '');
  });
  return out.join('\n');
}

const SUBS_DIR = path.join(CACHE, 'subs');
fs.mkdirSync(SUBS_DIR, { recursive: true });
const subExtractLimit = limiter(2);
const subPending = new Map();

// 读出字幕原文，返回 { kind: 'ass'|'srt'|'vtt', text }；内嵌字幕先用 ffmpeg 提取（ASS 保持 ASS）
async function readSub(f, sub) {
  if (sub.file) {
    const text = decodeText(await fsp.readFile(sub.file));
    const ext = path.extname(sub.file).toLowerCase();
    return { kind: ext === '.vtt' ? 'vtt' : ext === '.srt' ? 'srt' : 'ass', text };
  }
  const isAss = sub.codec === 'ass' || sub.codec === 'ssa';
  const out = path.join(SUBS_DIR, `${keyOf(f)}_${sub.stream}.${isAss ? 'ass' : 'vtt'}`);
  if (!fs.existsSync(out)) {
    if (!subPending.has(out)) {
      subPending.set(out, subExtractLimit(async () => {
        await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', absOf(f), '-map', `0:s:${sub.stream}`, '-f', isAss ? 'ass' : 'webvtt', '-y', out + '.tmp'], 10 * 60000);
        await fsp.rename(out + '.tmp', out);
      }).finally(() => subPending.delete(out)));
    }
    await subPending.get(out);
  }
  return { kind: isAss ? 'ass' : 'vtt', text: decodeText(await fsp.readFile(out)) };
}

async function subToVtt(f, sub) {
  const { kind, text } = await readSub(f, sub);
  return kind === 'ass' ? assToVtt(text) : kind === 'srt' ? srtToVtt(text) : text;
}

async function subStyle(f, sub) {
  const { kind, text } = await readSub(f, sub);
  if (kind !== 'ass') return { ass: false };
  const a = parseAss(text);
  return { ass: true, resX: a.resX, resY: a.resY, classes: a.classes };
}

// ---------- 扫描 ----------
async function walk(absDir, relDir, out) {
  let ents;
  try { ents = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
  const names = ents.filter(e => e.isFile()).map(e => e.name);
  const videoCount = names.filter(n => VIDEO_EXT.has(path.extname(n).toLowerCase())).length;
  for (const e of ents) {
    if (e.name.startsWith('.') || excludeSet.has(e.name.toLowerCase())) continue;
    const abs = path.join(absDir, e.name);
    const rel = relDir ? relDir + '/' + e.name : e.name;
    if (e.isDirectory()) await walk(abs, rel, out);
    else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      try {
        const st = await fsp.stat(abs);
        if (st.size < 100 * 1024) continue; // 忽略过小的文件
        out.push({ p: rel, name: e.name, dir: relDir, size: st.size, mtime: st.mtimeMs, sub: matchSubs(e.name, names, videoCount).length > 0 });
      } catch {}
    }
  }
}

function scan() {
  // 正在扫描时再请求扫描（比如点了刷新）：等这次扫完再完整扫一遍，保证拿到最新结果
  if (scanning) return scanning.then(() => scan());
  scanning = (async () => {
    const t = Date.now();
    const out = [];
    await walk(ROOT, '', out);
    out.sort((a, b) => b.mtime - a.mtime);
    files = out;
    fileMap = new Map(out.map(f => [f.p, f]));
    log(`扫描完成：${out.length} 个视频，用时 ${Date.now() - t}ms`);
    backgroundWork();
  })().finally(() => { scanning = null; });
  return scanning;
}

const absOf = f => path.join(ROOT, ...f.p.split('/'));

// 网页版本：public 下文件的最新修改时间。前端发现变了就自动刷新（单页应用切换页面不会重新加载）
function pageVersion() {
  let v = 0;
  for (const n of fs.readdirSync(PUBLIC)) { try { v = Math.max(v, fs.statSync(path.join(PUBLIC, n)).mtimeMs); } catch {} }
  return String(Math.round(v));
}

// ---------- 隐藏（不在列表里显示，文件保留）----------
const HIDDEN_FILE = path.join(__dirname, 'hidden.json');
let hidden = [];
try { hidden = JSON.parse(fs.readFileSync(HIDDEN_FILE, 'utf8')).items || []; } catch {}
const saveHidden = () => fs.writeFileSync(HIDDEN_FILE, JSON.stringify({ items: hidden }, null, 2));
function isHidden(f) {
  for (const h of hidden) {
    if (h.type === 'file' ? f.p === h.p : (f.dir === h.p || f.dir.startsWith(h.p + '/'))) return true;
  }
  return false;
}
const videosUnder = p => files.filter(f => f.dir === p || f.dir.startsWith(p + '/'));

// ---------- 删除（移到回收站）----------
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;

// 校验并计算要删的东西。只允许：扫描到的、含视频的子文件夹（不能是媒体根目录），或扫描到的视频文件
async function deleteTarget(type, p) {
  if (!p || p.split('/').some(s => !s || s === '.' || s === '..')) throw new Error('路径不合法');
  const abs = path.resolve(ROOT, ...p.split('/'));
  if (!abs.startsWith(ROOT_PREFIX) || abs === path.resolve(ROOT)) throw new Error('路径不在媒体目录内');
  if (path.resolve(__dirname).startsWith(abs + path.sep) || path.resolve(__dirname) === abs) throw new Error('不能删除影音服务自己的目录');
  if (type === 'dir') {
    const vids = files.filter(f => f.dir === p || f.dir.startsWith(p + '/'));
    if (!vids.length) throw new Error('不是影音库里的文件夹');
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) throw new Error('不是文件夹');
    let count = 0, size = 0;
    const ents = await fsp.readdir(abs, { recursive: true, withFileTypes: true });
    for (const e of ents) {
      if (!e.isFile()) continue;
      count++;
      try { size += (await fsp.stat(path.join(e.parentPath || e.path, e.name))).size; } catch {}
    }
    return { paths: [abs], vids, info: { type, p, name: path.basename(abs), files: count, videos: vids.length, size } };
  }
  if (type === 'file') {
    const f = fileMap.get(p);
    if (!f) throw new Error('不是影音库里的视频');
    // 连同同名的字幕等附属文件（“视频名.xxx”，但不含其他视频）
    const dir = path.dirname(abs), base = stripExt(f.name).toLowerCase();
    const paths = [abs];
    let size = f.size;
    for (const n of await dirListing(dir)) {
      if (n === f.name || !n.toLowerCase().startsWith(base + '.') || VIDEO_EXT.has(path.extname(n).toLowerCase())) continue;
      const full = path.join(dir, n);
      try { const st = await fsp.stat(full); if (!st.isFile()) continue; size += st.size; } catch { continue; }
      paths.push(full);
    }
    return { paths, vids: [f], info: { type, p, name: f.name, files: paths.length, videos: 1, size, extra: paths.slice(1).map(x => path.basename(x)) } };
  }
  throw new Error('type 只能是 dir 或 file');
}

async function recycle(target) {
  // 正在转码的会占着文件，先停掉
  const keys = new Set(target.vids.map(keyOf));
  for (const s of [...sessions.values()]) if (keys.has(s.key)) destroySession(s);
  await sleep(300);
  try {
    await new Promise((resolve, reject) => {
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'recycle.ps1')],
        { env: Object.assign({}, process.env, { RECYCLE_PATHS: target.paths.join('\n') }), timeout: 5 * 60000, windowsHide: true },
        (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve());
    });
  } finally {
    const left = target.paths.filter(x => fs.existsSync(x));
    log(`删除（回收站）：${target.info.p}${left.length ? ` —— 未删掉 ${left.length} 项` : ''}`);
    // 清理缓存并更新列表
    for (const f of target.vids) {
      const k = keyOf(f);
      delete probeCache[k];
      fs.rm(path.join(THUMBS, k + '.jpg'), { force: true }, () => {});
    }
    saveProbe();
    await scan();
    if (left.length) throw new Error(`有 ${left.length} 项没删掉（可能被其他程序占用）`);
  }
}
const keyOf = f => sha1(`${f.p}|${f.size}|${f.mtime}`);

// ---------- 探测 ----------
let probeCache = {};
try { probeCache = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8')); } catch {}
let saveTimer = null;
function saveProbe() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(PROBE_FILE, JSON.stringify(probeCache), () => {}), 2000);
}
const probeLimit = limiter(3);
const probePending = new Map();

function probe(f) {
  const k = keyOf(f);
  if (probeCache[k] && probeCache[k].subs) return Promise.resolve(probeCache[k]);
  if (probePending.has(k)) return probePending.get(k);
  const pr = probeLimit(async () => {
    const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absOf(f)]);
    const j = JSON.parse(out);
    const vs = (j.streams || []).find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    const as = (j.streams || []).find(s => s.codec_type === 'audio');
    const info = {
      duration: parseFloat(j.format && j.format.duration) || parseFloat(vs && vs.duration) || 0,
      format: j.format && j.format.format_name,
      v: vs ? { codec: vs.codec_name, width: vs.width, height: vs.height, pix_fmt: vs.pix_fmt, profile: vs.profile } : null,
      a: as ? { codec: as.codec_name, channels: as.channels } : null,
      subs: (j.streams || []).filter(s => s.codec_type === 'subtitle')
        .map((s, n) => ({ n, codec: s.codec_name, lang: s.tags && s.tags.language, title: s.tags && s.tags.title }))
        .filter(s => TEXT_SUB_CODECS.has(s.codec)),
    };
    probeCache[k] = info;
    saveProbe();
    return info;
  }).finally(() => probePending.delete(k));
  probePending.set(k, pr);
  return pr;
}

// ---------- 缩略图 ----------
const thumbLimit = limiter(3);
const thumbPending = new Map();

function thumb(f) {
  const out = path.join(THUMBS, keyOf(f) + '.jpg');
  if (fs.existsSync(out)) return Promise.resolve(out);
  if (thumbPending.has(out)) return thumbPending.get(out);
  const pr = (async () => {
    const info = await probe(f);
    if (!info.v) throw new Error('no video');
    return thumbLimit(async () => {
      const d = info.duration;
      const tries = d > 4 ? [Math.min(Math.max(d * 0.15, 1), d - 1), 0] : [0];
      for (const ss of tries) {
        try {
          await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', ss.toFixed(2), '-i', absOf(f),
            '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', out + '.tmp.jpg'], 60000);
          await fsp.rename(out + '.tmp.jpg', out);
          return out;
        } catch {}
      }
      throw new Error('thumb failed');
    });
  })().finally(() => thumbPending.delete(out));
  thumbPending.set(out, pr);
  return pr;
}

// 扫描后在后台逐个探测 + 生成缩略图
let bgRunning = false;
async function backgroundWork() {
  if (bgRunning) return;
  bgRunning = true;
  try {
    for (const f of files.slice()) {
      try { await probe(f); await thumb(f); } catch {}
    }
  } finally { bgRunning = false; }
}

// ---------- HLS 转码 ----------
let hasNvenc = false;
const sessions = new Map(); // key -> {key, f, dir, info, ff, start, produced, lastReq, lastUse}

function segPath(s, i) { return path.join(s.dir, `seg_${i}.ts`); }

function stopFF(s) {
  if (s.ff && s.ff.exitCode === null) s.ff.kill('SIGKILL');
  s.ff = null;
}

function startFF(s, i) {
  stopFF(s);
  const v = s.info.v;
  const ss = i * SEG;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', absOf(s.f), '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn');
  if (v) {
    const vf = [];
    if (Math.max(v.width, v.height) > 1920) vf.push(v.width >= v.height ? 'scale=1920:-2' : 'scale=-2:1920');
    vf.push('format=yuv420p');
    args.push('-vf', vf.join(','));
    if (hasNvenc) args.push('-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '24', '-b:v', '0', '-maxrate', '10M', '-bufsize', '20M', '-forced-idr', '1');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    args.push('-force_key_frames', `expr:gte(t,n_forced*${SEG})`);
  }
  if (s.info.a) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push('-output_ts_offset', String(ss), '-muxdelay', '0', '-f', 'hls', '-hls_time', String(SEG), '-hls_list_size', '0',
    '-hls_flags', 'temp_file', '-start_number', String(i), '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(s.dir, 'seg_%d.ts'), path.join(s.dir, 'ff.m3u8'));
  const ff = spawn('ffmpeg', args, { windowsHide: true });
  ff.stderr.on('data', d => log('[ffmpeg]', String(d).trim()));
  ff.on('error', e => log('ffmpeg 启动失败', e.message));
  s.ff = ff;
  s.start = i;
  s.produced = i - 1;
  log(`转码：${s.f.p} 从 ${ss}s 开始（${hasNvenc ? 'NVENC' : 'x264'}）`);
}

function updateProduced(s) {
  while (fs.existsSync(segPath(s, s.produced + 1))) s.produced++;
}

async function getSession(f) {
  const key = keyOf(f);
  let s = sessions.get(key);
  if (!s) {
    // 同时最多保留 3 个转码会话
    if (sessions.size >= 3) {
      const oldest = [...sessions.values()].sort((a, b) => a.lastUse - b.lastUse)[0];
      destroySession(oldest);
    }
    const info = await probe(f);
    const dir = path.join(HLS_DIR, key);
    fs.mkdirSync(dir, { recursive: true });
    s = { key, f, dir, info, ff: null, start: 0, produced: -1, lastReq: 0, lastUse: Date.now() };
    sessions.set(key, s);
  }
  s.lastUse = Date.now();
  return s;
}

function destroySession(s) {
  stopFF(s);
  sessions.delete(s.key);
  fs.rm(s.dir, { recursive: true, force: true }, () => {});
}

function playlist(s) {
  const d = s.info.duration;
  const n = Math.max(1, Math.ceil(d / SEG));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  for (let i = 0; i < n; i++) {
    const len = i === n - 1 ? Math.max(0.1, d - i * SEG) : SEG;
    lines.push(`#EXTINF:${len.toFixed(3)},`, `seg_${i}.ts?p=${encodeURIComponent(s.f.p)}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

async function getSegment(s, i) {
  s.lastUse = Date.now();
  s.lastReq = i;
  const file = segPath(s, i);
  if (fs.existsSync(file)) return file;
  const running = s.ff && s.ff.exitCode === null;
  if (running) updateProduced(s);
  // 当前转码进程很快就会产出这个分片，就等它；否则从该分片重新开始转码
  if (!(running && i >= s.start && i <= s.produced + 3)) startFF(s, i);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return file;
    if (!s.ff || s.ff.exitCode !== null) {
      await sleep(200);
      if (fs.existsSync(file)) return file;
      throw new Error('转码进程已退出');
    }
    await sleep(100);
  }
  throw new Error('等待分片超时');
}

// 定时：转码领先太多就暂停；空闲会话清理
setInterval(() => {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.lastUse > 3 * 60000) { destroySession(s); continue; }
    if (s.ff && s.ff.exitCode === null) {
      updateProduced(s);
      if (s.produced - s.lastReq > 40) { stopFF(s); }
    }
  }
}, 3000);

function cleanupAndExit() {
  for (const s of sessions.values()) stopFF(s);
  process.exit(0);
}
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
process.on('SIGHUP', cleanupAndExit);

// ---------- HTTP ----------
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/webm',
  '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv', '.flv': 'video/x-flv', '.ts': 'video/mp2t', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.3gp': 'video/3gpp',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const authToken = cfg.password ? sha1('media-server:' + cfg.password) : null;
function authed(req) {
  if (!authToken) return true;
  const m = /(?:^|;\s*)ms_auth=([0-9a-f]+)/.exec(req.headers.cookie || '');
  return !!m && m[1] === authToken;
}

function send(res, code, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) }, extra));
  res.end(body);
}
const json = (res, obj) => send(res, 200, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });

function serveFile(req, res, abs, type, cache = 'no-cache') {
  fs.stat(abs, (err, st) => {
    if (err) return send(res, 404, 'not found');
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    let start = 0, end = st.size - 1, code = 200;
    if (range) {
      if (range[1] === '') { start = Math.max(0, st.size - parseInt(range[2], 10)); }
      else { start = parseInt(range[1], 10); if (range[2] !== '') end = Math.min(end, parseInt(range[2], 10)); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(abs, { start, end });
    stream.pipe(res);
    res.on('close', () => stream.destroy());
  });
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录</title><body style="background:#111;color:#eee;font-family:sans-serif;display:flex;height:100vh;align-items:center;justify-content:center;margin:0">
<form method="post" action="/login" style="display:flex;gap:8px"><input name="password" type="password" placeholder="密码" autofocus
style="padding:10px;font-size:16px;border-radius:8px;border:1px solid #444;background:#222;color:#eee">
<button style="padding:10px 16px;font-size:16px;border-radius:8px;border:0;background:#e50914;color:#fff">进入</button></form></body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pn = url.pathname;
  try {
    if (pn === '/login') {
      if (req.method === 'POST') {
        let body = '';
        for await (const c of req) body += c;
        const pw = new URLSearchParams(body).get('password') || '';
        if (authToken && sha1('media-server:' + pw) === authToken) {
          res.writeHead(302, { 'Set-Cookie': `ms_auth=${authToken}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`, Location: '/' });
          return res.end();
        }
      }
      return send(res, 200, LOGIN_PAGE, 'text/html; charset=utf-8');
    }
    if (!authed(req)) {
      if (pn === '/' || pn.endsWith('.html')) { res.writeHead(302, { Location: '/login' }); return res.end(); }
      return send(res, 401, 'unauthorized');
    }

    const getFile = () => {
      const f = fileMap.get(url.searchParams.get('p') || '');
      if (!f) send(res, 404, 'not found');
      return f;
    };

    if (pn === '/api/files') {
      if (!files.length && scanning) await scanning;
      return json(res, files.filter(f => !isHidden(f)).map(f => {
        const info = probeCache[keyOf(f)];
        return Object.assign({}, f, info ? { dur: info.duration, w: info.v && info.v.width, h: info.v && info.v.height, noVideo: !info.v } : {});
      }));
    }
    if (pn === '/api/rescan') { await scan(); return json(res, { count: files.length }); }
    if (pn === '/api/config') return json(res, { allowDelete: !!cfg.allowDelete, hidden: hidden.length, ver: pageVersion() });
    if (pn === '/api/hidden') {
      return json(res, hidden.map(h => {
        const vids = h.type === 'file' ? (fileMap.has(h.p) ? [fileMap.get(h.p)] : []) : videosUnder(h.p);
        return Object.assign({}, h, { videos: vids.length, size: vids.reduce((s, f) => s + f.size, 0), cover: vids[0] && { p: vids[0].p, mtime: vids[0].mtime } });
      }));
    }
    if (pn === '/api/hide' || pn === '/api/unhide') {
      if (req.method !== 'POST') return send(res, 405, 'POST only');
      let body = '';
      for await (const c of req) body += c;
      const { type, p } = JSON.parse(body || '{}');
      if (pn === '/api/unhide') {
        hidden = hidden.filter(h => h.p !== p);
      } else {
        if (type === 'file' ? !fileMap.has(p) : !(type === 'dir' && p && videosUnder(p).length)) return send(res, 400, '不是影音库里的视频或文件夹');
        if (!hidden.some(h => h.p === p && h.type === type)) hidden.push({ type, p, at: Date.now() });
      }
      saveHidden();
      return json(res, { ok: true, hidden: hidden.length });
    }
    if (pn === '/api/delinfo' || pn === '/api/delete') {
      if (!cfg.allowDelete) return send(res, 403, '已在 config.json 里关闭删除功能');
      let q = { type: url.searchParams.get('type'), p: url.searchParams.get('p') };
      if (pn === '/api/delete') {
        if (req.method !== 'POST') return send(res, 405, 'POST only');
        let body = '';
        for await (const c of req) body += c;
        q = JSON.parse(body || '{}');
      }
      let target;
      try { target = await deleteTarget(q.type, String(q.p || '')); }
      catch (e) { return send(res, 400, e.message); }
      if (pn === '/api/delinfo') return json(res, target.info);
      await recycle(target);
      return json(res, { ok: true, count: files.length });
    }
    if (pn === '/api/info') {
      const f = getFile(); if (!f) return;
      const info = await probe(f);
      const subs = (await subsFor(f, info)).map((s, i) => ({ i, label: s.label }));
      return json(res, Object.assign({}, f, info, { subs }));
    }
    if (pn === '/sub') {
      const f = getFile(); if (!f) return;
      const sub = (await subsFor(f, await probe(f)))[+url.searchParams.get('i')];
      if (!sub) return send(res, 404, 'no subtitle');
      if (url.searchParams.get('fmt') === 'style') return json(res, await subStyle(f, sub));
      return send(res, 200, await subToVtt(f, sub), 'text/vtt; charset=utf-8', { 'Cache-Control': 'no-cache' });
    }
    if (pn === '/thumb') {
      const f = getFile(); if (!f) return;
      try { return serveFile(req, res, await thumb(f), 'image/jpeg', 'public, max-age=604800'); }
      catch { return send(res, 404, 'no thumb'); }
    }
    if (pn === '/video') {
      const f = getFile(); if (!f) return;
      return serveFile(req, res, absOf(f), MIME[path.extname(f.name).toLowerCase()] || 'application/octet-stream');
    }
    if (pn === '/hls/index.m3u8') {
      const f = getFile(); if (!f) return;
      const s = await getSession(f);
      return send(res, 200, playlist(s), 'application/vnd.apple.mpegurl', { 'Cache-Control': 'no-store' });
    }
    let m;
    if ((m = /^\/hls\/seg_(\d+)\.ts$/.exec(pn))) {
      const f = getFile(); if (!f) return;
      const s = await getSession(f);
      const file = await getSegment(s, parseInt(m[1], 10));
      return serveFile(req, res, file, 'video/mp2t', 'no-store');
    }

    // 静态文件
    const rel = pn === '/' ? 'index.html' : decodeURIComponent(pn).replace(/^\/+/, '');
    const abs = path.resolve(PUBLIC, rel);
    if (!abs.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden');
    return serveFile(req, res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
  } catch (e) {
    log('请求出错', pn, e.message);
    if (!res.headersSent) send(res, 500, String(e.message));
    else res.destroy();
  }
});

(async () => {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '0.5', '-c:v', 'h264_nvenc', '-f', 'null', '-'], 20000);
    hasNvenc = true;
  } catch {}
  server.listen(cfg.port, '0.0.0.0', () => {
    log(`影音服务已启动，媒体目录：${ROOT}，转码编码器：${hasNvenc ? 'NVENC(显卡)' : 'libx264(CPU)'}`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) log(`  http://${a.address}:${cfg.port}`);
    if (cfg.password) log('  已启用密码访问');
  });
  scan();
  setInterval(scan, cfg.rescanMinutes * 60000);
})();
