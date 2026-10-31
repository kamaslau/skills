#!/usr/bin/env node
/**
 * selftest.mjs — normalize.mjs 回归测试（基于 node:test）
 *
 * 运行：
 *   node --test --test-reporter=spec scripts/selftest.mjs   推荐，输出简洁
 *   node scripts/selftest.mjs                               直接运行，输出 TAP
 *   node scripts/selftest.mjs --only-builtin                只跑内置字表后端
 *   node scripts/selftest.mjs --only-opencc                 只跑 opencc-js 后端
 *
 * 退出码：0 全通过 / 1 有用例失败 / 2 环境或后端不可用
 *
 * 覆盖：全角数字、半角标点、小数点/时间/千分位/缩写、繁转简、日韩人名保护、
 *       Markdown 语法保护、URL/邮箱/路径保护、CLI 参数解析、不润色约束。
 */

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { parseArgs } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FallbackT2S,
  checkRuntime,
  getConverter,
  loadNames,
  main,
  normalizeText,
  parseCliArgs,
} from './normalize.mjs';
import {
  SCRIPTS,
  appendMarkdownExt,
  defaultOutputPath,
  decodeBuffer,
  detectEncoding,
  encodeUtf8,
  ensureMarkdownPath,
  leadBytesOf,
  scriptOfCodePoint,
  utf8ByteRange,
  utf8Bytes,
} from './encoding.mjs';

const SKILL_DIR = join(import.meta.dirname, '..');

const runtime = checkRuntime();
if (!runtime.ok) {
  console.error(`[error] ${runtime.message}`);
  process.exit(2);
}

