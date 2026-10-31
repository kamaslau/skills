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
 *   5. 输出恒定 UTF-8 编码的 Markdown 文件：输入可为 UTF-8 / UTF-16 /
 *      GB18030 / Big5 / EUC-KR / Shift_JIS，探测后解码，再以 UTF-8 写出 .md。
 *
 * 运行环境：Node.js >= 22（v22「Jod」是 nodejs.org 公示的**仍受支持的最低 LTS**；
 * v20 及以下已 EOL）。所依赖的语言与标准库特性：
 *   - node:util parseArgs        （v18.3 起，v20 转稳定）
 *   - import.meta.dirname/filename（v20.11 / v21.2 起）
 *   - 迭代器辅助 .map() / 生成器  （V8 12.2 → v22.0 起）
 *   - Array.prototype.toSorted   （v20 起）
 *   - String.prototype.replaceAll（v15 起）
 *   - Object.hasOwn              （v16.9 起）
 * 自身零第三方依赖；`opencc-js` 为可选增强。
 *
 * 实现说明：全程按 UTF-16 码元（code unit）索引，与 Python 版的码点索引在
 * BMP 内等价。本工具关心的字符（汉字、假名、谚文、全角符号）均在 BMP，
 * 因此行为一致。
 */

import { existsSync, readFileSync, readSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { parseArgs as parseArgv } from 'node:util';

import {
  appendMarkdownExt,
  decodeBuffer,
  defaultOutputPath,
  encodeUtf8,
  ensureMarkdownPath,
  formatScriptTable,
  MD_EXTS,
} from './encoding.mjs';

const SCRIPT_DIR = import.meta.dirname;
const SKILL_DIR = join(SCRIPT_DIR, '..');
const DATA_DIR = join(SKILL_DIR, 'data');

const VERSION = '2.3.0';

/** 最低 Node 版本：nodejs.org 公示的仍受支持的最低 LTS 主版本号 */
const MIN_NODE_MAJOR = 22;

/**
 * 运行时版本校验。主版本低于下限时返回 ok:false。
 * @returns {{ok: boolean, message: string}}
 */
export function checkRuntime() {
  const current = process.versions.node;
  const major = Number.parseInt(current.split('.')[0], 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      message:
        `需要 Node.js >= ${MIN_NODE_MAJOR}（当前 ${current}）。` +
        `v${MIN_NODE_MAJOR} 是 Node.js 官网公示的仍受支持的最低 LTS 版本。`,
    };
  }
  return { ok: true, message: '' };
}

// 悬空标点强度表：相邻两个标点强度不同时丢弃较弱者，强度相同则原样保留
// （`！！`、`！？` 这类重复常是有意为之，不做合并）。
const PUNCT_STRENGTH = new Map([
  ['、', 1],
  ['，', 2],
  ['；', 3],
  ['：', 4],
  ['。', 5],
  ['！', 6],
  ['？', 6],
]);

/** @returns {number|undefined} */
function punctStrength(ch) {
  return ch ? PUNCT_STRENGTH.get(ch) : undefined;
}

// ---------------------------------------------------------------- 字符分类

// 汉字 / 假名 / 谚文 / 中日韩标点 / 全角字符，统一视为「CJK 上下文」
const CJK_RANGES = Object.freeze([
  [0x3001, 0x303f], // CJK 标点（不含 U+3000 全角空格）
  [0x3040, 0x30ff], // 假名
  [0x31f0, 0x31ff], // 片假名扩展
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本汉字
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // 兼容汉字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff01, 0xffef], // 全角/半角形式
]);

const KANA_RANGES = Object.freeze([
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
  [0xff66, 0xff9f],
  [0x30fb, 0x30fc],
]);
const HANGUL_RANGES = Object.freeze([
  [0xac00, 0xd7af],
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
]);
const HAN_RANGES = Object.freeze([
  [0x2e80, 0x2eff],
  [0x2f00, 0x2fdf],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
]);

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

