#!/usr/bin/env node
// @ts-check
/**
 * normalize.mjs — 中文文本「字形级」规范化工具（Node.js ESM，零依赖）
 *
 * 设计红线（任何改动都不得违反）：
 *   1. 只做字形级替换：不增删词句、不改语序、不改语法、不做润色。
 *   2. 全角阿拉伯数字（U+FF10–U+FF19）→ 半角阿拉伯数字（0–9）。
 *   3. 半角标点符号 → 全角标点符号（上下文感知，避免破坏小数点/时间/代码/URL/缩写）。
 *   4. 非简体中文字符 → 简体中文字符（日语、韩语、朝鲜语人名除外）。
 *
 * 运行环境：Node.js >= 18（用到 String.prototype.matchAll、正则后行断言、
 * RegExp `/d` indices、Int32Array）。自身零依赖；`opencc-js` 为可选增强。
 *
 * 实现说明：全程按 UTF-16 码元（code unit）索引，与 Python 版的码点索引在
 * BMP 内等价。本工具关心的字符（汉字、假名、谚文、全角符号）均在 BMP，
 * 因此行为一致。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = dirname(SCRIPT_DIR);
const DATA_DIR = join(SKILL_DIR, 'data');

const VERSION = '2.0.0';

// ---------------------------------------------------------------- 字符分类

// 汉字 / 假名 / 谚文 / 中日韩标点 / 全角字符，统一视为「CJK 上下文」
const CJK_RANGES = [
  [0x3001, 0x303f], // CJK 标点（不含 U+3000 全角空格）
  [0x3040, 0x30ff], // 假名
  [0x31f0, 0x31ff], // 片假名扩展
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本汉字
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // 兼容汉字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff01, 0xffef], // 全角/半角形式
];

const KANA_RANGES = [
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0xff66, 0xff9f],
  [0x30fb, 0x30fc],
];
const HANGUL_RANGES = [
  [0xac00, 0xd7af],
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
];
const HAN_RANGES = [
  [0x2e80, 0x2eff],
  [0x2f00, 0x2fdf],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
];

// 高频中文虚词/常用字：日文独有字形向外扩展人名窗口时遇此集合即停止，
// 避免把整句中文误判为人名。
const STOP_HAN = new Set(
  // 繁体原文（用于匹配未经转换的文本）
  '的了是在有和與会會這这那我們个上下前後时年月日出說话作為对從到過还就要能把被给所很再又也都才更最不沒于其之以而及或則但因使可請许多大小中新舊對於关于并且或者已经將讓向此外之間由該等發現進行問題部分場电影首映' +
    // 简体对照（繁简混排文本里同样可能出现）
    '的们个这后会说为对从过还没于则请许多旧对关并已将让间该等发现进行题部场',
);

// 日文独有字形：新字体 / 国字 / 叠字符号。出现即判定为非简体中文语境。
const JAPANESE_ONLY = new Set(
  '辻込畑峠塚辿凪薮篭桜沢辺広転実気発営関円恵圧価仏駅県総変単戦図続読働専楽対々〆ヶヵ',
);
// 韩文独有汉字（国字）
const KOREAN_ONLY = new Set('畓乭巭');

const PUNCT_MAP = {
  ',': '，',
  ';': '；',
  ':': '：',
  '!': '！',
  '?': '？',
  '(': '（',
  ')': '）',
  '[': '［',
  ']': '］',
  '{': '｛',
  '}': '｝',
  '<': '＜',
  '>': '＞',
  '~': '～',
  '|': '｜',
  '"': '＂',
  "'": '＇',
};

const SYMBOL_MAP = {
  '@': '＠',
  '#': '＃',
  '$': '＄',
  '%': '％',
  '&': '＆',
  '*': '＊',
  '+': '＋',
  '=': '＝',
  '/': '／',
  '\\': '＼',
  '^': '＾',
  '_': '＿',
  '`': '｀',
};

const CURLY_OPEN = { '"': '“', "'": '‘' };
const CURLY_CLOSE = { '"': '”', "'": '’' };

// 常见拉丁缩写：句点属于缩写本身，不转换
const ABBREVS = new Set([
  'etc', 'eg', 'ie', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr',
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'approx', 'cf', 'etal',
  'fig', 'figs', 'vol', 'vols', 'pp', 'no', 'nos', 'op', 'ed', 'eds',
  'am', 'pm', 'us', 'uk', 'usa', 'eu', 'un', 'gdp', 'ceo', 'cto',
  'etc.', 'e.g.', 'i.e.', 'vs.', 'mr.', 'mrs.', 'dr.', 'prof.', 'inc.',
  'ltd.', 'co.', 'corp.', 'fig.', 'no.', 'vol.', 'pp.', 'u.s.', 'u.k.',
  'a.m.', 'p.m.', 'et al.',
]);

function inRanges(code, ranges) {
  for (const [a, b] of ranges) if (code >= a && code <= b) return true;
  return false;
}

function isCjk(ch) {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return inRanges(code, CJK_RANGES);
}

function isKana(ch) {
  if (!ch) return false;
  return inRanges(ch.charCodeAt(0), KANA_RANGES) || '々〆ヶヵ'.includes(ch);
}

function isHangul(ch) {
  if (!ch) return false;
  return inRanges(ch.charCodeAt(0), HANGUL_RANGES);
}

function isHan(ch) {
  if (!ch) return false;
  return inRanges(ch.charCodeAt(0), HAN_RANGES);
}

function isCjkTokenChar(ch) {
  return !' \t\r\n　'.includes(ch) && isCjk(ch);
}

/** 全角或半角的阿拉伯数字（Python 版 str.isdigit 的等价语义） */
function isDigit(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0x30 && c <= 0x39) || (c >= 0xff10 && c <= 0xff19);
}

