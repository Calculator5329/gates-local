// Replies with a page in them, for the threads scenario: a loan calculator in
// three versions, and a probe page that tries every way out of its frame and
// writes what happened into itself. Each reply streams word by word, so the
// page block arrives open first.

export const LOAN_PROMPTS = ["make me a loan calculator", "make the rate a slider", "show the total interest too"] as const;
export const PROBE_PROMPT = "make the escape probe page";
export const NAVIGATE_PROMPT = "make the leaving page";
export const BIG_PROMPT = "make the big page";
/** The address the probe and the leaving page try to reach: the app's own web server. */
export const PROBE_TARGET = "http://127.0.0.1:5287/";

export function loanPage(o: { slider?: boolean; total?: boolean } = {}): string {
  const rate = o.slider
    ? ['      <label>Rate <output id="rv">6.5%</output>', '        <input id="rate" type="range" min="1" max="15" step="0.1" value="6.5">', "      </label>"]
    : ["      <label>Rate (% a year)", '        <input id="rate" type="number" value="6.5" step="0.1">', "      </label>"];
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    "  <title>Loan calculator</title>",
    "  <style>",
    "    :root { color-scheme: dark; }",
    "    * { box-sizing: border-box; }",
    "    html, body { margin: 0; background: #0f0f0f; }",
    "    body { color: #e6e6e6; font: 14px/1.5 system-ui, sans-serif; padding: 20px 22px; }",
    "    main { max-width: 680px; margin: 0 auto; }",
    "    .fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }",
    "    label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: #9a9a9a; }",
    "    label output { color: #e6e6e6; font-variant-numeric: tabular-nums; }",
    "    input[type=number] { height: 34px; padding: 0 10px; border: 1px solid #2b2b2b; border-radius: 6px; background: #171717; color: #f2f2f2; font: inherit; font-variant-numeric: tabular-nums; }",
    "    input[type=range] { height: 34px; margin: 0; accent-color: #3dbd85; }",
    "    .pay { display: flex; align-items: baseline; gap: 8px; margin: 18px 0 2px; }",
    "    .pay b { font-size: 30px; font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }",
    "    .note { font-size: 13px; color: #9a9a9a; font-variant-numeric: tabular-nums; }",
    "    table { width: 100%; margin-top: 14px; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }",
    "    th, td { padding: 6px 0; text-align: right; border-bottom: 1px solid #222; }",
    "    th { font-weight: 500; color: #9a9a9a; }",
    "    th:first-child, td:first-child { text-align: left; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    '    <div class="fields">',
    "      <label>Amount ($)",
    '        <input id="amount" type="number" value="25000" step="500">',
    "      </label>",
    ...rate,
    "      <label>Years",
    '        <input id="years" type="number" value="5" min="1">',
    "      </label>",
    "    </div>",
    '    <div class="pay"><b id="monthly"></b><span class="note">a month</span></div>',
    '    <div class="note" id="sum"></div>',
    "    <table>",
    "      <thead><tr><th>Year</th><th>Principal</th><th>Interest</th><th>Balance</th></tr></thead>",
    '      <tbody id="rows"></tbody>',
    "    </table>",
    "  </main>",
    "  <script>",
    "    const $ = (id) => document.getElementById(id);",
    '    const money = (n, c = 0) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: c, maximumFractionDigits: c });',
    "    function update() {",
    '      const p = +$("amount").value, r = +$("rate").value / 1200, n = +$("years").value * 12;',
    "      const m = r ? p * r / (1 - Math.pow(1 + r, -n)) : p / n;",
    '      $("monthly").textContent = money(m, 2);',
    ...(o.slider ? ['      $("rv").textContent = (+$("rate").value).toFixed(1) + "%";'] : []),
    o.total
      ? '      $("sum").textContent = n + " payments · " + money(m * n - p) + " interest · " + money(m * n) + " in all";'
      : '      $("sum").textContent = n + " payments";',
    '      let balance = p, html = "";',
    "      for (let y = 1; y <= n / 12; y++) {",
    "        let principal = 0, interest = 0;",
    "        for (let k = 0; k < 12; k++) { const i = balance * r; interest += i; principal += m - i; balance -= m - i; }",
    '        html += "<tr><td>" + y + "</td><td>" + money(principal) + "</td><td>" + money(interest) + "</td><td>" + money(Math.max(balance, 0)) + "</td></tr>";',
    "      }",
    '      $("rows").innerHTML = html;',
    "    }",
    '    document.addEventListener("input", update);',
    "    update();",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Tries each way out and writes the outcome as JSON into #out once all have
 * settled: what it can learn of the app's address, the app's window, storage,
 * the network, WebRTC and popups, and which of its requests the policy refused.
 */
export function probePage(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Escape probe</title>
</head>
<body>
<pre id="out">running</pre>
<script>
const result = { violations: [] };
document.addEventListener("securitypolicyviolation", (e) => result.violations.push(e.effectiveDirective));
const tryIt = (f) => { try { return String(f()); } catch (e) { return "threw " + e.name; } };
result.referrer = document.referrer;
result.href = location.href.slice(0, 16);
// the address it resolves against, whole unless it is its own data: one (that holds this source)
result.base = document.baseURI.startsWith("data:") ? "data:" : document.baseURI;
result.parentDocument = tryIt(() => parent.document.title);
result.parentHref = tryIt(() => parent.location.href);
result.topHref = tryIt(() => top.location.href);
result.localStorage = tryIt(() => localStorage.length);
result.sessionStorage = tryIt(() => sessionStorage.length);
result.cookie = tryIt(() => document.cookie);
result.indexedDB = tryIt(() => indexedDB.open("x") && "opened");
result.rtc = typeof RTCPeerConnection + "," + typeof webkitRTCPeerConnection + "," + typeof RTCDataChannel;
// recorded, not refused: a blank frame of its own is a fresh window with the constructors back
result.nestedRtc = tryIt(() => { const f = document.createElement("iframe"); document.body.append(f); return typeof f.contentWindow.RTCPeerConnection; });
result.popup = tryIt(() => window.open("${PROBE_TARGET}") === null ? "null" : "opened");
// the origins of the windows around it, which no referrer policy hides in every browser
result.ancestors = tryIt(() => location.ancestorOrigins ? [...location.ancestorOrigins].join(",") : "none");
result.eval = tryIt(() => eval("1 + 1"));
try { parent.postMessage({ from: "page" }, "*"); result.posted = "sent"; } catch (e) { result.posted = "threw " + e.name; }
const img = (src) => new Promise((done) => { const i = new Image(); i.onload = () => done("loaded"); i.onerror = () => done("failed"); i.src = src; });
Promise.all([
  fetch("${PROBE_TARGET}").then(() => "reached", (e) => "failed " + e.name),
  img("${PROBE_TARGET}favicon.svg"),
  img("data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="),
]).then(([fetched, webImage, dataImage]) => {
  Object.assign(result, { fetched, webImage, dataImage });
  setTimeout(() => { document.getElementById("out").textContent = JSON.stringify(result); }, 50);
});
</script>
</body>
</html>`;
}

/** A page that moves its own frame to the app's address, and tries to move the app's window. */
export function leavingPage(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Leaving page</title></head>
<body>
<p id="out">here</p>
<script>
try { top.location.href = "${PROBE_TARGET}#moved"; } catch (e) { document.getElementById("out").textContent = "top threw " + e.name; }
setTimeout(() => { location.href = "${PROBE_TARGET}"; }, 100);
</script>
</body>
</html>`;
}

/** A page past what a frame's address can hold (2 MiB in Chromium): one long line, so the stream sends it whole. */
export function bigPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Big page</title></head><body><p id="out">big</p><script>const pad = "${"a".repeat(BIG_PAD)}";</script></body></html>`;
}
export const BIG_PAD = 2_200_000;

const fenced = (before: string, code: string, after: string) => `${before}\n\n\`\`\`html\n${code}\n\`\`\`\n\n${after}`;

/** The reply to a page prompt, or undefined for any other prompt. */
export function pageReply(prompt: string): string | undefined {
  switch (prompt) {
    case LOAN_PROMPTS[0]: return fenced("Here it is: amount, rate and years in, the monthly payment and a year-by-year schedule out.", loanPage(), "Change any field and it updates.");
    case LOAN_PROMPTS[1]: return fenced("The rate is a slider now, from 1% to 15%.", loanPage({ slider: true }), "Drag it to compare.");
    case LOAN_PROMPTS[2]: return fenced("Added the total interest and the total paid under the payment.", loanPage({ slider: true, total: true }), "Everything else is the same.");
    case PROBE_PROMPT: return fenced("Here is the probe.", probePage(), "It reports what it reached.");
    case NAVIGATE_PROMPT: return fenced("Here is a page that leaves.", leavingPage(), "It tries to go elsewhere.");
    case BIG_PROMPT: return fenced("Here is a big page.", bigPage(), "It is mostly padding.");
    default: return undefined;
  }
}
