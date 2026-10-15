#!/usr/bin/env python3
"""Build TCMS-ARCHITECTURE-GUIDE.pdf from docs/*.md via pandoc + weasyprint."""
import subprocess, pathlib, re

ROOT = pathlib.Path("/home/z/my-project/scripts/tcms-package")
DOCS = ROOT / "docs"
OUT_PDF = pathlib.Path("/home/z/my-project/download/TCMS-ARCHITECTURE-GUIDE.pdf")
OUT_PDF_ZIP = ROOT / "ARCHITECTURE-GUIDE.pdf"
WORK = pathlib.Path("/tmp/tcms-docs-build")

DOC_ORDER = [
    "README.md", "01-overview-and-architecture.md", "02-database-schema.md",
    "03-authentication-and-permissions.md", "04-api-reference.md",
    "05-frontend-architecture.md", "06-page-login-and-dashboard.md",
    "07-page-modules-and-test-cases.md", "08-page-reviews-workflow.md",
    "09-page-bugs-tasks-and-reports.md",
    "10-page-activity-users-notifications-profile.md",
    "11-end-to-end-flows.md", "12-realtime-and-deployment.md", "13-file-index.md",
]

CSS = """
@page { size: A4; margin: 18mm 15mm 16mm 15mm;
  @bottom-center { content: "TCMS Architecture Guide  ·  page " counter(page) " / " counter(pages);
                   font-size: 8pt; color: #64748b; font-family: 'DejaVu Sans', sans-serif; } }
html, body { max-width: none !important; padding: 0 !important; margin: 0 !important; }
body { font-family: 'DejaVu Sans', sans-serif; font-size: 9.2pt; line-height: 1.5; color: #1e293b; }
h1 { font-size: 17pt; color: #0f172a; border-bottom: 2.5pt solid #6366f1; padding-bottom: 5pt;
     margin-top: 18pt; page-break-before: always; page-break-after: avoid; }
h1:first-of-type { page-break-before: avoid; }
h2 { font-size: 12.5pt; color: #4338ca; margin-top: 14pt; page-break-after: avoid; }
h3 { font-size: 10.5pt; color: #334155; page-break-after: avoid; }
p, li { orphans: 2; widows: 2; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 7.8pt; background: #f1f5f9;
       padding: 0.5pt 2pt; border-radius: 2pt; color: #4338ca; }
pre { background: #0f172a; color: #e2e8f0; padding: 8pt 10pt; border-radius: 4pt;
      font-size: 6.6pt; line-height: 1.35; white-space: pre; }
pre code { background: none; color: #e2e8f0; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 8.2pt;
        page-break-inside: avoid; }
th { background: #eef2ff; color: #312e81; text-align: left; }
th, td { border: 0.6pt solid #cbd5e1; padding: 3.5pt 5pt; vertical-align: top; }
tr:nth-child(even) td { background: #f8fafc; }
blockquote { border-left: 3pt solid #6366f1; background: #eef2ff; margin: 8pt 0;
             padding: 6pt 10pt; color: #3730a3; }
a { color: #4338ca; text-decoration: none; }
hr { border: none; border-top: 0.7pt solid #cbd5e1; margin: 12pt 0; }
#title-block-header { text-align: center; margin-bottom: 20pt; }
h1.title { border: none; font-size: 24pt; color: #0f172a; page-break-before: avoid; }
p.subtitle { font-size: 11pt; color: #475569; }
"""

def main():
    WORK.mkdir(parents=True, exist_ok=True)
    parts = []
    for name in DOC_ORDER:
        text = (DOCS / name).read_text(encoding="utf-8")
        if name == "README.md":
            # drop the H1 (pandoc's metadata title replaces it) but keep the intro
            text = re.sub(r"\A# [^\n]+\n+", "", text)
        parts.append(text)
    combined = "\n\n".join(parts)
    combined_md = WORK / "combined.md"
    combined_md.write_text(combined, encoding="utf-8")

    html_path = WORK / "combined.html"
    subprocess.run([
        "pandoc", str(combined_md), "-f", "gfm", "-t", "html5", "--standalone",
        "--metadata", "title=TCMS — Architecture & Complete Working Guide",
        "--metadata", "subtitle=Every layer, endpoint, page and file — explained. "
                      "Next.js 16 · React 19 · Prisma 6 · PostgreSQL (JSONB)",
        "-o", str(html_path),
    ], check=True)

    html = html_path.read_text(encoding="utf-8")
    html = html.replace("</head>", f"<style>{CSS}</style></head>")
    styled = WORK / "styled.html"
    styled.write_text(html, encoding="utf-8")

    from weasyprint import HTML
    HTML(filename=str(styled)).write_pdf(str(OUT_PDF))
    OUT_PDF_ZIP.write_bytes(OUT_PDF.read_bytes())
    size_kb = OUT_PDF.stat().st_size // 1024
    print(f"OK -> {OUT_PDF} ({size_kb} KB) + copy inside project as ARCHITECTURE-GUIDE.pdf")

if __name__ == "__main__":
    main()
