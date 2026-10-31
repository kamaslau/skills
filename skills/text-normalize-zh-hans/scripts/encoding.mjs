#!/usr/bin/env node
// @ts-check
/**
 * encoding.mjs — 编码探测、固定 UTF-8 输出、Markdown 路径约定，
 *               以及「字符书写系统 ↔ 码点区间 ↔ UTF-8 字节区间」对照表。
 *
 * 三条设计原则：
 *
 * 1. 输出恒定：无论输入是 UTF-8 / UTF-16 / GB18030 / Big5 / EUC-KR / Shift_JIS，
 *    一律解码为字符串、处理、再以 UTF-8 编码写出 `.md` 文件。
 *
 * 2. 语种判定用码点（UTF-16）而非字节：UTF-8 是保序前缀码，码点区间与字节区间
 *    一一对应（见 SCRIPTS 表与 assertByteOrder 结论），在 JS 里直接读
 *    `charCodeAt` 比先 encode 成字节再判区间快一个数量级。字节区间表的用途是
 *    「面向字节的流水线」（Go/Rust/C 的字节切片、流式扫描、解码前的原始字节分析）。
 *
 * 3. 编码判定必须用字节：编码未知时无法解码，只能靠字节模式（BOM、NUL 分布、
 *    UTF-8 合法性、legacy 双字节解码后的字频打分）。
 */

import { basename, dirname, extname, join } from 'node:path';

// ---------------------------------------------------------------- BOM 与常量

export const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf]);
export const UTF16LE_BOM = Object.freeze([0xff, 0xfe]);
export const UTF16BE_BOM = Object.freeze([0xfe, 0xff]);

/** 视为 Markdown 的扩展名 */
export const MD_EXTS = Object.freeze(['.md', '.markdown', '.mdx']);

/** 探测时按此顺序给 legacy 编码打分；utf-8 由「严格解码是否抛错」单独判定 */
const LEGACY_CANDIDATES = Object.freeze(['gb18030', 'big5', 'euc-kr', 'shift_jis']);

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// 常见汉字字频表（简体 + 繁体高频字各约 150 个）。
// 用途：GB18030 / Big5 / EUC-KR 互相误判时，正确解码会命中大量高频字，
// 错误解码得到的是同码量级的生僻字 —— 用命中数即可区分，无需完整字频表。
const COMMON_ZH = new Set(
  '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感' +
    '這個們來時為說國著裡後會過對麼樣發當還從無現頭經長兒愛給間兩進話與產實點業關東車馬風書邊問學體電聽',
);

// ---------------------------------------------------------------- 码点分类

const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * 书写系统对照表：码点区间 ↔ UTF-8 字节区间。
 * UTF-8 字节区间由 code point 计算得出（而非手写），避免文档与实现漂移。
 */
export const SCRIPTS = Object.freeze([
  { id: 'ascii', name: 'ASCII（半角拉丁、半角标点）', ranges: [[0x0000, 0x007f]] },
  { id: 'latin', name: '拉丁扩展（西欧、越南语）', ranges: [[0x00a0, 0x00ff], [0x0100, 0x017f]] },
  { id: 'greek-cyrillic', name: '希腊文 / 西里尔文', ranges: [[0x0370, 0x03ff], [0x0400, 0x04ff]] },
  { id: 'semitic', name: '希伯来文 / 阿拉伯文', ranges: [[0x0590, 0x05ff], [0x0600, 0x06ff]] },
  { id: 'indic-thai', name: '天城文 / 泰文', ranges: [[0x0900, 0x097f], [0x0e00, 0x0e7f]] },
  { id: 'cjk-punct', name: 'CJK 标点符号', ranges: [[0x3000, 0x303f]] },
  { id: 'kana', name: '日文假名', ranges: [[0x3040, 0x30ff], [0x31f0, 0x31ff]] },
  { id: 'bopomofo-jamo', name: '注音 / 谚文兼容字母', ranges: [[0x3100, 0x312f], [0x3130, 0x318f]] },
  { id: 'cjk-ext-a', name: 'CJK 扩展 A', ranges: [[0x3400, 0x4dbf]] },
  { id: 'cjk-basic', name: 'CJK 基本汉字', ranges: [[0x4e00, 0x9fff]] },
  { id: 'hangul', name: '谚文音节', ranges: [[0xac00, 0xd7af]] },
  { id: 'cjk-compat', name: 'CJK 兼容汉字', ranges: [[0xf900, 0xfaff]] },
  { id: 'fullwidth', name: '全角 / 半角形式', ranges: [[0xff00, 0xffef]] },
  { id: 'cjk-ext-b', name: 'CJK 扩展 B 及以后（增补平面）', ranges: [[0x20000, 0x2ffff]] },
  { id: 'emoji', name: '表情符号', ranges: [[0x1f300, 0x1f9ff]] },
]);