const RE_ASCII_ALNUM = /^[0-9A-Za-z]$/;
function isAsciiAlnum(ch) {
  return !!ch && RE_ASCII_ALNUM.test(ch);
}

// ---------------------------------------------------------------- 繁转简后端

/**
 * 零依赖兜底转换器：OpenCC 单字表 + 词组表，最长匹配优先。
 * 等价于 OpenCC 的 t2s 配置（TSCharacters + TSPhrases）。
 */
export class FallbackT2S {
  constructor(dataDir = DATA_DIR) {
    /** @type {Map<string,string>} */
    this.chars = new Map();
    /** @type {Map<string,string>} */
    this.phrases = new Map();
    for (const [file, target] of [
      ['TSCharacters.txt', this.chars],
      ['TSPhrases.txt', this.phrases],
    ]) {
      const p = join(dataDir, file);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const parts = s.split('\t');
        if (parts.length < 2) continue;
        const dst = parts[1].trim().split(/\s+/);
        if (dst.length) target.set(parts[0], dst[0]);
      }
    }
    let max = 1;
    for (const k of this.phrases.keys()) if (k.length > max) max = k.length;
    this.maxlen = max;
  }

  convert(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      let hit = false;
      if (this.phrases.size) {
        for (let len = Math.min(this.maxlen, n - i); len > 1; len--) {
          const cand = text.substr(i, len);
          const rep = this.phrases.get(cand);
          if (rep !== undefined) {
            out.push(rep);
            i += len;
            hit = true;
            break;
          }
        }
      }
      if (hit) continue;
      const ch = text[i];
      out.push(this.chars.get(ch) ?? ch);
      i += 1;
    }
    return out.join('');
  }
}

/**
 * 取得繁转简函数。
 * @param {'auto'|'builtin'|'opencc'} backend
 * @returns {Promise<{convert:(s:string)=>string, name:string}>}
 */
export async function getConverter(backend = 'auto') {
  if (backend === 'auto' || backend === 'opencc') {
    try {
      const mod = await import('opencc-js');
      const factory = mod.Converter ?? mod.default?.Converter;
      if (typeof factory === 'function') {
        const cc = factory({ from: 't', to: 'cn' });
        if (typeof cc('測試') === 'string') {
          return { convert: (s) => cc(s), name: 'opencc-js' };
        }
      }
      throw new Error('opencc-js 未导出 Converter');
    } catch (err) {
      if (backend === 'opencc') {
        process.stderr.write(
          `[warn] opencc-js 不可用（${err?.code ?? err?.message ?? err}），已回退内置字表\n`,
        );
      }
    }
  }
  const table = new FallbackT2S(DATA_DIR);
  return { convert: (s) => table.convert(s), name: 'builtin-table' };
}

// ---------------------------------------------------------------- 保护区域