const CASES = [
  // (名称, 输入, 期望输出, 额外选项)
  ['全角数字转半角', '公司成立于２０２０年，营收１２００萬元', '公司成立于2020年，营收1200万元', {}],
  ['半角标点转全角', '这是一个测试,这是一个测试.', '这是一个测试，这是一个测试。', {}],
  ['半角括号与问号', '你确定吗?请回答(是的)', '你确定吗？请回答（是的）', {}],
  ['小数点保持半角', '圆周率约为3.14,请记住', '圆周率约为3.14，请记住', {}],
  ['千分位保持半角', '营收1,000,000元', '营收1,000,000元', {}],
  ['时间冒号保持半角', '会议10:30开始;请准时', '会议10:30开始；请准时', {}],
  ['版本号保持半角', '升级到v1.2.3版本', '升级到v1.2.3版本', {}],
  ['英文散文不转换', "This is a test, isn't it?", "This is a test, isn't it?", {}],
  ['拉丁缩写句点保持', '示例见 Figure 2. etc.', '示例见 Figure 2. etc.', {}],
  ['中文后英文句点转换', '参见图 2.', '参见图 2。', {}],
  ['括号后句点识别中文语境', '這場會議(含外賓)結束了.', '这场会议（含外宾）结束了。', {}],
  ['引号后句点识别中文语境', '他說"好的"然後離開.', '他说＂好的＂然后离开。', {}],
  ['繁体转简体', '臺灣的經濟發展與資訊產業', '台湾的经济发展与资讯产业', {}],
  ['日本人名不转换', '渡辺謙與安倍晋三出席了這場電影首映', '渡辺謙与安倍晋三出席了这场电影首映', {}],
  ['日文人名的假名上下文', '宮崎駿の新作は面白い', '宮崎駿の新作は面白い', {}],
  ['韩语汉字人名不转换', '盧泰愚與金泳三舉行會談', '盧泰愚与金泳三举行会谈', {}],
  ['谚文不转换', '박근혜 전 대통령', '박근혜 전 대통령', {}],
  ['URL 不被改动', '见 https://example.com/a,b?x=1 说明', '见 https://example.com/a,b?x=1 说明', {}],
  ['邮箱不被改动', '联系 a.b@example.com 获取', '联系 a.b@example.com 获取', {}],
  ['行内代码不被改动', '使用 `print("hi")` 输出', '使用 `print("hi")` 输出', {}],
  ['行内代码中的繁体保留', '命令 `臺灣` 见文档', '命令 `臺灣` 见文档', {}],
  ['Markdown 链接不被改动', '见[文档](https://a.com/x,y)说明', '见[文档](https://a.com/x,y)说明', {}],
  ['Markdown 链接文字参与转换', '见[文檔說明](https://a.com/x)部分', '见[文档说明](https://a.com/x)部分', {}],
  ['Markdown 表格行不被改动', '| a,b | c.d |\n| --- | --- |\n| 1 | 2 |', '| a,b | c.d |\n| --- | --- |\n| 1 | 2 |', {}],
  ['Markdown 标题标记保留', '# 標題測試\n內容,測試', '# 标题测试\n内容，测试', {}],
  ['围栏代码块不被改动', '```\nlet a = 1.5;\n```\n結束', '```\nlet a = 1.5;\n```\n结束', {}],
  ['显式保护名单', '李明博與盧武鉉會面;現場熱烈', '李明博与盧武鉉会面；现场热烈', { protect: '盧武鉉' }],
  ['全角引号保留', '他说“你好”', '他说“你好”', {}],
  ['半角引号转换', '他说"你好";她点头', '他说＂你好＂；她点头', {}],
  ['波浪号范围', '第1~5页,共3页', '第1～5页，共3页', {}],
  ['不润色：词语与语序不变', '這是一段繁體中文(包含標點,數字１２３)。', '这是一段繁体中文（包含标点，数字123）。', {}],

  // —— 全角英文字母 → 半角
  ['全角字母转半角', '型号ＡＢＣ与版本ｄｅｆ,請確認', '型号ABC与版本def，请确认', {}],
  ['全角字母在保护区内保留', '代码 `ＡＢＣ` 结束', '代码 `ＡＢＣ` 结束', {}],
  ['全角字母作为中文语境', '见附录Ａ.说明', '见附录A。说明', {}],

  // —— 冗余空字符
  ['连续换行压缩', '第一段\n\n\n\n第二段', '第一段\n\n第二段', {}],
  ['空白行清空', '第一段\n   \n第二段', '第一段\n\n第二段', {}],
  ['文首空行删除', '\n\n正文', '正文', {}],
  ['文末多余换行收敛', '正文\n\n\n', '正文\n', {}],
  ['blank 模式保留行尾空格', '正文   \n结束', '正文   \n结束', {}],
  ['full 模式删除行尾空白', '正文   \n结束', '正文\n结束', { whitespace: 'full' }],
  ['Markdown frontmatter 后空行收敛', '---\ntitle: 甲\n---\n\n\n\n正文', '---\ntitle: 甲\n---\n\n正文', {}],
  ['代码块后空行收敛', '```\nlet a = 1;\n```\n\n\n\n正文', '```\nlet a = 1;\n```\n\n正文', {}],
  ['代码块内重复换行保留', '```\na\n\n\n\nb\n```\n結束', '```\na\n\n\n\nb\n```\n结束', {}],

  // —— 悬空标点
  ['逗号句号连用', '这是一句,。下一句', '这是一句。下一句', {}],
  ['分号句号连用', '内容;。结束', '内容。结束', {}],
  ['逗号分号连用', '甲,;乙', '甲；乙', {}],
  ['句末后逗号悬空', '结束了。，然后开始', '结束了。然后开始', {}],
  ['多个弱标点连用', '甲,、。乙', '甲。乙', {}],
  ['同强度标点保留', '太好了！！这是真的？！', '太好了！！这是真的？！', {}],
  ['关闭悬空标点清理', '这是一句,。下一句', '这是一句，。下一句', { doDangling: false }],
  // 悬空标点会缩短文本，必须晚于繁转简，否则保护掩码错位（真实 bug 回归）
  ['悬空标点后人名仍受保护', '型號ＡＢＣ,版本ｄｅｆ;。\n\n安倍晋三與盧泰愚出席了這場電影', '型号ABC，版本def。\n\n安倍晋三与盧泰愚出席了这场电影', {}],
];

// 需要以 Markdown 格式解析的用例（默认 --text 走 text 格式）
const MD_CASES = new Set(CASES.filter(([n]) => /Markdown|围栏|链接/.test(n)).map(([n]) => n));

