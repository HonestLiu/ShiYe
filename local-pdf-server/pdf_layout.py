"""Compose selected messages and map the original PDF settings to Pandoc."""
from datetime import datetime
import math
from pathlib import Path
import re
import unicodedata
import sys


def text(value):
    return str(value or "").replace("\n", " ").replace("\r", " ")


def metadata(payload):
    options = payload.get("options") or {}
    info = payload.get("exportInfo") or {}
    user = info.get("user") or {}
    show = options.get("userInfo") or {}
    values = []
    if show.get("includeUserName"):
        values.append("**用户：** " + text(options.get("userName", user.get("name", ""))))
    if show.get("includeUserEmail"):
        values.append("**邮箱：** " + text(options.get("userEmail", user.get("email", ""))))
    settings = options.get("dateSettings") or {}
    kind = settings.get("includeDateType", "none")
    times = info.get("timestamps") or {}
    if not times:
        times = {"created": info.get("createTime"), "updated": info.get("updateTime")}
    for key, label in (("created", "创建"), ("updated", "更新"), ("exported", "导出")):
        if kind not in ("all", {"created": "create", "updated": "update", "exported": "export"}[key]):
            continue
        value = times.get(key)
        raw = times.get(key + "Raw")
        if raw:
            try:
                stamp = datetime.fromtimestamp(float(raw) / 1000)
                formats = {"MDY": "%m/%d/%Y", "DMY": "%d/%m/%Y", "YMD": "%Y/%m/%d",
                           "yyyy-MM-dd": "%Y-%m-%d", "MM/dd/yyyy": "%m/%d/%Y", "dd/MM/yyyy": "%d/%m/%Y", "YYYY-MM-DD": "%Y-%m-%d"}
                clock = settings.get("timeFormat", "24hour")
                clock_format = "" if clock == "none" else " %I:%M %p" if clock in ("12h", "12", "12hour") else " %H:%M"
                value = stamp.strftime(formats.get(settings.get("dateFormat"), "%Y/%m/%d") + clock_format)
            except (ValueError, OverflowError, OSError):
                pass
        if key == "exported" and not value:
            clock = settings.get("timeFormat", "24hour")
            clock_format = "" if clock == "none" else " %I:%M %p" if clock in ("12h", "12", "12hour") else " %H:%M"
            date_format = {"MDY": "%m/%d/%Y", "DMY": "%d/%m/%Y", "YMD": "%Y/%m/%d"}.get(settings.get("dateFormat"), "%Y/%m/%d")
            value = datetime.now().strftime(date_format + clock_format)
        if value:
            values.append(f"**{label}：** {text(value)}")
    if options.get("includeConvoLink") and info.get("convoLink"):
        values.append("**对话：** " + text(info["convoLink"]))
    return "\n\n".join(values)


def compose(payload):
    options = payload.get("options") or {}
    info = payload.get("exportInfo") or {}
    messages = payload.get("messages")
    if isinstance(messages, list):
        if not messages:
            raise ValueError("No chat content selected")
        title = text(options.get("contentTitle") or payload.get("title") or info.get("name") or "聊天导出")
        output = ["# " + title, metadata(payload)]
        for index, message in enumerate(messages):
            if not isinstance(message, dict) or not isinstance(message.get("markdown"), str):
                raise ValueError("Invalid selected message")
            role = text(message.get("heading", message.get("role", "Message")))
            output.append(f"## {role} {{#local-message-{index}}}")
            details = []
            if options.get("includeModelName") and message.get("model"):
                details.append(text(message["model"]))
            if options.get("includePerMsgTime") and message.get("createTime"):
                details.append(text(message["createTime"]))
            if details:
                output.append(" · ".join(details))
            output.append(message["markdown"])
        if not options.get("removeBrand"):
            output.append("---\n\n本机导出 · Pandoc / XeLaTeX")
        return "\n\n".join(part for part in output if part)
    for key in ("markdown", "localMarkdown"):
        if isinstance(payload.get(key), str):
            return payload[key]
    raise ValueError("Expected markdown, localMarkdown, or selected messages")