/** 单字符的 UTF-8 字节序列 */
export function utf8Bytes(cp) {
  return [...Buffer.from(String.fromCodePoint(cp), 'utf8')];
}

/** 码点区间 → 该区间首/末字符的 UTF-8 字节序列 */
export function utf8ByteRange([from, to]) {
  return { first: utf8Bytes(from), last: utf8Bytes(to) };
}

/** 字节序列 → 十六进制串，如 `E4 B8 80` */
export function formatHex(bytes) {
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/** 某书写系统覆盖到的 lead byte（首字节）取值集合 */
export function leadBytesOf(scriptId) {
  const script = SCRIPTS.find((s) => s.id === scriptId);
  if (!script) return [];
  const set = new Set();
  for (const range of script.ranges) {
    const { first, last } = utf8ByteRange(range);
    // lead byte 只由码点高位决定：首、末之间的每个 lead byte 都可能出现
    for (let b = first[0]; b <= last[0]; b++) set.add(b);
  }
  return [...set].sort((a, b) => a - b);
}

/** 码点归属的书写系统 id，未收录返回 null */
export function scriptOfCodePoint(cp) {
  for (const s of SCRIPTS) if (inRanges(cp, s.ranges)) return s.id;
  return null;
}

const hex2 = (b) => `0x${b.toString(16).toUpperCase().padStart(2, '0')}`;

/** 把字节值集合折叠成区间写法：`0x00–0x7F`、`0xC2 0xC4–0xC5` */
export function formatLeadBytes(bytes) {
  if (!bytes.length) return '—';
  const parts = [];
  let start = bytes[0];
  let prev = bytes[0];
  for (const b of bytes.slice(1)) {
    if (b === prev + 1) {
      prev = b;
      continue;
    }
    parts.push(start === prev ? hex2(start) : `${hex2(start)}–${hex2(prev)}`);
    start = b;
    prev = b;
  }
  parts.push(start === prev ? hex2(start) : `${hex2(start)}–${hex2(prev)}`);
  return parts.join(' ');
}

/** 生成 Markdown 对照表（供 `node scripts/normalize.mjs --print-scripts` 与文档使用） */
export function formatScriptTable() {
  const rows = SCRIPTS.map((s) => {
    const cps = s.ranges
      .map(([a, b]) => `U+${a.toString(16).toUpperCase().padStart(4, '0')}–U+${b.toString(16).toUpperCase().padStart(4, '0')}`)
      .join('、');
    const utf = s.ranges
      .map((r) => {
        const { first, last } = utf8ByteRange(r);
        return `${formatHex(first)}…${formatHex(last)}`;
      })
      .join('、');
    const leads = formatLeadBytes(leadBytesOf(s.id));
    const widths = [...new Set(s.ranges.map(([a]) => utf8Bytes(a).length))].join('/');
    return `| \`${s.id}\` | ${s.name} | ${cps} | ${utf} | ${leads} | ${widths} |`;
  });
  return [
    '| id | 书写系统 | 码点区间 | UTF-8 字节区间（首…末） | lead byte | 字节数 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

// ---------------------------------------------------------------- 编码探测

function startsWith(buf, bytes) {
  return buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
}

/** 严格 UTF-8 解码：任一字节序列非法即抛错 */
function isValidUtf8(buf) {
  try {
    STRICT_UTF8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * UTF-16 无 BOM 时的判别：ASCII 字符在 UTF-16 中必有一半是 0x00。
 * LE：`41 00`；BE：`00 41`。统计「预期位置为 0」的比例。
 */
function utf16Heuristic(buf) {
  if (buf.length < 4 || buf.length % 2 !== 0) return null;
  const pairs = buf.length / 2;
  let le = 0;
  let be = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] !== 0 && buf[i + 1] === 0) le++;
    if (buf[i] === 0 && buf[i + 1] !== 0) be++;
  }
  const leRatio = le / pairs;
  const beRatio = be / pairs;
  const best = Math.max(leRatio, beRatio);
  if (best < 0.25) return null;
  return { encoding: leRatio >= beRatio ? 'utf-16le' : 'utf-16be', confidence: best > 0.6 ? 'medium' : 'low', ratio: best };
}

/** legacy 双字节编码解码结果的合理性打分 */
function scoreDecoding(text) {
  let score = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfffd) {
      score -= 8; // 解码失败
      continue;
    }
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) {
      score -= 8; // 控制字符
      continue;
    }
    if (cp < 0x80) {
      score += 0.6;
      continue;
    }
    if (COMMON_ZH.has(ch)) score += 4;
    // 平假名 +3、片假名 +2：真日语文本两者皆有，正确解码会拿高分
    else if (inRanges(cp, [[0x3040, 0x309f]])) score += 3;
    else if (inRanges(cp, [[0x30a0, 0x30ff], [0x31f0, 0x31ff]])) score += 2;
    // 半角片假名 -2：Shift_JIS 的 0xA1–0xDF 单字节区几乎必然把它造出来，
    // 而正常日文正文不会出现成片半角片假名 —— 这条是区分「真 Shift_JIS」与
    // 「GB/Big5 字节被误当 Shift_JIS」的关键。
    else if (inRanges(cp, [[0xff66, 0xff9f]])) score -= 2;
    else if (inRanges(cp, [[0xac00, 0xd7af], [0x1100, 0x11ff]])) score += 3; // 谚文
    else if (inRanges(cp, [[0x3000, 0x303f]])) score += 1; // CJK 标点
    else if (inRanges(cp, [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]])) score += 1; // 汉字（非高频）
    else score -= 0.2;
  }
  return score;
}