const BASE_OPTS = {
  protectFrontmatter: true,
  useNames: true,
  doT2s: true,
  doPunct: true,
  doDigits: true,
  doLetters: true,
  doDangling: true,
  whitespace: 'blank',
  period: 'ideographic',
  quotes: 'fullwidth',
  symbols: false,
  protect: null,
  protectNames: [],
  protectFile: null,
};

function buildOpts(extra) {
  return { ...BASE_OPTS, ...extra, protectNames: [...(extra.protectNames ?? [])] };
}

/** 收集本次要跑的后端 */
async function resolveBackends(onlyBuiltin, onlyOpencc) {
  const backends = [];
  if (!onlyOpencc) {
    const table = new FallbackT2S(join(SKILL_DIR, 'data'));
    backends.push({ label: 'builtin-table', convert: (s) => table.convert(s) });
  }
  if (!onlyBuiltin) {
    // auto：装了 opencc-js 就跑它，没装则静默跳过
    const { convert, name } = await getConverter('auto');
    if (name === 'opencc-js') backends.push({ label: 'opencc-js', convert });
    else console.log('opencc-js 未安装，跳过（npm i opencc-js 可启用该后端）');
  }
  return backends;
}

const { values: cli } = parseArgs({
  options: {
    'only-builtin': { type: 'boolean', default: false },
    'only-opencc': { type: 'boolean', default: false },
  },
});

const backends = await resolveBackends(cli['only-builtin'], cli['only-opencc']);
if (!backends.length) {
  console.error('[error] 没有可运行的后端');
  process.exit(2);
}

const names = loadNames(null);

for (const { label, convert } of backends) {
  describe(`backend = ${label}`, () => {
    for (const [name, src, expect, extra] of CASES) {
      const opts = buildOpts({
        ...extra,
        format: MD_CASES.has(name) ? 'md' : 'text',
        names,
      });
      // 转换是同步的，先算出结果，好把统计信息写进用例名
      const { text: got, stats } = normalizeText(src, opts, convert);
      const detail = [
        `数字${stats.digits}`,
        `标点${stats.punct}`,
        ...(stats.letters ? [`字母${stats.letters}`] : []),
        ...(stats.whitespace ? [`空白${stats.whitespace}`] : []),
        ...(stats.dangling ? [`悬空${stats.dangling}`] : []),
        `繁简${stats.hanzi}`,
      ].join('/');

      test(`${name}  (${detail})`, () => {
        assert.equal(got, expect);
      });
    }
  });
}

describe('CLI 参数解析', () => {
  test('位置参数作为文件', () => {
    const o = parseCliArgs(['a.md', 'b.md']);
    assert.deepEqual(o.files, ['a.md', 'b.md']);
  });

  test('--text 与等号写法', () => {
    assert.equal(parseCliArgs(['--text', '甲']).text, '甲');
    assert.equal(parseCliArgs(['--text=-甲']).text, '-甲');
  });

  test('--no-* 取反', () => {
    const o = parseCliArgs(['--no-t2s', '--no-letters', '--no-names']);
    assert.equal(o.doT2s, false);
    assert.equal(o.doLetters, false);
    assert.equal(o.useNames, false);
    assert.equal(parseCliArgs([]).doT2s, true);
  });

  test('--protect-name 可重复', () => {
    const o = parseCliArgs(['--protect-name', '甲', '--protect-name', '乙']);
    assert.deepEqual(o.protectNames, ['甲', '乙']);
  });

  test('短选项与默认值', () => {
    const o = parseCliArgs(['-i', '-o', 'out.txt']);
    assert.equal(o.inPlace, true);
    assert.equal(o.output, 'out.txt');
    assert.equal(o.whitespace, 'blank');
    assert.equal(o.backend, 'auto');
  });

  test('-- 之后全部视为文件', () => {
    assert.deepEqual(parseCliArgs(['--', '--bogus']).files, ['--bogus']);
  });

  test('输出相关选项与默认值', () => {
    const d = parseCliArgs([]);
    assert.equal(d.bom, 'keep');
    assert.equal(d.stdout, false);
    assert.equal(d.inputEncoding, null);
    assert.equal(d.printScripts, false);
    assert.equal(parseCliArgs(['--bom', 'strip', '--stdout']).bom, 'strip');
    assert.equal(parseCliArgs(['--stdout']).stdout, true);
    assert.equal(parseCliArgs(['--input-encoding', 'gb18030']).inputEncoding, 'gb18030');
    assert.equal(parseCliArgs(['--print-scripts']).printScripts, true);
  });

  test('未知选项抛错', () => {
    assert.throws(() => parseCliArgs(['--bogus']), /Unknown option/);
  });

  test('缺取值抛错', () => {
    assert.throws(() => parseCliArgs(['--text']), /argument missing/);
  });
});