const PUNCT_MAP = Object.freeze({
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
});

const SYMBOL_MAP = Object.freeze({
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
});

const CURLY_OPEN = Object.freeze({ '"': '“', "'": '‘' });
const CURLY_CLOSE = Object.freeze({ '"': '”', "'": '’' });

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
  return ranges.some(([a, b]) => code >= a && code <= b);
}

function isCjk(ch) {
  if (!ch) return false;
  return inRanges(ch.charCodeAt(0), CJK_RANGES);
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

/** 全角英文字母（U+FF21–FF3A / U+FF41–FF5A） */
function isFullwidthLetter(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a);
}

function halfwidthLetter(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 0xff21 && c <= 0xff3a) return String.fromCharCode(0x41 + (c - 0xff21));
  return String.fromCharCode(0x61 + (c - 0xff41));
}

// ---------------------------------------------------------------- 繁转简后端

/**
 * 零依赖兜底转换器：OpenCC 单字表 + 词组表，最长匹配优先。
 * 等价于 OpenCC 的 t2s 配置（TSCharacters + TSPhrases）。
 */
export class FallbackT2S {
  /** @type {Map<string,string>} */
  #chars = new Map();
  /** @type {Map<string,string>} */
  #phrases = new Map();
  /** 词组表最长键长度 */
  #maxlen = 1;

