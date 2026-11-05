"""Real Pandoc/XeLaTeX: outline and printed catalogue are independent."""
import json
from pathlib import Path
import subprocess
import tempfile
import pdf_layout

ROOT = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="pdf-outline-") as temporary:
    directory = Path(temporary)
    markdown = "# Main chapter\n\nFirst body paragraph.\n\n## Section\n\nSecond body paragraph.\n"
    ast = subprocess.check_output(["pandoc", "--from=markdown", "--to=json"], input=markdown.encode())
    (directory / "document.json").write_bytes(ast)
    for outline, toc in [(True, False), (False, False), (True, True), (False, True)]:
        options = {"outline": outline, "toc": toc, "removePageNumber": True}
        args = pdf_layout.arguments(options, directory, ROOT / "header.tex")
        result = subprocess.run(args, cwd=directory, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stderr[-4000:]
        report = json.loads(subprocess.check_output([
            "/usr/bin/swift", "-module-cache-path", "/tmp/local-pdf-swift-cache",
            str(ROOT / "tests/inspect-navigation.swift"), str(directory / "document.pdf")
        ], text=True))
        assert bool(report["outline"]) == outline, report
        assert bool(report["links"]) == toc, report
        assert report["pages"] == (2 if toc else 1), report
        if toc:
            assert all(link["target"] >= 1 for link in report["links"]), report
        print(f"PASS Pandoc outline={outline} toc={toc}: {len(report['outline'])} bookmarks, {report['pages']} pages", flush=True)
