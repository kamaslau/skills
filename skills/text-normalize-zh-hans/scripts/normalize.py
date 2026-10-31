#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
normalize.py — 中文文本「字形级」规范化工具

设计红线（任何改动都不得违反）：
  1. 只做字形级替换：不增删词句、不改语序、不改语法、不做润色。
  2. 全角阿拉伯数字（U+FF10–U+FF19）→ 半角阿拉伯数字（0–9）。
  3. 半角标点符号 → 全角标点符号（上下文感知，避免破坏小数点/时间/代码/URL/缩写）。
  4. 非简体中文字符 → 简体中文字符（日语、韩语、朝鲜语人名除外）。

用法见 `--help`，或直接以文件/文本为输入运行。
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
from pathlib import Path

try:  # Windows 控制台默认 GBK，强制 UTF-8 输出
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DATA_DIR = SKILL_DIR / "data"

# ---------------------------------------------------------------- 字符分类

# 汉字 / 假名 / 谚文 / 中日韩标点 / 全角字符，统一视为「CJK 上下文」
_CJK_RANGES = (
    (0x3001, 0x303F),  # CJK 标点（不含 U+3000 全角空格）
    (0x3040, 0x30FF),  # 假名
    (0x31F0, 0x31FF),  # 片假名扩展
    (0x3400, 0x4DBF),  # 扩展 A
    (0x4E00, 0x9FFF),  # 基本汉字
    (0xAC00, 0xD7AF),  # 谚文音节
    (0xF900, 0xFAFF),  # 兼容汉字
    (0xFE30, 0xFE4F),  # CJK 兼容形式
    (0xFF01, 0xFFEF),  # 全角/半角形式
)

_KANA_RANGES = ((0x3040, 0x30FF), (0x31F0, 0x31FF), (0xFF66, 0xFF9F), (0x30FB, 0x30FC))
_HANGUL_RANGES = ((0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F))