  constructor(dataDir = DATA_DIR) {
    for (const [file, target] of [
      ['TSCharacters.txt', this.#chars],
      ['TSPhrases.txt', this.#phrases],
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
    for (const k of this.#phrases.keys()) {
      if (k.length > this.#maxlen) this.#maxlen = k.length;
    }
  }

  convert(text) {
    const out = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
      let hit = false;
      if (this.#phrases.size) {
        for (let len = Math.min(this.#maxlen, n - i); len > 1; len--) {
          const rep = this.#phrases.get(text.slice(i, i + len));
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
      out.push(this.#chars.get(ch) ?? ch);
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
  const sorted = spans.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [[...sorted[0]]];
  for (const [s, e] of sorted.slice(1)) {
    const last = merged.at(-1);
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
    const m = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(text.slice(3));
    if (m) spans.push([0, 3 + m.index + m[0].length]);
  }

  // 逐行：围栏代码块 / 表格 / 标题 / 列表 / 引用标记
  let pos = 0;
  let inFence = false;
  let fenceTok = null;
  for (const line of text.split('\n')) {
    const start = pos;
    const end = pos + line.length;
    const stripped = line.trim();
    const fm = /^[ \t]*(```|~~~)/.exec(line);
    if (inFence) {
      // 连行尾换行符一并保护：空行的 [start,end] 长度为 0，若不覆盖换行符，
      // 代码块内的空行会被后续的空白压缩误删。
      spans.push([start, Math.min(end + 1, text.length)]);
      if (fm?.[1] === fenceTok) {
        inFence = false;
        fenceTok = null;
      }
    } else if (fm) {
      inFence = true;
      fenceTok = fm[1];
      spans.push([start, Math.min(end + 1, text.length)]);
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
  if (md) inline.push('\\[\\^[^\\]\\n]*\\]', '\\{[^{}\\n]*\\}');
  for (const src of inline) {
    for (const m of text.matchAll(new RegExp(src, 'g'))) {
      spans.push([m.index, m.index + m[0].length]);
    }
  }

  // 链接/图片：仅保护定界符与 URL，链接文字仍参与转换
  if (md) {
    for (const m of text.matchAll(/(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/gd)) {
      const [textStart, textEnd] = m.indices[2];
      const urlEnd = m.indices[3][1];
      spans.push([textStart - 1, textStart]); // [
      spans.push([textEnd, textEnd + 1]); // ]
      spans.push([textEnd + 1, urlEnd + 1]); // (url)
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
  const p = prevChar(text, i);
  const q = nextChar(text, i);
  const pch = p >= 0 ? out[p] : '';
  const qch = q >= 0 ? text[q] : '';
  // 左邻的 CJK 判定同时参考「原字符」：全角数字/字母会被本轮换成半角，
  // 但它们在原文里属于 CJK 语境（否则「數字１.」的句点会漏判）。
  const pch0 = p >= 0 ? text[p] : '';
  const pcjk = isCjk(pch) || isCjk(pch0);
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

  if (Object.hasOwn(SYMBOL_MAP, ch)) {
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

    if (opts.doLetters && isFullwidthLetter(ch)) {
      out[i] = halfwidthLetter(ch);
      stats.letters += 1;
      continue;
    }

    if (
      ch === '.' ||
      Object.hasOwn(PUNCT_MAP, ch) ||
      (opts.symbols && Object.hasOwn(SYMBOL_MAP, ch))
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

// ---------------------------------------------------------------- 空白 / 悬空标点

/**
 * 按保护掩码把文本切成连续的片段。惰性生成，配合迭代器辅助方法使用。
 * @param {string} text
 * @param {Uint8Array} mask
 */
export function* maskRuns(text, mask) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const flag = mask[i] ? 1 : 0;
    let j = i;
    while (j < n && (mask[j] ? 1 : 0) === flag) j += 1;
    yield { text: text.slice(i, j), protected: flag === 1, start: i };
    i = j;
  }
}

/** 单个非保护片段的空白收敛（collapseWhitespace 的内部步骤） */
function collapseRun(run, mode, prevIsNewline) {
  let s = run.text;
  if (mode === 'full') {
    // 行尾空白与文末空白
    s = s.replace(/[ \t　]+(?=\r?\n|$)/g, '');
  } else {
    // 仅清空「空白行」：整行只有空格 / 制表 / 全角空格
    s = s.replace(/(?<=\r?\n)[ \t　]+(?=\r?\n|$)/g, '');
    if (run.start === 0) s = s.replace(/^[ \t　]+(?=\r?\n|$)/, '');
  }
  s = s.replace(/(?:\r?\n)(?:[ \t　]*\r?\n){2,}/g, (m) =>
    m.startsWith('\r\n') ? '\r\n\r\n' : '\n\n',
  );
  // 若片段紧接在一个换行之后（上一片段结尾不可删），本片段开头的换行
  // 属于同一串换行：为凑满「至多两个」只保留一个。
  if (prevIsNewline) {
    s = s.replace(/^(?:\r?\n){2,}/, (m) => (m.startsWith('\r\n') ? '\r\n' : '\n'));
  }
  return s;
}

/**
 * 移除冗余空字符。
 * - blank（默认）：连续 3+ 换行压到 2（至多保留一个空行）；空白行清空；
 *   文首空行删除；文末连续换行收敛为一个。**不动行尾空格**——Markdown 靠
 *   行尾两空格表示硬换行，删掉会改渲染。
 * - full：在 blank 之上额外移除每行行尾空白（含全角空格）。
 * - off：不动。
 *
 * 受保护区域（代码块等）内的换行原样保留。
 */
export function collapseWhitespace(text, mask, mode, stats) {
  if (mode === 'off' || text.length === 0) return text;

  const runs = maskRuns(text, mask).map((run) =>
    run.protected ? run.text : collapseRun(run, mode, run.start > 0 && text[run.start - 1] === '\n'),
  );
  let out = [...runs].join('');

  if (!mask[0]) out = out.replace(/^(?:\r?\n)+/, '');
  if (!mask.at(-1)) out = out.replace(/(\r?\n)(?:\r?\n)+$/, '$1');

  const removed = text.length - out.length;
  if (removed > 0) stats.whitespace += removed;
  return out;
}

/** 单个非保护片段的悬空标点收敛（removeDanglingPunct 的内部步骤） */
function collapsePunctRun(s, stats) {
  let buf = '';
  let i = 0;
  while (i < s.length) {
    if (punctStrength(s[i]) === undefined) {
      buf += s[i];
      i += 1;
      continue;
    }
    // 找出一段连续的标点串 [i, j)，取其最高强度
    let j = i;
    let max = 0;
    while (j < s.length) {
      const st = punctStrength(s[j]);
      if (st === undefined) break;
      if (st > max) max = st;
      j += 1;
    }
    let kept = 0;
    for (let k = i; k < j; k++) {
      if (punctStrength(s[k]) === max) {
        buf += s[k];
        kept += 1;
      }
    }
    stats.dangling += j - i - kept;
    i = j;
  }
  return buf;
}

/**
 * 移除悬空标点：把「连续标点串」收敛为其最强者。
 * - 强度不同时只保留强度最高的字符（`，。` → `。`、`，；` → `；`、`。，` → `。`）
 * - 整串强度相同时原样保留（`！！`、`？！` 这类重复常为有意强调）
 */
export function removeDanglingPunct(text, mask, stats) {
  const runs = maskRuns(text, mask).map((run) =>
    run.protected ? run.text : collapsePunctRun(run.text, stats),
  );
  return [...runs].join('');
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
  for (const blk of lcsBlocks(aMid, bMid)) {
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
  for (const [k, [s, e]] of spans.entries()) {
    // 用函数型替换以免被保护文本里的 $& / $1 等被当作替换模式解释
    result = result.replaceAll(holders[k], () => text.slice(s, e));
  }
  return result;
}

// ---------------------------------------------------------------- 主流程

/** 收集用户显式传入的保护名单 */
function collectExtraNames(opts) {
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
    // 保护名单文件同样走编码探测，避免用户给的是 GB18030 名单
    const raw = decodeBuffer(readFileSync(opts.protectFile)).text;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) extra.add(t);
    }
  }
  return extra;
}

/** 构建保护掩码：结构区域 + 日韩人名（或仅用户名单）。导出供调试与测试使用。 */
export function buildMask(text, opts, extra) {
  const mask = new Uint8Array(text.length);
  for (const [s, e] of structuralSpans(text, opts.format, opts.protectFrontmatter)) {
    for (let i = s; i < Math.min(e, text.length); i++) mask[i] = 1;
  }
  if (opts.useNames) {
    for (const [s, e] of nameSpans(text, mask, opts.names ?? new Set(), extra)) {
      for (let i = s; i < e; i++) mask[i] = 1;
    }
  } else if (extra.size) {
    for (const [s, e] of substringSpans(text, extra)) {
      for (let i = s; i < e; i++) mask[i] = 1;
    }
  }
  return mask;
}

/**
 * 对单段文本执行规范化。
 * 流程：冗余空白清理 → 数字/字母/标点 → 繁转简 → 悬空标点。
 *
 * 顺序是硬约束：空白清理与悬空标点都会**改变文本长度**，而保护掩码是按索引
 * 标注的。空白清理之后必须重算掩码（下方已处理）；悬空标点则必须放在最后一步
 * ——它之后不再有依赖掩码的操作，因此无需重算。（曾把它放在繁转简之前，掩码
 * 整体前移，导致「安倍晋三」的保护错落到「倍晋三與」上。）
 * 数字/字母/标点三步都是等长替换，不影响掩码。
 *
 * @param {string} text
 * @param {object} opts
 * @param {(s:string)=>string} convert
 */
export function normalizeText(text, opts, convert) {
  const stats = {
    digits: 0,
    letters: 0,
    punct: 0,
    whitespace: 0,
    dangling: 0,
    hanzi: 0,
    examples: [],
  };

  const extra = collectExtraNames(opts);
  let working = text;
  let mask = buildMask(working, opts, extra);

  if (opts.whitespace !== 'off') {
    const cleaned = collapseWhitespace(working, mask, opts.whitespace, stats);
    if (cleaned !== working) {
      working = cleaned;
      mask = buildMask(working, opts, extra); // 索引已变，掩码必须重算
    }
  }

  if (opts.doPunct || opts.doDigits || opts.doLetters) {
    working = transformPunctDigits(working, mask, opts, stats);
  }
  if (opts.doT2s) {
    working = convertHanzi(working, mask, convert, stats);
  }
  // 悬空标点清理会缩短文本，必须放在最后（见上方流程说明）
  if (opts.doDangling) {
    working = removeDanglingPunct(working, mask, stats);
  }

  stats.namesProtected = extra.size;
  return { text: working, stats };
}

// ---------------------------------------------------------------- 文件 I/O

/**
 * 读入文件：字节 → 探测编码 → 解码为字符串。
 * 输入可以是 UTF-8 / UTF-16 / GB18030 / Big5 / EUC-KR / Shift_JIS；
 * 输出恒为 UTF-8，因此这里必须先把输入正确解码，否则「乱码进、乱码出」。
 * @param {string} path
 * @param {string|null} inputEncoding --input-encoding 显式指定时跳过探测
 */
async function readText(path, inputEncoding = null) {
  const raw = await readFile(path);
  const info = decodeBuffer(raw, inputEncoding);
  // TextDecoder 默认会剥掉 BOM，此处仅记录它是否存在，供 --bom keep 复现
  return {
    text: info.text,
    bom: info.bom,
    encoding: info.encoding,
    encodingConfidence: info.confidence,
  };
}

/** BOM 策略：keep = 输入有则保留；strip = 一律去掉；add = 一律加上 */
function resolveBom(policy, hadBom) {
  if (policy === 'strip') return false;
  if (policy === 'add') return true;
  return hadBom;
}

/** 输出恒为 UTF-8。Content 结尾保证有换行（Markdown 文件的基本形态）。 */
async function writeText(path, text, bom) {
  await writeFile(path, encodeUtf8(ensureTrailingNewline(text), bom));
}

/** 文本以换行结尾；缺失时补上，并沿用正文已有的行尾风格（LF / CRLF） */
function ensureTrailingNewline(text) {
  if (!text || text.endsWith('\n')) return text;
  return text + (text.includes('\r\n') ? '\r\n' : '\n');
}

function detectFormat(path, optsFormat) {
  if (optsFormat !== 'auto') return optsFormat;
  if (path && ['.md', '.markdown', '.mdx'].includes(extname(path).toLowerCase())) return 'md';
  return 'text';
}

function withSuffix(file, suffix) {
  return suffix.startsWith('.') ? file + suffix : `${file}.${suffix}`;
}

/**
 * 从 stdin 读取全部字节并解码（同样走编码探测，可管道输入 GB18030 等）。
 *
 * stdin 的读法有两个坑：
 *   - `readFileSync(0)` 在部分平台（含 Windows 上被代理的 fs shim）只返回首个分片；
 *   - `for await (const c of process.stdin)` 默认按 UTF-8 解码，非 UTF-8 字节会被
 *     替换成 U+FFFD，后续编码探测与转码就没机会做了。
 * 因此用 `readSync` 循环读原始字节；代价是「非 TTY 但无数据」时会阻塞，故先判 isTTY。
 * @param {string|null} inputEncoding
 */
function readStdin(inputEncoding = null) {
  if (process.stdin.isTTY) {
    throw new Error('--stdin 需要管道输入（或改用 --text / 文件路径）');
  }
  const chunks = [];
  const buf = Buffer.alloc(1 << 16);
  let spins = 0;
  for (;;) {
    let n;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = err?.code;
      // EOF：Windows 管道读到末尾；EAGAIN/EINTR：重试但避免无数据时空转
      if (code === 'EOF' || code === 'EPIPE') break;
      if ((code === 'EAGAIN' || code === 'EINTR') && ++spins < 10000) continue;
      throw err;
    }
    if (n === 0) break;
    spins = 0;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  const info = decodeBuffer(Buffer.concat(chunks), inputEncoding);
  return {
    text: info.text,
    bom: info.bom,
    encoding: info.encoding,
    encodingConfidence: info.confidence,
  };
}

// ---------------------------------------------------------------- 输出

function emitReport(label, stats, backend, asJson, enc = null) {
  const total =
    stats.digits + stats.letters + stats.punct + stats.whitespace + stats.dangling + stats.hanzi;
  const encTag = enc ? ` (${enc.encoding}${enc.confidence === 'high' ? '' : `, ${enc.confidence}`})` : '';
  if (asJson) {
    process.stderr.write(
      `${JSON.stringify({ target: label, backend, total, inputEncoding: enc, ...stats }, null, 0)}\n`,
    );
    return;
  }
  process.stderr.write(
    `[report] ${label}: 数字 ${stats.digits} / 字母 ${stats.letters} / 标点 ${stats.punct} / ` +
      `空白 ${stats.whitespace} / 悬空标点 ${stats.dangling} / 繁简 ${stats.hanzi} ` +
      `/ 共 ${total} 处  (backend=${backend})${encTag}\n`,
  );
  for (const ex of stats.examples.slice(0, 12)) {
    process.stderr.write(`         繁简示例: ${ex.from} → ${ex.to}\n`);
  }
}

function emitDiff(label, before, after) {
  if (before === after) return;
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [];
  for (const blk of diffBlocks(a, b).filter((x) => x.type === 'change')) {
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

环境要求: Node.js >= ${MIN_NODE_MAJOR}（官网公示的仍受支持的最低 LTS）

用法:
  node scripts/normalize.mjs [选项] [文件...]

输入（三选一）:
  --text <文本>              直接处理给出的文本（文本以 - 开头请用 --text=<文本>）
  --stdin                    从标准输入读取
  <文件...>                  处理文件
  --input-encoding <编码>    强制指定输入编码（默认自动探测，见下）

输出（恒为 UTF-8 编码的 Markdown 文件）:
  (默认)                     文件输入写出同名 .md：a.txt → a.md，a.md → a.normalized.md
  -i, --in-place             原地覆盖写回原文件（唯一可能保持非 .md 扩展名的模式）
  -o, --output <文件>        写入指定文件（扩展名强制为 .md）
  --suffix <后缀>            批量输出，如 .norm → a.norm.md
  --stdout                   强制输出到 stdout，不写文件
  --bom keep|strip|add       UTF-8 BOM 策略，默认 keep（沿用输入是否有 BOM）

输入编码自动探测顺序：BOM → 严格 UTF-8 合法性 → UTF-16 空字节模式
  → GB18030/Big5/EUC-KR/Shift_JIS 字频打分。非 UTF-8 输入会被转码为 UTF-8 输出。

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
  --no-letters               关闭全角英文字母转半角（ＡＢＣ → ABC，默认开启）
  --whitespace blank|full|off           冗余空字符清理，默认 blank
                             blank: 3+ 换行压到 2、空白行清空、文首/文末空行收敛
                             full: 在 blank 之上再删每行行尾空白（含全角空格）
  --no-dangling              关闭悬空标点清理（，。 → 。，默认开启）
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
  --print-scripts            打印「书写系统 ↔ 码点区间 ↔ UTF-8 字节区间」对照表

退出码: 0 正常 / 1 --check 发现可改动项 / 2 参数或文件错误
`;

/**
 * CLI 选项表（交给 node:util 的 parseArgs）。
 * `--no-x` 一律显式声明：parseArgs 的 allowNegative 是 v22.4 才有的，
 * 直接声明 `--no-x` 键可在整个 v22 线上工作。
 */
const CLI_OPTIONS = Object.freeze({
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
  'in-place': { type: 'boolean', short: 'i', default: false },
  stdin: { type: 'boolean', default: false },
  check: { type: 'boolean', default: false },
  report: { type: 'boolean', default: false },
  'report-json': { type: 'boolean', default: false },
  diff: { type: 'boolean', default: false },
  symbols: { type: 'boolean', default: false },
  'convert-frontmatter': { type: 'boolean', default: false },
  'no-names': { type: 'boolean', default: false },
  'no-t2s': { type: 'boolean', default: false },
  'no-punct': { type: 'boolean', default: false },
  'no-digits': { type: 'boolean', default: false },
  'no-letters': { type: 'boolean', default: false },
  'no-dangling': { type: 'boolean', default: false },
  'print-scripts': { type: 'boolean', default: false },
  stdout: { type: 'boolean', default: false },
  text: { type: 'string' },
  output: { type: 'string', short: 'o' },
  suffix: { type: 'string' },
  format: { type: 'string', default: 'auto' },
  period: { type: 'string', default: 'ideographic' },
  quotes: { type: 'string', default: 'fullwidth' },
  whitespace: { type: 'string', default: 'blank' },
  backend: { type: 'string', default: 'auto' },
  bom: { type: 'string', default: 'keep' },
  'input-encoding': { type: 'string' },
  protect: { type: 'string' },
  'protect-name': { type: 'string', multiple: true, default: [] },
  'protect-file': { type: 'string' },
  'names-file': { type: 'string' },
});

/**
 * 解析命令行参数。未知选项 / 缺值由 parseArgs 抛出，交由 main 转成退出码 2。
 * @param {string[]} argv
 */
export function parseCliArgs(argv) {
  const { values, positionals } = parseArgv({
    args: argv,
    options: CLI_OPTIONS,
    allowPositionals: true,
  });

  return {
    files: positionals,
    text: values.text ?? null,
    stdin: values.stdin,
    stdout: values.stdout,
    inPlace: values['in-place'],
    output: values.output ?? null,
    suffix: values.suffix ?? null,
    check: values.check,
    report: values.report,
    reportJson: values['report-json'],
    diff: values.diff,
    format: values.format,
    protect: values.protect ?? null,
    protectNames: [...values['protect-name']],
    protectFile: values['protect-file'] ?? null,
    namesFile: values['names-file'] ?? null,
    protectFrontmatter: !values['convert-frontmatter'],
    useNames: !values['no-names'],
    doT2s: !values['no-t2s'],
    doPunct: !values['no-punct'],
    doDigits: !values['no-digits'],
    doLetters: !values['no-letters'],
    doDangling: !values['no-dangling'],
    whitespace: values.whitespace,
    period: values.period,
    quotes: values.quotes,
    symbols: values.symbols,
    backend: values.backend,
    bom: values.bom,
    inputEncoding: values['input-encoding'] ?? null,
    printScripts: values['print-scripts'],
    help: values.help,
    version: values.version,
  };
}

/** 校验选项取值，非法时抛出 */
function validateOptions(opts) {
  const allowed = {
    '--format': ['auto', 'md', 'text'],
    '--period': ['ideographic', 'fullwidth', 'keep'],
    '--quotes': ['fullwidth', 'curly', 'keep'],
    '--backend': ['auto', 'builtin', 'opencc'],
    '--whitespace': ['blank', 'full', 'off'],
    '--bom': ['keep', 'strip', 'add'],
  };
  const keyOf = {
    '--format': opts.format,
    '--period': opts.period,
    '--quotes': opts.quotes,
    '--backend': opts.backend,
    '--whitespace': opts.whitespace,
    '--bom': opts.bom,
  };
  for (const [flag, list] of Object.entries(allowed)) {
    if (!list.includes(keyOf[flag])) {
      throw new Error(`${flag} 取值非法: ${keyOf[flag]}（可选 ${list.join('|')}）`, {
        cause: { flag, value: keyOf[flag] },
      });
    }
  }
  // 编码名提前校验：--text 输入不走解码，若等到文件阶段才报错会漏掉这条路径
  if (opts.inputEncoding) {
    try {
      new TextDecoder(opts.inputEncoding);
    } catch {
      throw new Error(`--input-encoding 取值非法: ${opts.inputEncoding}（当前 Node 不支持该编码标签）`, {
        cause: { flag: '--input-encoding', value: opts.inputEncoding },
      });
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const runtime = checkRuntime();
  if (!runtime.ok) {
    process.stderr.write(`[error] ${runtime.message}\n`);
    return 2;
  }

  let opts;
  try {
    opts = parseCliArgs(argv);
  } catch (err) {
    process.stderr.write(`[error] ${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`normalize.mjs ${VERSION} (node ${process.versions.node})\n`);
    return 0;
  }
  if (opts.printScripts) {
    process.stdout.write(`${formatScriptTable()}\n`);
    return 0;
  }
  try {
    validateOptions(opts);
  } catch (err) {
    process.stderr.write(`[error] ${err.message}\n`);
    return 2;
  }

  /** @type {Array<{label:string, text:string, bom:boolean, encoding:string, confidence:string}>} */
  let items;
  if (opts.text !== null) {
    items = [{ label: '<text>', text: opts.text, bom: false, encoding: 'utf-8', confidence: 'explicit' }];
  } else if (opts.stdin) {
    let s;
    try {
      s = readStdin(opts.inputEncoding);
    } catch (err) {
      process.stderr.write(`[error] ${err?.message ?? err}\n`);
      return 2;
    }
    items = [{ label: '<stdin>', ...s, confidence: s.encodingConfidence }];
  } else if (opts.files.length) {
    items = [];
    for (const f of opts.files) {
      if (!existsSync(f)) {
        process.stderr.write(`[error] 文件不存在: ${f}\n`);
        return 2;
      }
      try {
        const r = await readText(f, opts.inputEncoding);
        items.push({ label: f, ...r, confidence: r.encodingConfidence });
      } catch (err) {
        process.stderr.write(`[error] ${f}: ${err?.message ?? err}\n`);
        return 2;
      }
    }
  } else {
    process.stdout.write(HELP);
    return 2;
  }

  if (opts.files.length > 1 && !(opts.inPlace || opts.suffix || opts.check)) {
    process.stderr.write('[error] 多文件处理请显式指定 --in-place / --suffix / --check\n');
    return 2;
  }
  if (opts.output && (opts.inPlace || opts.suffix)) {
    process.stderr.write('[error] --output 不能与 --in-place / --suffix 同时使用\n');
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

    const encInfo = { encoding: item.encoding, confidence: item.confidence };
    if (opts.report || opts.reportJson || opts.check) {
      emitReport(item.label, stats, backend, opts.reportJson, encInfo);
    }
    if (
      encInfo.confidence !== 'high' &&
      encInfo.confidence !== 'explicit' &&
      (opts.report || opts.check)
    ) {
      process.stderr.write(
        `[warn] ${item.label}: 输入编码判定为 ${encInfo.encoding}（置信度 ${encInfo.confidence}），` +
          `如结果乱码请用 --input-encoding 指定\n`,
      );
    }
    if (opts.diff) emitDiff(item.label, item.text, result);

    if (opts.check) continue;

    const bom = resolveBom(opts.bom, item.bom);
    let target = null;
    if (opts.inPlace) {
      target = item.label;
      if (!MD_EXTS.includes(extname(target).toLowerCase())) {
        process.stderr.write(
          `[warn] ${target}: --in-place 保持原扩展名；如需 Markdown 请改用默认输出或 --suffix\n`,
        );
      }
    } else if (opts.suffix) {
      target = appendMarkdownExt(withSuffix(item.label, opts.suffix));
    } else if (opts.output) {
      target = ensureMarkdownPath(opts.output);
    } else if (isFile && !opts.stdout) {
      target = defaultOutputPath(item.label);
    }

    if (target !== null) {
      await writeText(target, result, bom);
      process.stderr.write(`[written] ${target}\n`);
    } else {
      process.stdout.write(result);
    }
  }

  if (opts.check) return changedAny ? 1 : 0;
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[error] ${err?.stack ?? err}\n`);
      process.exit(2);
    },
  );
}
