---
name: text-normalize-zh-hans
repo: https://github.com/kamaslau/skills
description: "中文文本字形级规范化：全角阿拉伯数字转半角、半角标点转全角、非简体中文字符转简体（日语/韩语/朝鲜语人名例外），严禁润色或改写语法。当用户提到「文字处理」「文本规范化」「排版清理」「繁转简」「全角半角」「标点全角化」「数字半角化」，或粘贴一段中英混排、繁简混排的文本要求处理时，应使用本技能。适用于 .txt/.md 等文件与对话中的文本片段。"
allowed-tools: Bash, Read, Edit
version: 2.1.0
agent_created: true
---

# 中文文本规范化（text-normalize-zh-hans）

对中文文本执行**纯字形级**替换，由 `scripts/normalize.mjs`（Node.js ESM，零依赖）确定性完成。

## 四条红线（任何情况下不得违反）

1. **不润色、不改写**：不增删词句、不改语序、不改语法、不做文风优化、不替换成「更通顺」的表达。
2. **全角字符 → 半角**：阿拉伯数字 `０１２３４５６７８９` → `0123456789`；英文字母 `ＡＢＣａｂｃ` → `ABCabc`。
3. **半角标点符号 → 全角**：`, ; : ! ? ( ) [ ] { } " ' < > ~ | .` 在中文语境下转全角；英文语境、小数点、时间、千分位、版本号、缩写、运算符一律保留半角。
4. **非简体中文字符 → 简体**：繁体/异体转简体；**日语、韩语、朝鲜语人名例外**，保持原字形。
5. **清理冗余空字符**：连续空行收敛、空白行清空、文首/文末空行收敛。
6. **清理悬空标点**：`，。` → `。`、`，；` → `；`、`。，` → `。` 等连用标点收敛为其最强者。

第 5、6 条只删除**冗余**的字符，不改动任何实义内容。

脚本只做字形映射，不改语义。若 `--report` 显示繁简改动处数异常偏大，应抽查「繁简示例」确认没有发生词语替换。

## 运行环境

仅需 **Node.js >= 18**（用到 `String.prototype.matchAll`、正则后行断言、RegExp `/d` indices）。无 npm 依赖、可离线运行。

## 工作流

### Step 1：估算改动规模（只读，不改文件）

```bash
node scripts/normalize.mjs <文件> --check --report
```

退出码 `0` 表示无需改动，`1` 表示存在可改动项。先看 `数字/标点/繁简` 三项计数是否与预期相符，再决定是否执行。

### Step 2：通读文本，补充日韩人名保护名单

脚本内置 `data/names_ja_ko.txt`（常见日韩人名），并自动保护两类片段：

- 汉字紧邻**假名或谚文**（如 `宮崎駿の`、`박근혜 前`）
- 含**日文/韩文独有字形**（辺 沢 辻 桜 気 発 県 駅 々 畓 乭 等）

内置表无法覆盖冷僻人名，因此需通读一遍文本，把识别出的日语/韩语/朝鲜语人名用 `--protect` 传入：

```bash
node scripts/normalize.mjs <文件> --protect "鳩山由紀夫,盧武鉉" --in-place
```

也可用 `--protect-name`（可重复）或 `--protect-file`（一行一个）。长期复用的人名建议直接追加进 `data/names_ja_ko.txt`。

### Step 3：执行转换

```bash
node scripts/normalize.mjs <文件> --in-place --report      # 覆盖原文件
node scripts/normalize.mjs <文件> --suffix .norm --report  # 输出 <文件>.norm，保留原件
node scripts/normalize.mjs --text "這是一段測試,數字１２３"   # 处理对话中的文本片段
node scripts/normalize.mjs a.md b.md --in-place            # 批量（必须显式指定写回方式）
```

### Step 4：复核（必做）

```bash
node scripts/normalize.mjs <文件> --check --diff
```

复核要点：改动是否仅限「数字/标点/繁简字形」三类；是否存在整词被替换成另一个词（说明命中转换词表，需用 `--protect` 保护该词后重跑）。

## 常用参数