_HAN_RANGES = (
    (0x2E80, 0x2EFF),
    (0x2F00, 0x2FDF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
)

# 高频中文虚词/常用字：日文独有字形向外扩展人名窗口时遇此集合即停止，
# 避免把整句中文误判为人名。
STOP_HAN = set(
    "的了是在有和與会會這这那我們个上下前後时年月日出說话作為对從到過还就要能把被给所很再又也都才更最不沒于其之以而及或則但因使可請许多大小中新舊對於关于并且或者已经將讓向此外之間由該等發現進行問題部分場电影首映"
)

# 日文独有字形：新字体 / 国字 / 叠字符号。出现即判定为非简体中文语境。
JAPANESE_ONLY = set(
    "辻込畑峠塚辿凪薮篭桜沢辺広転実気発営関円恵圧価仏駅県総変単戦図続読働専楽対々〆ヶヵ"
)
# 韩文独有汉字（国字）
KOREAN_ONLY = set("畓乭巭")

FULLWIDTH_DIGITS = {chr(0xFF10 + i): str(i) for i in range(10)}

PUNCT_MAP = {
    ",": "，",
    ";": "；",
    ":": "：",
    "!": "！",
    "?": "？",
    "(": "（",
    ")": "）",
    "[": "［",
    "]": "］",
    "{": "｛",
    "}": "｝",
    "<": "＜",
    ">": "＞",
    "~": "～",
    "|": "｜",
    '"': "＂",
    "'": "＇",
}

SYMBOL_MAP = {
    "@": "＠",
    "#": "＃",
    "$": "＄",
    "%": "％",
    "&": "＆",
    "*": "＊",
    "+": "＋",
    "=": "＝",
    "/": "／",
    "\\": "＼",
    "^": "＾",
    "_": "＿",
    "`": "｀",
}

CURLY_OPEN = {'"': "“", "'": "‘"}
CURLY_CLOSE = {'"': "”", "'": "’"}

# 常见拉丁缩写：句点属于缩写本身，不转换
ABBREVS = {
    "etc", "eg", "ie", "vs", "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
    "inc", "ltd", "co", "corp", "dept", "univ", "approx", "cf", "etal",
    "fig", "figs", "vol", "vols", "pp", "no", "nos", "op", "ed", "eds",
    "am", "pm", "us", "uk", "usa", "eu", "un", "gdp", "ceo", "cto",
    "etc.", "e.g.", "i.e.", "vs.", "mr.", "mrs.", "dr.", "prof.", "inc.",
    "ltd.", "co.", "corp.", "fig.", "no.", "vol.", "pp.", "u.s.", "u.k.",
    "a.m.", "p.m.", "et al.",
}


def _in_ranges(ch: str, ranges) -> bool:
    o = ord(ch)
    return any(a <= o <= b for a, b in ranges)


def is_cjk(ch: str) -> bool:
    return bool(ch) and _in_ranges(ch, _CJK_RANGES)


def is_kana(ch: str) -> bool:
    return bool(ch) and (_in_ranges(ch, _KANA_RANGES) or ch in "々〆ヶヵ")


def is_hangul(ch: str) -> bool:
    return bool(ch) and _in_ranges(ch, _HANGUL_RANGES)


def is_han(ch: str) -> bool:
    return bool(ch) and _in_ranges(ch, _HAN_RANGES)


def is_cjk_token_char(ch: str) -> bool:
    """构成一个连续 CJK 片段的字符。"""
    return ch not in " \t\r\n　" and is_cjk(ch)


# ---------------------------------------------------------------- 繁转简后端


class FallbackT2S:
    """无 PyPI 依赖时的兜底转换器：OpenCC 单字表 + 词组表，最长匹配优先。"""

    def __init__(self, data_dir: Path):
        self.chars: dict[str, str] = {}
        self.phrases: dict[str, str] = {}
        for name, target in (("TSCharacters.txt", self.chars), ("TSPhrases.txt", self.phrases)):
            path = data_dir / name
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split("\t")
                if len(parts) < 2:
                    continue
                dst = parts[1].split()
                if dst:
                    target[parts[0]] = dst[0]
        self.maxlen = max((len(k) for k in self.phrases), default=1)

    def convert(self, text: str) -> str:
        out = []
        i, n = 0, len(text)
        while i < n:
            hit = False
            if self.phrases:
                for length in range(min(self.maxlen, n - i), 1, -1):
                    cand = text[i : i + length]
                    if cand in self.phrases:
                        out.append(self.phrases[cand])
                        i += length
                        hit = True
                        break
            if hit:
                continue
            ch = text[i]
            out.append(self.chars.get(ch, ch))
            i += 1
        return "".join(out)


def get_converter(auto_install: bool):
    """返回 (convert_fn, backend_name)。OpenCC 优先，内置表兜底。"""
    try:
        from opencc import OpenCC  # type: ignore

        cc = OpenCC("t2s")
        cc.convert("測試")
        return cc.convert, "opencc"
    except Exception:
        pass
    if auto_install:
        try:
            import subprocess

            subprocess.run(
                [sys.executable, "-m", "pip", "install", "-q", "opencc-python-reimplemented"],
                check=True,
                capture_output=True,
                timeout=180,
            )
            from opencc import OpenCC  # type: ignore

            cc = OpenCC("t2s")
            cc.convert("測試")
            return cc.convert, "opencc(auto-installed)"
        except Exception:
            pass
    return FallbackT2S(DATA_DIR).convert, "builtin-table"


# ---------------------------------------------------------------- 保护区域


def _merge(spans):
    if not spans:
        return []
    spans = sorted(spans)
    merged = [list(spans[0])]
    for s, e in spans[1:]:
        if s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e > s]


_RE_MD_TABLE_SEP = re.compile(
    r"^\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$"
)