/** 合并重叠/相邻区间 */
function mergeSpans(spans) {
  if (!spans.length) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [[sorted[0][0], sorted[0][1]]];
  for (let k = 1; k < sorted.length; k++) {
    const [s, e] = sorted[k];
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.filter(([s, e]) => e > s);
}

const RE_MD_TABLE_SEP = /^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/;

/**
 * 代码块、Markdown 语法结构、URL/邮箱/路径等「永不改动」的区域。
 * @param {string} text
 * @param {string} fmt 'md' | 'text' | 'auto'
 * @param {boolean} protectFrontmatter
 */
export function structuralSpans(text, fmt, protectFrontmatter = true) {
  const spans = [];
  const md = fmt === 'md' || fmt === 'auto';

  // YAML frontmatter（默认保护：元数据中的半角写法通常是刻意保留的）
  if (md && protectFrontmatter && /^---\r?\n/.test(text)) {
    const rest = text.slice(3);
    const m = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
    if (m) spans.push([0, 3 + m.index + m[0].length]);
  }

  // 逐行：围栏代码块 / 表格 / 标题 / 列表 / 引用标记
  const lines = text.split('\n');
  let pos = 0;
  let inFence = false;
  let fenceTok = null;
  for (const line of lines) {
    const start = pos;
    const end = pos + line.length;
    const stripped = line.trim();
    const fm = /^[ \t]*(```|~~~)/.exec(line);
    if (inFence) {
      spans.push([start, end]);
      if (fm && fm[1] === fenceTok) {
        inFence = false;
        fenceTok = null;
      }
    } else if (fm) {
      inFence = true;
      fenceTok = fm[1];
      spans.push([start, end]);
    } else if (md) {
      if (stripped.startsWith('|')) {
        spans.push([start, end]);
      } else if (stripped.includes('-') && RE_MD_TABLE_SEP.test(stripped)) {
        spans.push([start, end]);
      } else if (/^={3,}[ \t]*$/.test(stripped) || /^(\*{3,}|_{3,})[ \t]*$/.test(stripped)) {
        spans.push([start, end]);
      } else {
        for (const pat of [
          /^[ \t]*(#{1,6})(?=[ \t]|$)/,
          /^[ \t]*([-*+]|\d+[.)])(?=[ \t]|$)/,
          /^[ \t]*(>)(?=[ \t]|$)/,
        ]) {
          const m2 = pat.exec(line);
          if (m2) {
            const offset = m2.index + (m2[0].length - m2[1].length);
            spans.push([start + offset, start + offset + m2[1].length]);
            break;
          }
        }
      }
    }
    pos = end + 1;
  }

  // 行内结构
  const inline = [
    '`[^`\\n]*`', // 行内代码
    '<!--[\\s\\S]*?-->', // HTML 注释
    '</?[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*?)?/?>', // HTML 标签
    '(?:https?|ftp)://[^\\s<>"\'）】]+', // URL
    '(?<![\\w.])www\\.[^\\s<>"\'）】]+',
    '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', // 邮箱
    '[A-Za-z]:\\\\[^\\s<>"\'）】]*', // Windows 路径
    '(?<![\\w])/(?:usr|home|etc|var|tmp|opt|mnt|Users|Applications|Library)/[^\\s<>"\'）】]*',
    '\\$\\$[\\s\\S]+?\\$\\$', // 块级公式
    '(?<!\\$)\\$(?![\\s$])([^$\\n]+?)(?<![\\s])\\$(?!\\$)', // 行内公式
  ];
  if (md) {
    inline.push('\\[\\^[^\\]\\n]*\\]', '\\{[^{}\\n]*\\}');
  }
  for (const src of inline) {
    for (const m of text.matchAll(new RegExp(src, 'g'))) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }

  // 链接/图片：仅保护定界符与 URL，链接文字仍参与转换
  if (md) {
    const re = /(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/gd;
    for (const m of text.matchAll(re)) {
      const open = m.indices[2][0]; // [
      const close = m.indices[2][1]; // ] 之后
      const urlEnd = m.indices[3][1];
      spans.push([open - 1, open]); // [
      spans.push([close, close + 1]); // ]
      spans.push([close + 1, urlEnd + 1]); // (url)
    }
  }

  return mergeSpans(spans);
}

/**
 * 载入日韩人名保护名单。
 * @param {string|null} path
 */
export function loadNames(path = null) {
  const names = new Set();
  const p = path ?? join(DATA_DIR, 'names_ja_ko.txt');
  if (!existsSync(p)) return names;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (s && !s.startsWith('#')) names.add(s);
  }
  return names;
}

/** 名单子串匹配：名单项可直接命中长句中的人名。 */
function substringSpans(text, names) {
  const spans = [];
  for (const name of names) {
    if (name.length < 2) continue;
    let from = 0;
    for (;;) {
      const idx = text.indexOf(name, from);
      if (idx < 0) break;
      spans.push([idx, idx + name.length]);
      from = idx + 1;
    }
  }
  return mergeSpans(spans);
}

/** 在单个连续 CJK 片段内部定位「日语/韩语/朝鲜语」人名。 */
function nameSpansInRun(run, base) {
  const spans = [];
  const len = run.length;

  // B. 汉字子片段紧邻假名或谚文（如「宮崎駿の」「박근혜 前」）
  let k = 0;
  while (k < len) {
    if (isHan(run[k])) {
      const s = k;
      while (k < len && isHan(run[k])) k += 1;
      const e = k;
      const before = s > 0 ? run[s - 1] : '';
      const after = e < len ? run[e] : '';
      if (isKana(before) || isHangul(before) || isKana(after) || isHangul(after)) {
        spans.push([base + s, base + e]);
      }
    } else {
      k += 1;
    }
  }

  // C. 日文/韩文独有字形：以该字为中心向两侧最多各扩 2 字，遇高频虚词停止
  for (let idx = 0; idx < len; idx++) {
    const ch = run[idx];
    if (!JAPANESE_ONLY.has(ch) && !KOREAN_ONLY.has(ch)) continue;
    let s = idx;
    let cnt = 0;
    while (s - 1 >= 0 && isHan(run[s - 1]) && !STOP_HAN.has(run[s - 1]) && cnt < 2) {
      s -= 1;
      cnt += 1;
    }
    let e = idx + 1;
    cnt = 0;
    while (e < len && isHan(run[e]) && !STOP_HAN.has(run[e]) && cnt < 2) {
      e += 1;
      cnt += 1;
    }
    spans.push([base + s, base + e]);
  }

  return spans;
}

/**
 * 识别日语 / 韩语 / 朝鲜语人名等「不应繁转简」的片段。
 * @param {string} text
 * @param {Uint8Array} protectedMask
 * @param {Set<string>} names 内置名单
 * @param {Set<string>} extra 用户追加名单
 */
function nameSpans(text, protectedMask, names, extra) {
  const spans = substringSpans(text, new Set([...names, ...extra]));

  const n = text.length;
  let i = 0;
  while (i < n) {
    if (protectedMask[i] || !isCjkTokenChar(text[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !protectedMask[j] && isCjkTokenChar(text[j])) j += 1;
    if (j > i) spans.push(...nameSpansInRun(text.slice(i, j), i));
    i = j > i ? j : i + 1;
  }
  return mergeSpans(spans);
}

// ---------------------------------------------------------------- 标点 / 数字

function prevChar(text, i) {
  let j = i - 1;
  while (j >= 0 && ' \t　'.includes(text[j])) j -= 1;
  return j < 0 || '\r\n'.includes(text[j]) ? -1 : j;
}

function nextChar(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n && ' \t　'.includes(text[j])) j += 1;
  return j >= n || '\r\n'.includes(text[j]) ? -1 : j;
}

/** 从句点位置向前（不跨行）查找 CJK 字符。src 为「已处理视图」。 */
function cjkBefore(src, i, dist = 16) {
  let j = i - 1;
  const limit = Math.max(-1, i - dist);
  while (j > limit) {
    if ('\r\n'.includes(src[j])) return false;
    if (isCjk(src[j])) return true;
    j -= 1;
  }
  return false;
}

/** 向前取「ASCII 字母数字或句点」构成的词，用于缩写判定。 */
function trailingWord(text, i) {
  let k = i - 1;
  while (k >= 0) {
    const ch = text[k];
    if (isAsciiAlnum(ch) || ch === '.') k -= 1;
    else break;
  }
  return text.slice(k + 1, i);
}

/**
 * 判定标点是否转换。
 * @returns {string|null} 替换字符；null 表示保持原样。
 *
 * out 是「已处理视图」：左侧已转换的字符（如 ) → ））应被视作 CJK 上下文，
 * 否则「（中文）." 这类句子末尾的句点会被漏判。
 */
function decidePunct(text, i, ch, opts, out) {
  const n = text.length;
  const p = prevChar(text, i);
  const q = nextChar(text, i);
  const pch = p >= 0 ? out[p] : '';
  const qch = q >= 0 ? text[q] : '';
  const pcjk = isCjk(pch);
  const qcjk = isCjk(qch);

  if (ch === '.') {
    if (opts.period === 'keep') return null;
    if (isDigit(pch) && isDigit(qch)) return null; // 3.14
    if (isAsciiAlnum(pch) && isAsciiAlnum(qch)) return null; // node.js / v1.2 / index.html
    if (qch === '' || qch === ' ' || qch === '\t') {
      const raw = trailingWord(text, i);
      const w = raw.toLowerCase();
      // etc. / U.S. 等缩写；以及单个大写字母（J. / A. 之类的人名缩写）
      if (ABBREVS.has(w) || (raw.length === 1 && raw === raw.toUpperCase() && /[A-Z]/.test(raw))) {
        return null;
      }
    }
    if (pcjk) return opts.period === 'ideographic' ? '。' : '．';
    if (isAsciiAlnum(pch) && (qch === '' || qch === ' ' || qch === '\t')) {
      if (cjkBefore(out, i)) return opts.period === 'ideographic' ? '。' : '．';
    }
    return null;
  }

  if (ch === ',') {
    if (isDigit(pch) && isDigit(qch)) return null; // 1,000 千分位
    return pcjk || qcjk ? '，' : null;
  }

  if (ch === ':') {
    if (isDigit(pch) && isDigit(qch)) return null; // 10:30 时间 / 比分
    return pcjk || qcjk ? '：' : null;
  }

  if (ch === ';') return pcjk || qcjk ? '；' : null;

  if (ch === '!' || ch === '?') {
    if ('=<>&|'.includes(qch)) return null; // != / ?: 运算符
    if (pcjk || qcjk) return PUNCT_MAP[ch];
    if (qch === '' && pch && (isAsciiAlnum(pch) || pcjk) && cjkBefore(out, i)) {
      return PUNCT_MAP[ch];
    }
    return null;
  }

  if ('()[]{}'.includes(ch)) return pcjk || qcjk ? PUNCT_MAP[ch] : null;

  if (ch === '<' || ch === '>') {
    if (pch === '-' || qch === '-' || '=<>|&'.includes(pch) || '=<>|&'.includes(qch)) {
      return null; // -> / => / <=
    }
    return pcjk || qcjk ? PUNCT_MAP[ch] : null;
  }

  if (ch === '~') {
    if (isDigit(pch) && isDigit(qch)) return '～'; // 1~5
    return pcjk || qcjk ? '～' : null;
  }

  if (ch === '|') {
    if (pch === '-' || qch === '-') return null;
    return pcjk || qcjk ? '｜' : null;
  }

  if (ch === '"' || ch === "'") {
    if (opts.quotes === 'keep') return null;
    if (!(pcjk || qcjk)) return null; // don't / "Hello"
    if (opts.quotes === 'curly') return null; // 由外层统一配对处理
    return PUNCT_MAP[ch];
  }

  if (Object.prototype.hasOwnProperty.call(SYMBOL_MAP, ch)) {
    if (isDigit(pch) || isDigit(qch) || pcjk || qcjk) return SYMBOL_MAP[ch];
    return null;
  }

  return null;
}

function transformPunctDigits(text, protectedMask, opts, stats) {
  const out = text.split('');
  const quoteOpen = { '"': true, "'": true };
  for (let i = 0; i < text.length; i++) {
    if (protectedMask[i]) continue;
    if (i === 0 || '\r\n'.includes(text[i - 1])) {
      quoteOpen['"'] = true;
      quoteOpen["'"] = true;
    }

    const ch = text[i];
    const code = ch.charCodeAt(0);

    if (code >= 0xff10 && code <= 0xff19) {
      out[i] = String.fromCharCode(0x30 + (code - 0xff10));
      stats.digits += 1;
      continue;
    }

    if (
      ch === '.' ||
      Object.prototype.hasOwnProperty.call(PUNCT_MAP, ch) ||
      (opts.symbols && Object.prototype.hasOwnProperty.call(SYMBOL_MAP, ch))
    ) {
      if (opts.quotes === 'curly' && (ch === '"' || ch === "'")) {
        const pi = prevChar(text, i);
        const qi = nextChar(text, i);
        const pcjk = pi >= 0 ? isCjk(out[pi]) : false;
        const qcjk = qi >= 0 ? isCjk(text[qi]) : false;
        if (pcjk || qcjk) {
          out[i] = quoteOpen[ch] ? CURLY_OPEN[ch] : CURLY_CLOSE[ch];
          quoteOpen[ch] = !quoteOpen[ch];
          stats.punct += 1;
        }
        continue;
      }
      const repl = decidePunct(text, i, ch, opts, out);
      if (repl !== null) {
        out[i] = repl;
        stats.punct += 1;
      }
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------- 通用 diff

/**
 * LCS 差异：把两个序列切成 equal / change 交错块。
 * 先裁掉公共前后缀再跑 DP，实际开销通常极小。
 * @param {string[]|string} a
 * @param {string[]|string} b
 */
export function diffBlocks(a, b) {
  const A = a;
  const B = b;
  const n = A.length;
  const m = B.length;

  // 等长路径：本工具的所有变换都不增删字符/行，长度相等时逐位比对即为精确解，
  // 且是 O(n)，避免大文档上 LCS 的 O(n·m) 开销。
  if (n === m) {
    const blocks = [];
    let i = 0;
    while (i < n) {
      const same = A[i] === B[i];
      let j = i;
      while (j < n && (A[j] === B[j]) === same) j += 1;
      blocks.push({ type: same ? 'equal' : 'change', a1: i, a2: j, b1: i, b2: j });
      i = j;
    }
    return blocks;
  }

  const blocks = [];

  let pre = 0;
  while (pre < n && pre < m && A[pre] === B[pre]) pre += 1;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf += 1;

  if (pre) blocks.push({ type: 'equal', a1: 0, a2: pre, b1: 0, b2: pre });

  const aMid = A.slice(pre, n - suf);
  const bMid = B.slice(pre, m - suf);
  const inner = lcsBlocks(aMid, bMid);
  for (const blk of inner) {
    blocks.push({
      type: blk.type,
      a1: blk.a1 + pre,
      a2: blk.a2 + pre,
      b1: blk.b1 + pre,
      b2: blk.b2 + pre,
    });
  }

  if (suf) blocks.push({ type: 'equal', a1: n - suf, a2: n, b1: m - suf, b2: m });
  return blocks;
}

function lcsBlocks(A, B) {
  const n = A.length;
  const m = B.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: 'change', a1: 0, a2: 0, b1: 0, b2: m }];
  if (m === 0) return [{ type: 'change', a1: 0, a2: n, b1: 0, b2: 0 }];
  if (n * m > 4_000_000) return [{ type: 'change', a1: 0, a2: n, b1: 0, b2: m }];

  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        A[i] === B[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      const s1 = i;
      const s2 = j;
      while (i < n && j < m && A[i] === B[j]) {
        i += 1;
        j += 1;
      }
      out.push({ type: 'equal', a1: s1, a2: i, b1: s2, b2: j });
    } else {
      const s1 = i;
      const s2 = j;
      while (i < n && j < m && A[i] !== B[j]) {
        if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1;
        else j += 1;
      }
      if (j >= m) i = n;
      if (i >= n) j = m;
      out.push({ type: 'change', a1: s1, a2: i, b1: s2, b2: j });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 繁转简

function maskToSpans(mask) {
  const spans = [];
  let start = null;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && start === null) start = i;
    else if (!mask[i] && start !== null) {
      spans.push([start, i]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, mask.length]);
  return spans;
}

function recordHanziStats(before, after, stats) {
  if (before === after) return;
  for (const blk of diffBlocks(before, after)) {
    if (blk.type === 'equal') continue;
    stats.hanzi += Math.max(blk.a2 - blk.a1, blk.b2 - blk.b1);
    if (blk.a2 > blk.a1 && blk.b2 > blk.b1 && stats.examples.length < 8) {
      stats.examples.push({
        from: before.slice(blk.a1, blk.a2),
        to: after.slice(blk.b1, blk.b2),
      });
    }
  }
}

function convertHanzi(text, protectedMask, convert, stats) {
  const spans = maskToSpans(protectedMask);
  if (!spans.length) {
    const converted = convert(text);
    recordHanziStats(text, converted, stats);
    return converted;
  }

  const parts = [];
  let last = 0;
  for (const [s, e] of spans) {
    parts.push(text.slice(last, s));
    last = e;
  }
  parts.push(text.slice(last));

  const holders = spans.map((_, k) => `\uE000${k}\uE001`);
  let buf = parts[0];
  for (let k = 0; k < spans.length; k++) buf += holders[k] + parts[k + 1];

  const converted = convert(buf);
  recordHanziStats(buf, converted, stats); // 必须在还原占位符之前统计
  let result = converted;
  for (let k = 0; k < spans.length; k++) {
    const [s, e] = spans[k];
    result = result.split(holders[k]).join(text.slice(s, e));
  }
  return result;
}

// ---------------------------------------------------------------- 主流程

/**
 * 对单段文本执行规范化。
 * @param {string} text
 * @param {object} opts
 * @param {(s:string)=>string} convert
 */
export function normalizeText(text, opts, convert) {
  const stats = { digits: 0, punct: 0, hanzi: 0, examples: [] };

  const spans = structuralSpans(text, opts.format, opts.protectFrontmatter);
  const protectedMask = new Uint8Array(text.length);
  for (const [s, e] of spans) {
    for (let i = s; i < Math.min(e, text.length); i++) protectedMask[i] = 1;
  }

  const extra = new Set();
  if (opts.protect) {
    for (const x of String(opts.protect).split(',')) {
      const t = x.trim();
      if (t) extra.add(t);
    }
  }
  for (const name of opts.protectNames ?? []) {
    const t = String(name).trim();
    if (t) extra.add(t);
  }
  if (opts.protectFile && existsSync(opts.protectFile)) {
    for (const line of readFileSync(opts.protectFile, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) extra.add(t);
    }
  }

  if (opts.useNames) {
    for (const [s, e] of nameSpans(text, protectedMask, opts.names ?? new Set(), extra)) {
      for (let i = s; i < e; i++) protectedMask[i] = 1;
    }
  } else if (extra.size) {
    for (const [s, e] of substringSpans(text, extra)) {
      for (let i = s; i < e; i++) protectedMask[i] = 1;
    }
  }

  let result = text;
  if (opts.doPunct || opts.doDigits) {
    result = transformPunctDigits(result, protectedMask, opts, stats);
  }
  if (opts.doT2s) {
    result = convertHanzi(result, protectedMask, convert, stats);
  }

  stats.namesProtected = extra.size;
  return { text: result, stats };
}

// ---------------------------------------------------------------- 文件 I/O

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function readText(path) {
  const raw = readFileSync(path);
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, bom };
}

function writeText(path, text, bom) {
  const body = Buffer.from(text, 'utf8');
  writeFileSync(path, bom ? Buffer.concat([BOM, body]) : body);
}

function detectFormat(path, optsFormat) {
  if (optsFormat !== 'auto') return optsFormat;
  if (path && ['.md', '.markdown', '.mdx'].includes(extname(path).toLowerCase())) return 'md';
  return 'text';
}

function withSuffix(file, suffix) {
  return suffix.startsWith('.') ? file + suffix : `${file}.${suffix}`;
}

/** 从 stdin 读取全部文本（同步阻塞，适合 CLI 一次性输入） */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- 输出

function emitReport(label, stats, backend, asJson) {
  const total = stats.digits + stats.punct + stats.hanzi;
  if (asJson) {
    process.stderr.write(
      `${JSON.stringify({ target: label, backend, total, ...stats }, null, 0)}\n`,
    );
    return;
  }
  process.stderr.write(
    `[report] ${label}: 数字 ${stats.digits} 处 / 标点 ${stats.punct} 处 / ` +
      `繁简 ${stats.hanzi} 处 / 共 ${total} 处  (backend=${backend})\n`,
  );
  for (const ex of stats.examples.slice(0, 12)) {
    process.stderr.write(`         繁简示例: ${ex.from} → ${ex.to}\n`);
  }
}

function emitDiff(label, before, after) {
  if (before === after) return;
  const a = before.split('\n');
  const b = after.split('\n');
  const blocks = diffBlocks(a, b).filter((x) => x.type === 'change');
  const lines = [];
  for (const blk of blocks) {
    const removed = a.slice(blk.a1, blk.a2);
    const added = b.slice(blk.b1, blk.b2);
    lines.push(`@@ -${blk.a1 + 1},${removed.length} +${blk.b1 + 1},${added.length} @@`);
    for (const l of removed) lines.push(`-${l}`);
    for (const l of added) lines.push(`+${l}`);
  }
  process.stderr.write(
    `--- ${label} (原)\n+++ ${label} (规范化后)\n${lines.join('\n')}\n`,
  );
}

// ---------------------------------------------------------------- CLI

const HELP = `normalize.mjs — 中文文本字形级规范化（Node.js ESM，零依赖）

用法:
  node scripts/normalize.mjs [选项] [文件...]

输入（三选一）:
  --text <文本>              直接处理给出的文本
  --stdin                    从标准输入读取
  <文件...>                  处理文件

输出:
  (默认)                     输出到 stdout
  -i, --in-place             原地覆盖写回文件
  -o, --output <文件>        写入指定文件（单输入）
  --suffix <后缀>            批量输出，如 .norm → a.md.norm

报告:
  --check                    只报告不改动；有可改项时退出码 1
  --report                   输出改动统计（stderr）
  --report-json              以 JSON 输出改动统计（stderr）
  --diff                     输出 unified diff（stderr）

转换控制:
  --format auto|md|text      输入格式，默认按扩展名判断
  --period ideographic|fullwidth|keep   句点策略，默认 ideographic（. → 。）
  --quotes fullwidth|curly|keep         引号策略，默认 fullwidth（" → ＂）
  --symbols                  额外转换 @ # $ % & * + = / \\ ^ _ 等半角符号
  --no-t2s / --no-punct / --no-digits   单独关闭某一类转换
  --convert-frontmatter      让 YAML frontmatter 也参与转换（默认保护）

保护名单:
  --protect <名单>           逗号分隔，如 "鳩山由紀夫,盧武鉉"
  --protect-name <名>        追加一个保护名（可重复）
  --protect-file <文件>      保护名单文件，一行一个
  --no-names                 关闭日韩人名自动保护
  --names-file <文件>        自定义日韩人名表

后端:
  --backend auto|builtin|opencc   默认 auto：opencc-js 可用则用它，否则内置字表

其他:
  -h, --help                 显示帮助
  -V, --version              显示版本

退出码: 0 正常 / 1 --check 发现可改动项 / 2 参数或文件错误
`;

const VALUE_FLAGS = new Set([
  '--text', '--output', '--suffix', '--format', '--protect', '--protect-name',
  '--protect-file', '--names-file', '--period', '--quotes', '--backend',
]);
const SHORT_VALUE = { '-o': '--output' };

/** 极简参数解析（不引入第三方依赖） */
export function parseArgs(argv) {
  const opts = {
    files: [],
    text: null,
    stdin: false,
    inPlace: false,
    output: null,
    suffix: null,
    check: false,
    report: false,
    reportJson: false,
    diff: false,
    format: 'auto',
    protect: null,
    protectNames: [],
    protectFile: null,
    namesFile: null,
    protectFrontmatter: true,
    useNames: true,
    doT2s: true,
    doPunct: true,
    doDigits: true,
    period: 'ideographic',
    quotes: 'fullwidth',
    symbols: false,
    backend: 'auto',
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts.files.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '-V' || arg === '--version') {
      opts.version = true;
      continue;
    }
    if (arg === '-i' || arg === '--in-place') {
      opts.inPlace = true;
      continue;
    }
    if (arg === '--stdin') {
      opts.stdin = true;
      continue;
    }
    if (arg === '--check') { opts.check = true; continue; }
    if (arg === '--report') { opts.report = true; continue; }
    if (arg === '--report-json') { opts.reportJson = true; continue; }
    if (arg === '--diff') { opts.diff = true; continue; }
    if (arg === '--symbols') { opts.symbols = true; continue; }

    let name = arg;
    let value = null;
    if (SHORT_VALUE[arg]) name = SHORT_VALUE[arg];

    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    } else if (VALUE_FLAGS.has(name)) {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`选项 ${name} 缺少取值`);
      }
      value = argv[i];
    }

    switch (name) {
      case '--text': opts.text = value; break;
      case '--output': opts.output = value; break;
      case '--suffix': opts.suffix = value; break;
      case '--format': opts.format = value; break;
      case '--protect': opts.protect = value; break;
      case '--protect-name': opts.protectNames.push(value); break;
      case '--protect-file': opts.protectFile = value; break;
      case '--names-file': opts.namesFile = value; break;
      case '--period': opts.period = value; break;
      case '--quotes': opts.quotes = value; break;
      case '--backend': opts.backend = value; break;
      case '--no-names': opts.useNames = false; break;
      case '--no-t2s': opts.doT2s = false; break;
      case '--no-punct': opts.doPunct = false; break;
      case '--no-digits': opts.doDigits = false; break;
      case '--convert-frontmatter': opts.protectFrontmatter = false; break;
      default:
        if (arg.startsWith('-')) throw new Error(`未知选项: ${arg}`);
        opts.files.push(arg);
    }
  }
  return opts;
}

/** 校验选项取值，非法时抛出 */
function validateOptions(opts) {
  if (!['auto', 'md', 'text'].includes(opts.format)) {
    throw new Error(`--format 取值非法: ${opts.format}`);
  }
  if (!['ideographic', 'fullwidth', 'keep'].includes(opts.period)) {
    throw new Error(`--period 取值非法: ${opts.period}`);
  }
  if (!['fullwidth', 'curly', 'keep'].includes(opts.quotes)) {
    throw new Error(`--quotes 取值非法: ${opts.quotes}`);
  }
  if (!['auto', 'builtin', 'opencc'].includes(opts.backend)) {
    throw new Error(`--backend 取值非法: ${opts.backend}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[error] ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`normalize.mjs ${VERSION}\n`);
    return 0;
  }
  try {
    validateOptions(opts);
  } catch (err) {
    process.stderr.write(`[error] ${err.message}\n`);
    return 2;
  }

  /** @type {Array<{label:string, text:string, bom:boolean}>} */
  let items;
  if (opts.text !== null) {
    items = [{ label: '<text>', text: opts.text, bom: false }];
  } else if (opts.stdin) {
    items = [{ label: '<stdin>', text: readStdin(), bom: false }];
  } else if (opts.files.length) {
    items = [];
    for (const f of opts.files) {
      if (!existsSync(f)) {
        process.stderr.write(`[error] 文件不存在: ${f}\n`);
        return 2;
      }
      const { text, bom } = readText(f);
      items.push({ label: f, text, bom });
    }
  } else {
    process.stdout.write(HELP);
    return 2;
  }

  if (opts.files.length > 1 && !(opts.inPlace || opts.suffix || opts.check)) {
    process.stderr.write('[error] 多文件处理请显式指定 --in-place / --suffix / --check\n');
    return 2;
  }

  opts.names = loadNames(opts.namesFile ?? null);
  const { convert, name: backend } = await getConverter(opts.backend);

  let changedAny = false;
  const userFormat = opts.format;

  for (const item of items) {
    const isFile = item.label !== '<text>' && item.label !== '<stdin>';
    opts.format = detectFormat(isFile ? item.label : null, userFormat);
    const { text: result, stats } = normalizeText(item.text, opts, convert);
    if (result !== item.text) changedAny = true;

    if (opts.report || opts.reportJson || opts.check) {
      emitReport(item.label, stats, backend, opts.reportJson);
    }
    if (opts.diff) emitDiff(item.label, item.text, result);

    if (opts.check) continue;
    if (opts.inPlace || opts.suffix) {
      const target = opts.inPlace ? item.label : withSuffix(item.label, opts.suffix);
      writeText(target, result, item.bom);
      process.stderr.write(`[written] ${target}\n`);
    } else if (opts.output) {
      writeText(opts.output, result, item.bom);
      process.stderr.write(`[written] ${opts.output}\n`);
    } else {
      process.stdout.write(result);
    }
  }

  if (opts.check) return changedAny ? 1 : 0;
  return 0;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[error] ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
