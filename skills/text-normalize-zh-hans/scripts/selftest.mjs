#!/usr/bin/env node
/**
 * selftest.mjs — normalize.mjs 回归测试
 *
 * 运行：
 *   node scripts/selftest.mjs              内置字表 + opencc-js（若已安装）双后端
 *   node scripts/selftest.mjs --only-builtin  只跑内置字表后端
 *   node scripts/selftest.mjs --only-opencc   只跑 opencc-js 后端
 *
 * 覆盖：全角数字、半角标点、小数点/时间/千分位/缩写、繁转简、日韩人名保护、
 *       Markdown 语法保护、URL/邮箱/路径保护、不润色约束。
 */

import { FallbackT2S, getConverter, loadNames, normalizeText } from './normalize.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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
];

// 需要以 Markdown 格式解析的用例（默认 --text 走 text 格式）
const MD_CASES = new Set(CASES.filter(([n]) => /Markdown|围栏|链接/.test(n)).map(([n]) => n));

const BASE_OPTS = {
  protectFrontmatter: true,
  useNames: true,
  doT2s: true,
  doPunct: true,
  doDigits: true,
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

async function runSuite(label, convert) {
  const names = loadNames(null);
  let failures = 0;
  for (const [name, src, expect, extra] of CASES) {
    const opts = buildOpts({
      ...extra,
      format: MD_CASES.has(name) ? 'md' : 'text',
      names,
    });
    const { text: got, stats } = normalizeText(src, opts, convert);
    if (got !== expect) {
      failures += 1;
      console.log(`[FAIL] ${name}`);
      console.log(`       输入: ${JSON.stringify(src)}`);
      console.log(`       期望: ${JSON.stringify(expect)}`);
      console.log(`       实际: ${JSON.stringify(got)}`);
    } else {
      console.log(
        `[ ok ] ${name}  (数字${stats.digits}/标点${stats.punct}/繁简${stats.hanzi})`,
      );
    }
  }
  console.log(`\n[${label}] 结果: ${CASES.length - failures}/${CASES.length} 通过`);
  return failures;
}

async function main() {
  const argv = process.argv.slice(2);
  const onlyBuiltin = argv.includes('--only-builtin');
  const onlyOpencc = argv.includes('--only-opencc');

  let failures = 0;
  let suites = 0;

  if (!onlyOpencc) {
    const table = new FallbackT2S(join(SKILL_DIR, 'data'));
    console.log('backend = builtin-table\n');
    failures += await runSuite('builtin-table', (s) => table.convert(s));
    suites += 1;
    console.log('');
  }

  if (!onlyBuiltin) {
    // 用 auto：opencc-js 装了就跑它，没装就静默回退（此处据此跳过）
    const { convert, name } = await getConverter('auto');
    if (name !== 'opencc-js') {
      console.log('backend = opencc-js 未安装，跳过（可 npm i opencc-js 以启用该后端）');
    } else {
      console.log('backend = opencc-js\n');
      failures += await runSuite('opencc-js', convert);
      suites += 1;
    }
  }

  if (suites === 0) {
    console.log('[error] 没有可运行的后端');
    return 2;
  }
  return failures ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