/**
 * 探测字节流的字符编码。
 * @param {Buffer|Uint8Array} buf
 * @returns {{encoding: string, bom: boolean, confidence: 'high'|'medium'|'low', reason: string}}
 */
export function detectEncoding(buf) {
  if (!buf.length) return { encoding: 'utf-8', bom: false, confidence: 'high', reason: '空文件' };

  if (startsWith(buf, UTF8_BOM)) {
    return { encoding: 'utf-8', bom: true, confidence: 'high', reason: 'UTF-8 BOM' };
  }
  if (startsWith(buf, UTF16LE_BOM)) {
    return { encoding: 'utf-16le', bom: true, confidence: 'high', reason: 'UTF-16LE BOM' };
  }
  if (startsWith(buf, UTF16BE_BOM)) {
    return { encoding: 'utf-16be', bom: true, confidence: 'high', reason: 'UTF-16BE BOM' };
  }

  if (isValidUtf8(buf)) {
    return { encoding: 'utf-8', bom: false, confidence: 'high', reason: '合法 UTF-8 且无 BOM' };
  }

  const u16 = utf16Heuristic(buf);
  if (u16) {
    return { encoding: u16.encoding, bom: false, confidence: u16.confidence, reason: `UTF-16 空字节模式（比例 ${u16.ratio.toFixed(2)}）` };
  }

  // legacy 双字节：按解码后的高频字命中数选最优
  let best = { encoding: 'gb18030', score: -Infinity };
  for (const enc of LEGACY_CANDIDATES) {
    let text;
    try {
      text = new TextDecoder(enc).decode(buf);
    } catch {
      continue;
    }
    const score = scoreDecoding(text);
    if (score > best.score) best = { encoding: enc, score };
  }
  return {
    encoding: best.encoding,
    bom: false,
    confidence: best.score > 0 ? 'medium' : 'low',
    reason: `非法 UTF-8，按字频打分选中（score=${best.score}）`,
  };
}

/**
 * 解码字节流为字符串。
 * @param {Buffer|Uint8Array} buf
 * @param {string|null} override 显式指定的编码（--input-encoding），跳过探测
 */
export function decodeBuffer(buf, override = null) {
  if (override) {
    let decoder;
    try {
      decoder = new TextDecoder(override);
    } catch {
      throw new Error(`不支持的编码: ${override}`, { cause: { encoding: override } });
    }
    return {
      text: decoder.decode(buf),
      encoding: override,
      bom: startsWith(buf, UTF8_BOM),
      confidence: 'explicit',
      reason: '--input-encoding 指定',
    };
  }
  const info = detectEncoding(buf);
  const text = new TextDecoder(info.encoding).decode(buf);
  return { text, ...info };
}

/**
 * 以 UTF-8 编码字符串。
 * @param {string} text
 * @param {boolean} bom 是否带 UTF-8 BOM
 */
export function encodeUtf8(text, bom = false) {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
}

// ---------------------------------------------------------------- 输出路径约定

/**
 * --suffix 场景：保留用户给的后缀，仅在末尾追加 `.md`（a.txt + .norm → a.txt.norm.md）。
 * 与 ensureMarkdownPath 的区别：后者用于 -o，会替换掉扩展名。
 */
export function appendMarkdownExt(file) {
  const ext = extname(file).toLowerCase();
  return MD_EXTS.includes(ext) ? file : `${file}.md`;
}

/** 强制输出为 Markdown 文件：扩展名非 .md/.markdown/.mdx 时替换为 .md */
export function ensureMarkdownPath(file) {
  const ext = extname(file).toLowerCase();
  if (MD_EXTS.includes(ext)) return file;
  if (ext === '') return `${file}.md`;
  return `${file.slice(0, -ext.length)}.md`;
}

/**
 * 由输入文件路径推导默认输出路径（.md 文件）：
 *   a.txt → a.md；笔记.md → 笔记.normalized.md（避免覆盖同名源文件）
 */
export function defaultOutputPath(source) {
  const dir = dirname(source);
  const base = basename(source);
  const ext = extname(base).toLowerCase();
  const stem = ext ? base.slice(0, -ext.length) : base;
  const isMd = MD_EXTS.includes(ext);
  return join(dir, `${stem}${isMd ? '.normalized' : ''}.md`);
}
