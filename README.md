# skills

A collection of Agent Skills. Each skill is a self-contained directory at `skills/<name>/SKILL.md`.

## License

MIT. See [LICENSE](LICENSE).

## Install

```bash
npx skills add kamaslau/skills                                 # interactive picker
npx skills add kamaslau/skills --skill text-normalize-zh-hans  # install a specific skill
npx skills add kamaslau/skills --list                          # list available skills only

# Or if you prefer PNPM
pnx skills add kamaslau/skills
pnx skills add kamaslau/skills --skill text-normalize-zh-hans
pnx skills add kamaslau/skills --list
```

You can also point directly at a single skill directory:

```bash
npx skills add https://github.com/kamaslau/skills/tree/main/skills/text-normalize-zh-hans
```

## Skills

| Skill                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Install                                                         |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`text-normalize-zh-hans`](skills/text-normalize-zh-hans/) | Glyph-level normalization for Chinese text: converts full-width Arabic digits and Latin letters to half-width, half-width punctuation to full-width (in Chinese contexts), and non-Simplified Chinese characters to Simplified Chinese (Japanese/Korean personal names are exempt). Also removes redundant whitespace and dangling punctuation. No rewriting, no grammar changes. Input encoding is auto-detected among UTF-8/UTF-16/GB18030/Big5/EUC-KR/Shift_JIS; **output is always a UTF-8 Markdown file**. Requires Node.js >= 22 (the lowest LTS listed officially). No npm dependencies. | `npx skills add kamaslau/skills --skill text-normalize-zh-hans` |

## Repository layout

```
skills/<skill-name>/
├── SKILL.md       # required: name + description frontmatter and instructions
├── scripts/       # optional: executable code
├── references/    # optional: documentation loaded on demand
└── data/          # optional: lookup tables bundled with the skill
```

This layout matches the repository scanning rules of [`npx skills`](https://github.com/vercel-labs/skills): the installer scans the repository root (when the root itself contains a `SKILL.md`), `skills/`, and about 50 host directories (`.claude/skills/`, `.agents/skills/`, and so on). Do not place skills in directories that are not scanned (for example `.workbuddy/skills/`), or discovery will fall back to unreliable recursive search.
