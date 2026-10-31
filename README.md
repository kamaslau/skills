# skills

Agent Skills 集合。每个技能是 `skills/<name>/SKILL.md` 下的一个自包含目录。

## 安装

```bash
npx skills add kamaslau/skills                              # 交互式选择
npx skills add kamaslau/skills --skill text-normalize-zh-hans  # 安装指定技能
npx skills add kamaslau/skills --list                       # 只列出可用技能
```

也可直接指向单个技能目录：

```bash
npx skills add https://github.com/kamaslau/skills/tree/main/skills/text-normalize-zh-hans
```

## 技能列表

| 技能 | 说明 | 安装 |
| --- | --- | --- |
| [`text-normalize-zh-hans`](skills/text-normalize-zh-hans/) | 中文文本字形级规范化：全角阿拉伯数字转半角、半角标点转全角、非简体中文字符转简体（日语/韩语/朝鲜语人名例外）。不润色、不改写语法。 | `npx skills add kamaslau/skills --skill text-normalize-zh-hans` |

## 仓库结构

```
skills/<skill-name>/
├── SKILL.md       # 必需：name + description 前置元数据与指令
├── scripts/       # 可选：可执行代码
├── references/    # 可选：按需加载的文档
└── data/          # 可选：技能自带的数据表
```

该布局与 [`npx skills`](https://github.com/vercel-labs/skills) 的仓库扫描规则一致：安装器会扫描仓库根（根含 SKILL.md 时）、`skills/` 及约 50 个宿主目录（`.claude/skills/`、`.agents/skills/` 等）。请勿将技能放进未被扫描的目录（如 `.workbuddy/skills/`），否则只能依赖不可靠的递归兜底发现。

## 许可

MIT，见 [LICENSE](LICENSE)。