// ---------------------------------------------------------------- 编码探测

// 由 Node 侧暴力解码双字节空间反查得到（见开发记录），确保零依赖也能造出真样本
const LEGACY_SAMPLES = {
  gb18030: {
    hex: 'd6d0bbaac8cbc3f1b9b2bacdb9fab3c9c1a2d3dad2bbbec5cbc4bec5c4eaa3acd5e2cac7d2bbb8f6ceb0b4f3b5c4c0facab7cab1bfcca3acc8abb9fac8cbc3f1bbb6d0c0b9c4cee8a3acb3f6cfafbbe1d2e9b5c4b4fab1edc3c7d2bbd6c2cda8b9fdc1cbbef6d2e9a1a3',
    text: '中华人民共和国成立于一九四九年，这是一个伟大的历史时刻，全国人民欢欣鼓舞，出席会议的代表们一致通过了决议。',
  },
  big5: {
    hex: 'b36fac4fa440ac71b4fab8d5a141bcc6a672aabac2e0b4abbb50bcd0c249b2c5b8b9b342b27aa141bdd0af53a74faa60b74ec163c5e9a4a4a4e5aabaa672a7ceae74b2a7bb50a661b0cfb5fcb74aa143',
    text: '這是一段測試，數字的轉換與標點符號處理，請特別注意繁體中文的字形差異與地區詞彙。',
  },
  shift_jis: {
    hex: '8b7b8de88f7882cc90568dec82cd96ca949282a2814282b182ea82cd83658358836782c582b7814293fa967b8cea82cc95b68e9a97f182c582b78142',
    text: '宮崎駿の新作は面白い。これはテストです。日本語の文字列です。',
  },
  'euc-kr': {
    hex: 'b9dab1d9c7fd20c0fc20b4ebc5ebb7c9c0cc20c8b8c0c7bfa120c2fcbcaec7dfbdc0b4cfb4d92e20c7d1b1b9beee20b9aec0e5c0d4b4cfb4d92e',
    text: '박근혜 전 대통령이 회의에 참석했습니다. 한국어 문장입니다.',
  },
};

const utf16be = (s) => Buffer.from(Buffer.from(s, 'utf16le')).swap16();
const bufOf = (hex) => Buffer.from(hex, 'hex');

describe('输入编码探测', () => {
  for (const [enc, { hex, text }] of Object.entries(LEGACY_SAMPLES)) {
    test(`${enc} 字节流被正确识别并解码`, () => {
      const buf = bufOf(hex);
      assert.equal(detectEncoding(buf).encoding, enc);
      assert.equal(decodeBuffer(buf).text, text);
    });
  }

  test('UTF-8（含 BOM）', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('標題：測試', 'utf8')]);
    const d = detectEncoding(buf);
    assert.equal(d.encoding, 'utf-8');
    assert.equal(d.bom, true);
    assert.equal(d.confidence, 'high');
    assert.equal(decodeBuffer(buf).text, '標題：測試');
  });

  test('UTF-16LE / BE（BOM 与无 BOM）', () => {
    for (const [enc, encBuf] of [
      ['utf-16le', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('測試', 'utf16le')])],
      ['utf-16be', Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be('測試')])],
    ]) {
      assert.equal(detectEncoding(encBuf).encoding, enc);
    }
    // 无 BOM 时靠「ASCII 字符必有一半为 0x00」判别
    assert.equal(detectEncoding(Buffer.from('Report 2024 測試', 'utf16le')).encoding, 'utf-16le');
    assert.equal(detectEncoding(utf16be('Report 2024 測試')).encoding, 'utf-16be');
  });

  test('纯 ASCII 与空文件', () => {
    assert.equal(detectEncoding(Buffer.from('hello', 'utf8')).encoding, 'utf-8');
    assert.equal(detectEncoding(Buffer.alloc(0)).encoding, 'utf-8');
  });

  test('--input-encoding 强制覆盖探测', () => {
    const buf = bufOf(LEGACY_SAMPLES.gb18030.hex);
    assert.equal(detectEncoding(buf).encoding, 'gb18030');
    assert.equal(decodeBuffer(buf, 'big5').encoding, 'big5');
    assert.notEqual(decodeBuffer(buf, 'big5').text, LEGACY_SAMPLES.gb18030.text);
  });

  test('不支持的编码抛错', () => {
    assert.throws(() => decodeBuffer(bufOf('00'), 'no-such-encoding'), /不支持的编码/);
  });
});