| 参数 | 作用 |
| --- | --- |
| `--text` / `--stdin` / 文件路径 | 输入方式，三选一 |
| `--in-place` / `--suffix` / `--output` | 写回方式；均不给则输出到 stdout |
| `--check` | 只报告不改动，有改动时退出码 1 |
| `--report` / `--report-json` / `--diff` | 统计与逐行差异（输出到 stderr） |
| `--protect` / `--protect-name` / `--protect-file` | 追加保护名单（日韩人名） |
| `--period ideographic\|fullwidth\|keep` | 句点策略，默认 `ideographic`（`.` → `。`） |
| `--quotes fullwidth\|curly\|keep` | 引号策略，默认 `fullwidth`（`"` → `＂`）；`curly` 输出 `“”` |
| `--symbols` | 额外转换 `@ # $ % & * + = / \ ^ _` 等半角符号（默认关闭） |
| `--no-letters` | 关闭全角英文字母转半角（默认开启） |
| `--whitespace blank\|full\|off` | 冗余空字符清理，默认 `blank`；`full` 额外删行尾空白 |
| `--no-dangling` | 关闭悬空标点清理（默认开启） |
| `--no-t2s` / `--no-punct` / `--no-digits` | 单独关闭某一类转换 |
| `--format md\|text\|auto` | 强制输入格式，默认按扩展名判断 |
| `--convert-frontmatter` | 让 YAML frontmatter 也参与转换（默认保护） |
| `--no-names` / `--names-file` | 关闭人名保护 / 指定自定义人名表 |
| `--backend auto\|builtin\|opencc` | 繁转简后端，默认 `auto` |

## 后端与依赖

零依赖即可运行：未安装 `opencc-js` 时使用内置字表 `data/TSCharacters.txt` + `data/TSPhrases.txt`（源自 OpenCC，见 `data/ATTRIBUTION.md`），词组最长匹配，离线可用。

`opencc-js` 为**可选增强**（词组级转换、速度更快）。若安装，`--backend auto` 会自动优先使用它：

```bash
npm i opencc-js                  # 可选；装在本技能目录或其任一上级目录
node scripts/normalize.mjs <文件> --backend builtin   # 强制用内置字表
```

`--report` 的 `backend=` 字段会显示本次实际使用的后端，便于审计。

```bash
node scripts/selftest.mjs              # 回归测试（内置字表 + opencc-js 各跑一遍）
node scripts/selftest.mjs --only-builtin
node scripts/selftest.mjs --only-opencc
```

## 冗余空字符清理（`--whitespace`）

| 模式 | 行为 |
| --- | --- |
| `blank`（默认） | 连续 3+ 换行压到 2（至多一个空行）；空白行清空；文首空行删除；文末连续换行收敛为一个 |
| `full` | 在 `blank` 之上再删除每行行尾空白（含全角空格） |
| `off` | 完全不动 |

默认**不动行尾空格**，因为 Markdown 用行尾两空格表示硬换行，删掉会改渲染；确需清理时用 `--whitespace full`。代码块内的换行一律保留。

## 悬空标点清理（`--no-dangling` 关闭）

连续的全角标点串收敛为其中**强度最高**者（`、`1 < `，`2 < `；`3 < `：`4 < `。`5 < `！`＝`？`6）：

- `，。` → `。`、`；。` → `。`、`，；` → `；`、`。，` → `。`、`，、。` → `。`
- **同强度不合并**：`！！`、`？！` 原样保留——重复常是作者有意的强调，脚本不做判断。

## 已知边界

- **代码块、行内代码、URL、邮箱、文件路径、HTML 标签、Markdown 表格行**默认整体跳过，其中的繁体与半角标点会被保留——刻意为之，避免破坏语法。
- Markdown 链接/图片只保护定界符与 URL，**链接文字照常转换**。
- 英文散文中的半角标点（如 `This is a test, isn't it?`）不转换，因为左右均无中文上下文。
- 全角英文字母属于中文语境信号：`見附錄Ａ.` 会转成 `見附錄A。`（附录 A 后的句点按中文处理）。
- 悬空标点只处理**全角**标点，英文的 `?!`、`...` 不受影响。
- 全程按 UTF-16 码元索引处理；本工具关心的字符均在 BMP，行为与按码点处理一致。
- 完整映射表与判定细节见 `references/rules.md`。
