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
import { describe, test } from 'node:test';
import { parseArgs } from 'node:util';
import { join } from 'node:path';

import {
  FallbackT2S,
  checkRuntime,
  getConverter,
  loadNames,
  normalizeText,
  parseCliArgs,
} from './normalize.mjs';

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

  test('未知选项抛错', () => {
    assert.throws(() => parseCliArgs(['--bogus']), /Unknown option/);
  });

  test('缺取值抛错', () => {
    assert.throws(() => parseCliArgs(['--text']), /argument missing/);
  });
});
