/**
 * Shared inline stylesheet for PerfStage's standalone HTML artifacts.
 *
 * Reports and trend pages must stay offline and dependency-free, so the CSS is
 * a plain string instead of an external asset. Keeping one copy prevents the
 * two pages from drifting apart visually.
 */
export const REPORT_STYLE = [
  ":root{color-scheme:light dark}",
  "body{margin:0;padding:2rem 1rem;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f8;color:#1c1c1e}",
  "main{max-width:60rem;margin:0 auto;background:#fff;padding:2rem;border-radius:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}",
  "h1{font-size:1.6rem;margin:0 0 .25rem}",
  "h2{font-size:1.2rem;margin:2rem 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid #e5e5ea}",
  "h3{font-size:1rem;margin:1.25rem 0 .5rem}",
  "p{margin:.35rem 0}",
  "ul{margin:.35rem 0;padding-left:1.25rem}",
  "table{width:100%;border-collapse:collapse;margin:.5rem 0}",
  "th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #ececf0;vertical-align:top}",
  "th{font-weight:600;background:#fafafc}",
  "footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e5e5ea;color:#6e6e73;font-size:.85rem}",
  "@media (prefers-color-scheme:dark){body{background:#111113;color:#f2f2f7}main{background:#1c1c1e;box-shadow:none}th{background:#2c2c2e}th,td{border-color:#3a3a3c}h2,footer{border-color:#3a3a3c}footer{color:#98989d}}",
].join("");
