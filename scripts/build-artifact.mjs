// Bundles the app into one self-contained HTML file (dist/seerah-timeline.html) for
// publishing as a hosted claude.ai page. The hosted page saves edits to its own
// database, so the sample data is left out; it is loaded into the database separately.
//
// Usage: node scripts/build-artifact.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = p => readFileSync(join(root, p), "utf8");

const html = read("index.html");
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const body = html.match(/<body>([\s\S]*?)<script/)[1];
// Google Fonts links from <head> (the only stylesheet host hosted pages allow).
const fontLinks = (html.match(/<link [^>]*fonts\.(googleapis|gstatic)\.com[^>]*>/g) || []).join("\n");
const css = read("css/styles.css");
// The Sura table ships with the page; the sample events do not.
const js = read("js/quran-data.js") + "\n" + read("js/app.js");
if (/<\/script/i.test(js)) throw new Error("app.js must not contain a closing script tag");

const out = `<title>${title}</title>
${fontLinks}
<style>
${css}
</style>
${body.trim()}
<script>
${js}
</script>
`;

mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist/seerah-timeline.html"), out);
console.log(`Wrote dist/seerah-timeline.html (${(out.length / 1024).toFixed(1)} KB)`);