def structural_spans(text: str, fmt: str, protect_frontmatter: bool = True):
    """代码块、Markdown 语法结构、URL/邮箱/路径等「永不改动」的区域。"""
    spans = []
    md = fmt in ("md", "auto")

    # YAML frontmatter（默认保护：元数据中的半角写法通常是刻意保留的）
    if md and protect_frontmatter and (
        text.startswith("---\n") or text.startswith("---\r\n")
    ):
        m = re.search(r"\r?\n---[ \t]*(?:\r?\n|$)", text[3:])
        if m:
            spans.append((0, 3 + m.end()))

    # 逐行：围栏代码块 / 表格 / 标题 / 列表 / 引用标记
    pos = 0
    in_fence = False
    fence_tok = None
    for line in text.split("\n"):
        start, end = pos, pos + len(line)
        stripped = line.strip()
        fm = re.match(r"^[ \t]*(```|~~~)", line)
        if in_fence:
            spans.append((start, end))
            if fm and fm.group(1) == fence_tok:
                in_fence, fence_tok = False, None
        elif fm:
            in_fence, fence_tok = True, fm.group(1)
            spans.append((start, end))
        elif md:
            if stripped.startswith("|"):
                spans.append((start, end))
            elif "-" in stripped and _RE_MD_TABLE_SEP.match(stripped):
                spans.append((start, end))
            elif re.match(r"^={3,}[ \t]*$", stripped) or re.match(
                r"^(\*{3,}|_{3,})[ \t]*$", stripped
            ):
                spans.append((start, end))
            else:
                for pat in (
                    r"^[ \t]*(#{1,6})(?=[ \t]|$)",
                    r"^[ \t]*([-*+]|\d+[.)])(?=[ \t]|$)",
                    r"^[ \t]*(>)(?=[ \t]|$)",
                ):
                    m = re.match(pat, line)
                    if m:
                        spans.append((start + m.start(1), start + m.end(1)))
        pos = end + 1

    # 行内结构
    inline = [
        r"`[^`\n]*`",                                    # 行内代码
        r"<!--[\s\S]*?-->",                              # HTML 注释
        r"</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*?)?/?>",     # HTML 标签
        r"(?:https?|ftp)://[^\s<>\"'）】]+",                # URL
        r"(?<![\w.])www\.[^\s<>\"'）】]+",
        r"[\w.+-]+@[\w-]+\.[\w.-]+",                     # 邮箱
        r"[A-Za-z]:\\[^\s<>\"'）】]*",                     # Windows 路径
        r"(?<![\w])/(?:usr|home|etc|var|tmp|opt|mnt|Users|Applications|Library)/"
        r"[^\s<>\"'）】]*",
        r"\$\$[\s\S]+?\$\$",                             # 块级公式
        r"(?<!\$)\$(?![\s$])([^$\n]+?)(?<![\s])\$(?!\$)",   # 行内公式
    ]
    if md:
        inline += [
            r"\[\^[^\]\n]*\]",                           # 脚注引用
            r"\{[^{}\n]*\}",                             # {: #id .class} 属性
        ]
    for pat in inline:
        for m in re.finditer(pat, text):
            spans.append(m.span())

    # 链接/图片：仅保护定界符与 URL，链接文字仍参与转换
    if md:
        for m in re.finditer(r"(!?)\[([^\]\n]*)\]\(([^)\n]*)\)", text):
            spans.append((m.start(2) - 1, m.start(2)))   # [
            spans.append((m.end(2), m.end(2) + 1))       # ]
            spans.append((m.end(2) + 1, m.end(3) + 1))   # (url)

    return _merge(spans)


def load_names(path: Path | None) -> set[str]:
    names: set[str] = set()
    p = path or (DATA_DIR / "names_ja_ko.txt")
    if not p.exists():
        return names
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            names.add(line)
    return names


def substring_spans(text: str, names) -> list[tuple[int, int]]:
    """名单子串匹配：名单项可直接命中长句中的人名。"""
    spans: list[tuple[int, int]] = []
    for name in names:
        if len(name) < 2:
            continue
        start = 0
        while True:
            idx = text.find(name, start)
            if idx < 0:
                break
            spans.append((idx, idx + len(name)))
            start = idx + 1
    return _merge(spans)