// ---------------------------------------------------------------- UTF-8 区间判定

describe('UTF-8 字节区间 ↔ 码点区间', () => {
  test('已知字符的字节序列', () => {
    assert.deepEqual(utf8Bytes(0x4e00), [0xe4, 0xb8, 0x80]); // 一
    assert.deepEqual(utf8Bytes(0x9fff), [0xe9, 0xbf, 0xbf]);
    assert.deepEqual(utf8Bytes(0x3040), [0xe3, 0x81, 0x80]); // あ 区块起点
    assert.deepEqual(utf8Bytes(0xac00), [0xea, 0xb0, 0x80]); // 가
    assert.deepEqual(utf8Bytes(0xff01), [0xef, 0xbc, 0x81]); // ！
  });

  test('lead byte 粗分（端点区间）', () => {
    assert.deepEqual(leadBytesOf('cjk-basic'), [0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9]);
    assert.deepEqual(leadBytesOf('hangul'), [0xea, 0xeb, 0xec, 0xed]);
    assert.deepEqual(leadBytesOf('fullwidth'), [0xef]);
    // 扩展 A 与基本汉字在 0xE4 上重叠 → 单看 lead byte 无法区分，必须看后续字节
    assert.ok(leadBytesOf('cjk-ext-a').includes(0xe4));
    assert.ok(leadBytesOf('cjk-basic').includes(0xe4));
  });

  test('书写系统归属判定', () => {
    assert.equal(scriptOfCodePoint('汉'.codePointAt(0)), 'cjk-basic');
    assert.equal(scriptOfCodePoint('あ'.codePointAt(0)), 'kana');
    assert.equal(scriptOfCodePoint('가'.codePointAt(0)), 'hangul');
    assert.equal(scriptOfCodePoint('Ａ'.codePointAt(0)), 'fullwidth');
    assert.equal(scriptOfCodePoint('A'.codePointAt(0)), 'ascii');
    assert.equal(scriptOfCodePoint('Ω'.codePointAt(0)), 'greek-cyrillic');
    assert.equal(scriptOfCodePoint(0x10ffff), null);
  });

  // UTF-8 是保序前缀码：字节序比较 == 码点序比较。
  // 这正是「按 UTF-8 字节区间判定语种」与「按码点区间判定」等价的依据。
  test('字节序与码点序一致（区间判定等价性）', () => {
    const cps = [];
    for (const s of SCRIPTS) {
      for (const [a, b] of s.ranges) cps.push(a, b, Math.floor((a + b) / 2));
    }
    cps.push(0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff);
    const sorted = [...new Set(cps)].sort((x, y) => x - y);
    for (let i = 0; i < sorted.length - 1; i++) {
      const cmp = Buffer.compare(Buffer.from(utf8Bytes(sorted[i])), Buffer.from(utf8Bytes(sorted[i + 1])));
      assert.ok(cmp < 0, `U+${sorted[i].toString(16)} 应小于 U+${sorted[i + 1].toString(16)}`);
    }
  });

  test('区间端点可往返（码点区间 → 字节区间 → 解码回同一码点）', () => {
    for (const s of SCRIPTS) {
      for (const range of s.ranges) {
        const { first, last } = utf8ByteRange(range);
        const dec = new TextDecoder('utf-8');
        assert.equal(dec.decode(Buffer.from(first)).codePointAt(0), range[0]);
        assert.equal(dec.decode(Buffer.from(last)).codePointAt(0), range[1]);
      }
    }
  });
});