def apply_pagebreaks(ast, payload):
    options = payload.get("options") or {}
    messages = payload.get("messages") or []
    starts = {"local-message-" + str(index) for index, message in enumerate(messages)
              if options.get("pageBreakPerPrompt") and index > 0 and str(message.get("role", "")).lower() in ("user", "prompt", "用户", "提问")}
    blocks = []
    for block in ast.get("blocks", []):
        if block.get("t") == "Header" and block["c"][1][0] in starts:
            blocks.append({"t": "RawBlock", "c": ["latex", "\\clearpage"]})
        blocks.append(block)
    ast["blocks"] = blocks
    if options.get("toc") and isinstance(options.get("tocStyle"), dict) and messages:
        # Build a local custom TOC with role-specific prefix and colors. Only
        # trusted TeX commands are generated here, after sanitizing input AST.
        def escape(value):
            replacements = {"\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#", "_": r"\_", "~": r"\textasciitilde{}", "^": r"\textasciicircum{}"}
            return "".join(replacements.get(char, char) for char in text(value))
        lines = [r"\section*{目录}"]
        for index, message in enumerate(messages):
            is_user = str(message.get("role", "")).lower() in ("user", "prompt", "用户", "提问")
            style = options["tocStyle"].get("user" if is_user else "assistant") or {}
            if not isinstance(style, dict):
                style = {}
            foreground = str(style.get("fontColor", "#eeeeee" if options.get("darkMode") else "#222222")).lstrip("#")
            background = str(style.get("bgColor", "#23272d" if options.get("darkMode") else "#f5f5f5")).lstrip("#")
            if not re.fullmatch("[a-fA-F0-9]{6}", foreground):
                foreground = "222222"
            if not re.fullmatch("[a-fA-F0-9]{6}", background):
                background = "F5F5F5"
            heading = escape(str(style.get("prefix", "")) + text(message.get("heading", message.get("role", "Message"))))
            label = "local-message-" + str(index)
            lines.append(r"\noindent\hyperref[" + label + r"]{\colorbox[HTML]{" + background + r"}{\textcolor[HTML]{" + foreground + "}{" + heading + r"}}}\hfill\pageref{" + label + r"}\par\smallskip")
        ast["blocks"] = [{"t": "RawBlock", "c": ["latex", "\n".join(lines)]}] + ast["blocks"]
    return ast


def safe_filename(payload):
    options = payload.get("options") or {}
    title = options.get("fileName") or options.get("contentTitle") or payload.get("title") or (payload.get("exportInfo") or {}).get("name") or "chat"
    title = unicodedata.normalize("NFC", text(title))
    title = re.sub(r'[\x00-\x1f<>:"/\\|?*]', "_", title).strip(" .")[:100] or "chat"
    return title if title.lower().endswith(".pdf") else title + ".pdf"


def arguments(options, directory, header):
    size = str(options.get("pageSize", options.get("format", "a4"))).lower()
    size = size if size in ("a3", "a4", "a5", "letter", "legal", "tabloid") else "a4"
    geometry = ["margin=" + {"narrow": "10mm", "normal": "20mm", "wide": "30mm"}.get(str(options.get("margin", "normal")), "20mm")]
    if options.get("landscape") or options.get("pageOrient") == "landscape":
        geometry.append("landscape")
    try:
        size_value = float(str(options.get("fontSize", 100)).removesuffix("pt"))
    except (ValueError, TypeError):
        size_value = 100
    if not math.isfinite(size_value):
        size_value = 100
    # The original dialog represents font size as 20–200 percent. Preserve the
    # previous API's direct 10/11/12pt values too.
    font_pt = size_value if 5 <= size_value < 20 else 11 * min(200, max(20, size_value)) / 100
    additional = [f"\\AtBeginDocument{{\\fontsize{{{font_pt:g}}}{{{font_pt * 1.5:g}}}\\selectfont}}"]
    language = str(options.get("lang", ""))
    if re.fullmatch(r"[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*", language):
        additional.append("\\AtBeginDocument{\\hypersetup{pdflang={" + language + "}}}")
    family = options.get("fontFamily", "default")
    if family == "serif":
        additional.append("\\setmainfont[Path=/System/Library/Fonts/Supplemental/,FontIndex=6,BoldFont=Songti.ttc,BoldFeatures={FontIndex=1}]{Songti.ttc}" if sys.platform == "darwin" else "\\setmainfont{Noto Serif CJK SC}")
    elif family == "mono":
        # STHeiti supplies CJK glyphs; LetterSpace gives the local mono variant
        # a wider text rhythm without relying on unavailable CJK TeX packages.
        additional.append("\\setmainfont[Path=/System/Library/Fonts/,LetterSpace=4]{STHeiti Light.ttc}" if sys.platform == "darwin" else "\\setmainfont{Noto Sans Mono CJK SC}")
    if options.get("removePageNumber"):
        additional.append("\\AtBeginDocument{\\pagestyle{empty}}")
    if options.get("darkMode"):
        additional.append("\\makeatletter\n\\AtBeginDocument{\\pagecolor[rgb]{0.08,0.09,0.11}\\color[rgb]{0.92,0.93,0.95}\\global\\let\\default@color\\current@color}\n\\makeatother")
    (directory / "options.tex").write_text("\n".join(additional), encoding="utf-8")
    args = ["pandoc", "document.json", "--from=json", "--to=latex", "--standalone",
            "--pdf-engine=xelatex", "--pdf-engine-opt=-no-shell-escape",
            "--include-in-header=" + str(header), "--include-in-header=options.tex",
            "-V", "geometry:" + ",".join(geometry), "-V", "papersize:" + size,
            "--highlight-style=" + ("breezedark" if options.get("darkMode") else "pygments"),
            "-o", "document.pdf"]
    if options.get("toc") and not options.get("_customToc"):
        args += ["--toc", "--toc-depth=2", "-V", "toc-title:目录"]
    if options.get("darkMode"):
        args += ["-V", "colorlinks:true", "-V", "linkcolor:white", "-V", "urlcolor:cyan", "-V", "citecolor:white"]
    return args