def _name_spans_in_run(run: str, base: int) -> list[tuple[int, int]]:
    """在单个连续 CJK 片段内部定位「日语/韩语/朝鲜语」人名。"""
    spans: list[tuple[int, int]] = []
    length = len(run)

    # B. 汉字子片段紧邻假名或谚文（如「宮崎駿の」「박근혜 前」）
    k = 0
    while k < length:
        if is_han(run[k]):
            s = k
            while k < length and is_han(run[k]):
                k += 1
            e = k
            before = run[s - 1] if s > 0 else ""
            after = run[e] if e < length else ""
            if is_kana(before) or is_hangul(before) or is_kana(after) or is_hangul(after):
                spans.append((base + s, base + e))
        else:
            k += 1

    # C. 日文/韩文独有字形：以该字为中心向两侧最多各扩 2 字，遇高频虚词停止
    for k, ch in enumerate(run):
        if ch in JAPANESE_ONLY or ch in KOREAN_ONLY:
            s, cnt = k, 0
            while s - 1 >= 0 and is_han(run[s - 1]) and run[s - 1] not in STOP_HAN and cnt < 2:
                s -= 1
                cnt += 1
            e, cnt = k + 1, 0
            while e < length and is_han(run[e]) and run[e] not in STOP_HAN and cnt < 2:
                e += 1
                cnt += 1
            spans.append((base + s, base + e))

    return spans


def name_spans(
    text: str, protected: bytearray, names: set[str], extra: set[str]
) -> list[tuple[int, int]]:
    """识别日语 / 韩语 / 朝鲜语人名等「不应繁转简」的片段。"""
    spans = substring_spans(text, set(names) | set(extra))

    n = len(text)
    i = 0
    while i < n:
        if protected[i] or not is_cjk_token_char(text[i]):
            i += 1
            continue
        j = i
        while j < n and not protected[j] and is_cjk_token_char(text[j]):
            j += 1
        if j > i:
            spans.extend(_name_spans_in_run(text[i:j], i))
        i = j if j > i else i + 1
    return _merge(spans)


# ---------------------------------------------------------------- 标点 / 数字


def _prev_char(text: str, i: int) -> int:
    j = i - 1
    while j >= 0 and text[j] in " \t　":
        j -= 1
    return -1 if j < 0 or text[j] in "\r\n" else j


def _next_char(text: str, i: int, n: int) -> int:
    j = i + 1
    while j < n and text[j] in " \t　":
        j += 1
    return -1 if j >= n or text[j] in "\r\n" else j


def _cjk_before(src, i: int, dist: int = 16) -> bool:
    """从句点位置向前（不跨行）查找 CJK 字符。src 为「已处理视图」。"""
    j = i - 1
    limit = max(-1, i - dist)
    while j > limit:
        if src[j] in "\r\n":
            return False
        if is_cjk(src[j]):
            return True
        j -= 1
    return False


def _trailing_word(text: str, i: int) -> str:
    j = i - 1
    while j >= 0 and (text[j].isascii() and (text[j].isalnum() or text[j] == ".")):
        j -= 1
    return text[j + 1 : i]