// ---------------------------------------------------------------- 输出约定

describe('输出：UTF-8 + Markdown', () => {
  test('输出路径强制 .md', () => {
    assert.equal(ensureMarkdownPath('a.md'), 'a.md');
    assert.equal(ensureMarkdownPath('a.markdown'), 'a.markdown');
    assert.equal(ensureMarkdownPath('a.txt'), 'a.md');
    assert.equal(ensureMarkdownPath('a.TXT'), 'a.md');
    assert.equal(ensureMarkdownPath('out'), 'out.md');
    assert.equal(ensureMarkdownPath('dir/a.txt'), 'dir/a.md');
  });

  test('默认输出路径不覆盖同名源文件', () => {
    assert.equal(defaultOutputPath('a.txt'), 'a.md');
    assert.equal(defaultOutputPath('dir/a.txt'), join('dir', 'a.md'));
    assert.equal(defaultOutputPath('a.md'), 'a.normalized.md');
    assert.equal(defaultOutputPath('笔记.md'), '笔记.normalized.md');
  });

  test('--suffix 场景保留用户后缀再补 .md', () => {
    assert.equal(appendMarkdownExt('a.txt.norm'), 'a.txt.norm.md');
    assert.equal(appendMarkdownExt('a.txt.md'), 'a.txt.md');
    assert.equal(appendMarkdownExt('a'), 'a.md');
  });

  test('encodeUtf8 的 BOM 控制', () => {
    assert.deepEqual([...encodeUtf8('中')], [0xe4, 0xb8, 0xad]);
    assert.deepEqual([...encodeUtf8('中', true)], [0xef, 0xbb, 0xbf, 0xe4, 0xb8, 0xad]);
  });
});

// ---------------------------------------------------------------- 端到端（文件）

describe('端到端：非 UTF-8 输入 → UTF-8 Markdown 输出', () => {
  // 注意：describe 的回调是同步执行的（用于登记子测试），
  // 临时目录必须在 before/after 钩子里建删，不能写在 describe 体里，
  // 否则 try/finally 会在子测试跑到之前就把目录删掉。
  let dir;
  let src;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tnz-'));
    src = join(dir, 'src.txt');
    writeFileSync(src, bufOf(LEGACY_SAMPLES.gb18030.hex));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('GB18030 输入转为 UTF-8 的 .md', async () => {
    const out = join(dir, 'out'); // 无扩展名 → 自动补 .md
    const code = await main([src, '-o', out, '--report']);
    assert.equal(code, 0);
    const produced = join(dir, 'out.md');
    const bytes = readFileSync(produced);
    assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), '默认不带 BOM');
    assert.equal(bytes.toString('utf8'), `${LEGACY_SAMPLES.gb18030.text}\n`); // 输出补行尾换行
    // 二次运行幂等
    const code2 = await main([produced, '--check']);
    assert.equal(code2, 0);
  });

  test('默认输出模式写出 a.txt → a.md', async () => {
    const code = await main([src]);
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, 'src.md'), 'utf8'), `${LEGACY_SAMPLES.gb18030.text}\n`);
  });

  test('--bom add / strip', async () => {
    const outAdd = join(dir, 'bom-add.md');
    await main([src, '-o', outAdd, '--bom', 'add']);
    assert.ok(readFileSync(outAdd).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));

    const bomSrc = join(dir, 'bom-src.md');
    writeFileSync(
      bomSrc,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('測試\r\n', 'utf8')]),
    );
    await main([bomSrc, '--in-place', '--bom', 'keep']);
    const kept = readFileSync(bomSrc);
    assert.ok(kept.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'keep 保留 BOM');
    assert.ok(kept.includes(Buffer.from('\r\n')), 'CRLF 保留');
    assert.equal(kept.toString('utf8'), '﻿测试\r\n');

    await main([bomSrc, '--in-place', '--bom', 'strip']);
    assert.ok(!readFileSync(bomSrc).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  });
});