def decide_punct(text: str, i: int, ch: str, opts, out) -> str | None:
    """返回替换字符；None 表示保持原样。

    out 是「已处理视图」：左侧已转换的字符（如 ) → ））应被视作 CJK 上下文，
    否则「（中文）." 这类句子末尾的句点会被漏判。
    """
    n = len(text)
    p, q = _prev_char(text, i), _next_char(text, i, n)
    pch = out[p] if p >= 0 else ""
    qch = text[q] if q >= 0 else ""
    pcjk, qcjk = is_cjk(pch), is_cjk(qch)

    if ch == ".":
        if opts.period == "keep":
            return None
        if pch.isdigit() and qch.isdigit():
            return None                                   # 3.14
        if (pch.isascii() and pch.isalnum()) and (qch.isascii() and qch.isalnum()):
            return None                                   # node.js / v1.2 / index.html
        if qch == "" or qch in " \t":
            w = _trailing_word(text, i).lower()
            if w in ABBREVS or (len(w) == 1 and w.isalpha() and w.isupper()):
                return None                               # etc. / U.S. / J.
        if pcjk:
            return "。" if opts.period == "ideographic" else "．"
        if (pch.isascii() and pch.isalnum()) and (qch == "" or qch in " \t"):
            if _cjk_before(out, i):                       # 拉丁收尾但本行前文为中文
                return "。" if opts.period == "ideographic" else "．"
        return None

    if ch == ",":
        if pch.isdigit() and qch.isdigit():
            return None                                   # 1,000 千分位
        return "，" if (pcjk or qcjk) else None

    if ch == ":":
        if pch.isdigit() and qch.isdigit():
            return None                                   # 10:30 时间 / 比分
        return "：" if (pcjk or qcjk) else None

    if ch == ";":
        return "；" if (pcjk or qcjk) else None

    if ch in "!?":
        if qch in "=<>&|":
            return None                                   # != / ?: 运算符
        if pcjk or qcjk:
            return PUNCT_MAP[ch]
        if qch == "" and pch and (pch.isalnum() or pcjk) and _cjk_before(out, i):
            return PUNCT_MAP[ch]
        return None

    if ch in "()[]{}":
        return PUNCT_MAP[ch] if (pcjk or qcjk) else None

    if ch in "<>":
        if pch == "-" or qch == "-" or pch in "=<>|&" or qch in "=<>|&":
            return None                                   # -> / => / <=
        return PUNCT_MAP[ch] if (pcjk or qcjk) else None

    if ch == "~":
        if pch.isdigit() and qch.isdigit():
            return "～"                                    # 1~5
        return "～" if (pcjk or qcjk) else None

    if ch == "|":
        if pch == "-" or qch == "-":
            return None
        return "｜" if (pcjk or qcjk) else None

    if ch in "\"'":
        if opts.quotes == "keep":
            return None
        if not (pcjk or qcjk):
            return None                                   # don't / "Hello"
        if opts.quotes == "curly":
            return None                                   # 由外层统一配对处理
        return PUNCT_MAP[ch]

    if ch in SYMBOL_MAP:
        if pch.isdigit() or qch.isdigit() or pcjk or qcjk:
            return SYMBOL_MAP[ch]
        return None

    return None


def transform_punct_digits(text: str, protected: bytearray, opts, stats: dict) -> str:
    out = list(text)
    quote_open = {'"': True, "'": True}
    for i, ch in enumerate(text):
        if protected[i]:
            continue
        if i == 0 or text[i - 1] in "\r\n":
            quote_open = {'"': True, "'": True}

        if ch in FULLWIDTH_DIGITS:
            out[i] = FULLWIDTH_DIGITS[ch]
            stats["digits"] += 1
            continue

        if ch == "." or ch in PUNCT_MAP or (opts.symbols and ch in SYMBOL_MAP):
            if opts.quotes == "curly" and ch in "\"'":
                pi, qi = _prev_char(text, i), _next_char(text, i, len(text))
                pcjk = is_cjk(out[pi]) if pi >= 0 else False
                qcjk = is_cjk(text[qi]) if qi >= 0 else False
                if pcjk or qcjk:
                    out[i] = CURLY_OPEN[ch] if quote_open[ch] else CURLY_CLOSE[ch]
                    quote_open[ch] = not quote_open[ch]
                    stats["punct"] += 1
                continue
            repl = decide_punct(text, i, ch, opts, out)
            if repl is not None:
                out[i] = repl
                stats["punct"] += 1
    return "".join(out)


# ---------------------------------------------------------------- 繁转简


def convert_hanzi(text: str, protected: bytearray, convert, stats: dict) -> str:
    spans = _bytearray_to_spans(protected)
    if not spans:
        converted = convert(text)
        _record_hanzi_stats(text, converted, stats)
        return converted

    parts, last = [], 0
    for s, e in spans:
        parts.append(text[last:s])
        last = e
    parts.append(text[last:])

    holders = [f"\ue000{k}\ue001" for k in range(len(spans))]
    buf = parts[0]
    for k in range(len(spans)):
        buf += holders[k] + parts[k + 1]

    converted = convert(buf)
    _record_hanzi_stats(buf, converted, stats)  # 必须在还原占位符之前统计
    for k, (s, e) in enumerate(spans):
        converted = converted.replace(holders[k], text[s:e])
    return converted


def _bytearray_to_spans(protected: bytearray) -> list[tuple[int, int]]:
    spans, start = [], None
    for i, v in enumerate(protected):
        if v and start is None:
            start = i
        elif not v and start is not None:
            spans.append((start, i))
            start = None
    if start is not None:
        spans.append((start, len(protected)))
    return spans


def _record_hanzi_stats(before: str, after: str, stats: dict) -> None:
    if before == after:
        return
    sm = difflib.SequenceMatcher(None, before, after, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        stats["hanzi"] += max(i2 - i1, j2 - j1)
        if tag == "replace" and before[i1:i2] and len(stats["examples"]) < 8:
            stats["examples"].append({"from": before[i1:i2], "to": after[j1:j2]})


# ---------------------------------------------------------------- 主流程


def process(text: str, opts, convert) -> tuple[str, dict]:
    stats = {"digits": 0, "punct": 0, "hanzi": 0, "examples": []}

    spans = structural_spans(text, opts.format, opts.protect_frontmatter)
    protected = bytearray(len(text))
    for s, e in spans:
        for i in range(s, min(e, len(text))):
            protected[i] = 1

    extra = set(x.strip() for x in (opts.protect or "").split(",") if x.strip())
    for name in opts.protect_names or []:
        extra.add(name.strip())

    if opts.protect_names_file:
        p = Path(opts.protect_names_file)
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    extra.add(line)

    if opts.use_names:
        for s, e in name_spans(text, protected, opts._names, extra):
            for i in range(s, e):
                protected[i] = 1
    elif extra:
        for s, e in substring_spans(text, extra):
            for i in range(s, e):
                protected[i] = 1

    result = text
    if opts.do_punct or opts.do_digits:
        result = transform_punct_digits(result, protected, opts, stats)
    if opts.do_t2s:
        result = convert_hanzi(result, protected, convert, stats)

    stats["names_protected"] = len(extra)
    return result, stats


def read_text(path: Path) -> tuple[str, bool]:
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    return raw.decode("utf-8-sig"), bom


def write_text(path: Path, text: str, bom: bool) -> None:
    path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8"))


def detect_format(path: Path | None, opts_format: str) -> str:
    if opts_format != "auto":
        return opts_format
    if path and path.suffix.lower() in (".md", ".markdown", ".mdx"):
        return "md"
    return "text"


def emit_report(label: str, stats: dict, backend: str, as_json: bool) -> None:
    total = stats["digits"] + stats["punct"] + stats["hanzi"]
    if as_json:
        print(
            json.dumps(
                {"target": label, "backend": backend, "total": total, **stats},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return
    print(
        f"[report] {label}: 数字 {stats['digits']} 处 / 标点 {stats['punct']} 处 / "
        f"繁简 {stats['hanzi']} 处 / 共 {total} 处  (backend={backend})",
        file=sys.stderr,
    )
    for ex in stats["examples"][:12]:
        print(f"         繁简示例: {ex['from']} → {ex['to']}", file=sys.stderr)


def emit_diff(label: str, before: str, after: str) -> None:
    if before == after:
        return
    d = difflib.unified_diff(
        before.splitlines(keepends=True),
        after.splitlines(keepends=True),
        fromfile=f"{label} (原)",
        tofile=f"{label} (规范化后)",
        n=0,
    )
    sys.stderr.write("".join(d))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="normalize.py",
        description="中文文本字形级规范化：全角数字半角化、半角标点全角化、非简体转简体（不改语法、不润色）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("files", nargs="*", help="待处理文件（默认输出到 stdout）")
    p.add_argument("--text", help="直接处理给出的文本")
    p.add_argument("--stdin", action="store_true", help="从标准输入读取")
    p.add_argument("--in-place", "-i", action="store_true", help="原地覆盖写回文件")
    p.add_argument("--output", "-o", help="写入指定文件（单输入时可用）")
    p.add_argument("--suffix", help="批量处理时的输出后缀，如 .norm，写到同名+suffix 文件")
    p.add_argument("--check", action="store_true", help="只报告不改动；有可改项时退出码为 1")
    p.add_argument("--report", action="store_true", help="输出改动统计（stderr）")
    p.add_argument("--report-json", action="store_true", help="以 JSON 输出改动统计（stderr）")
    p.add_argument("--diff", action="store_true", help="输出 unified diff（stderr）")
    p.add_argument("--format", default="auto", choices=["auto", "md", "text"], help="输入格式")
    p.add_argument("--protect", help="额外保护名单，逗号分隔（如日韩人名）")
    p.add_argument("--protect-name", action="append", dest="protect_names", help="追加一个保护名（可重复）")
    p.add_argument("--protect-file", dest="protect_names_file", help="保护名单文件，一行一个")
    p.add_argument("--names-file", help="自定义日韩人名表路径")
    p.add_argument("--convert-frontmatter", dest="protect_frontmatter", action="store_false",
                   help="不保护 YAML frontmatter，一并参与转换")
    p.add_argument("--no-names", dest="use_names", action="store_false", help="关闭日韩人名自动保护")
    p.add_argument("--no-t2s", dest="do_t2s", action="store_false", help="跳过繁转简")
    p.add_argument("--no-punct", dest="do_punct", action="store_false", help="跳过标点转换")
    p.add_argument("--no-digits", dest="do_digits", action="store_false", help="跳过数字转换")
    p.add_argument(
        "--period", default="ideographic", choices=["ideographic", "fullwidth", "keep"],
        help="半角句点处理：ideographic→。（默认）/ fullwidth→．/ keep→保留半角",
    )
    p.add_argument(
        "--quotes", default="fullwidth", choices=["fullwidth", "curly", "keep"],
        help="半角引号处理：fullwidth→＂＇（默认）/ curly→“”‘’ / keep→保留半角",
    )
    p.add_argument("--symbols", action="store_true", help="同时转换 @#＄%%&*+= 等半角符号")
    p.add_argument("--no-auto-install", dest="auto_install", action="store_false",
                   help="OpenCC 缺失时不自动 pip 安装，直接用内置字表")
    p.set_defaults(use_names=True, do_t2s=True, do_punct=True, do_digits=True,
                   auto_install=True, protect_frontmatter=True)
    return p


def main(argv=None) -> int:
    opts = build_parser().parse_args(argv)
    opts._names = load_names(Path(opts.names_file) if opts.names_file else None)

    convert, backend = get_converter(opts.auto_install)

    if opts.text is not None:
        items: list[tuple[str, str, bool]] = [("<text>", opts.text, False)]
    elif opts.stdin:
        items = [("<stdin>", sys.stdin.read(), False)]
    elif opts.files:
        items = []
        for f in opts.files:
            path = Path(f)
            if not path.exists():
                print(f"[error] 文件不存在: {f}", file=sys.stderr)
                return 2
            text, bom = read_text(path)
            items.append((str(path), text, bom))
    else:
        build_parser().print_help()
        return 2

    if len(opts.files) > 1 and not (opts.in_place or opts.suffix or opts.check):
        print("[error] 多文件处理请显式指定 --in-place / --suffix / --check", file=sys.stderr)
        return 2

    changed_any = False
    user_format = opts.format
    for label, text, bom in items:
        path = Path(label) if label not in ("<text>", "<stdin>") else None
        opts.format = detect_format(path, user_format)
        result, stats = process(text, opts, convert)
        if result != text:
            changed_any = True

        if opts.report or opts.report_json or opts.check:
            emit_report(label, stats, backend, opts.report_json)
        if opts.diff:
            emit_diff(label, text, result)

        if opts.check:
            continue
        if opts.in_place or opts.suffix:
            src = Path(label)
            target = src if opts.in_place else src.with_suffix(src.suffix + opts.suffix)
            write_text(target, result, bom)
            print(f"[written] {target}", file=sys.stderr)
        elif opts.output:
            write_text(Path(opts.output), result, bom)
            print(f"[written] {opts.output}", file=sys.stderr)
        else:
            sys.stdout.write(result)

    if opts.check:
        return 1 if changed_any else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
