/* WhyDenied setup page. Vanilla JS, no dependencies.
 *
 * Every piece of user or API data is rendered with textContent or DOM nodes,
 * never innerHTML.
 */
(function () {
  "use strict";

  const API = String(window.WHYDENIED_API || "").trim().replace(/\/+$/, "");
  const TEMPLATE_URL = String(window.WHYDENIED_TEMPLATE_URL || "").trim();
  const QUERY = new URLSearchParams(location.search);
  const DEMO = !API || QUERY.has("demo");
  const REGION = "us-east-1";
  const DEMO_REPO = "tusharkhatriofficial/whydenied-demo-infra";
  const EXAMPLE_PR = "https://github.com/tusharkhatriofficial/whydenied-demo-infra/pull/1";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const $ = (sel, root) => (root || document).querySelector(sel);

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CALLOUT_LABEL = { info: "Note", warn: "Caution", error: "Error", ok: "Passed" };

  function callout(kind, ...content) {
    return h("div", { class: "callout callout--" + kind, role: kind === "error" ? "alert" : null },
      h("span", { class: "callout__label", text: CALLOUT_LABEL[kind] || "Note" }),
      h("div", null, ...content));
  }

  // A rubber stamp: uppercase mono text with a border in the status colour.
  // colour: red | green | ink | muted. Text stays real text for assistive tech.
  let stampTurn = 0;
  function stamp(colour, text, extra) {
    const tilt = ["", " stamp--tilt2", " stamp--tilt4"][stampTurn++ % 3];
    return h("span", { class: "stamp stamp--" + colour + tilt + (extra ? " " + extra : ""), text });
  }

  function sampleTag() {
    return DEMO ? h("span", { class: "sample", text: "Sample response" }) : null;
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-shown"), 1800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = h("textarea", { class: "visually-hidden", readonly: true, "aria-hidden": "true" });
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      return ok;
    }
  }

  function copyButton(getText, label) {
    const text = h("span", { text: "Copy" });
    const btn = h("button", { type: "button", class: "copy-btn", "aria-label": label || "Copy to clipboard" }, text);
    btn.addEventListener("click", async () => {
      const ok = await copyText(getText());
      toast(ok ? "Copied to clipboard" : "Copy failed. Select the text instead.");
      if (ok) {
        btn.classList.add("is-copied");
        text.textContent = "Copied";
        setTimeout(() => { btn.classList.remove("is-copied"); text.textContent = "Copy"; }, 1600);
      }
    });
    return btn;
  }

  /* ------------------------------------------------------------------ */
  /* Syntax highlighting                                                 */
  /* ------------------------------------------------------------------ */

  // Each tokenizer returns [[className|null, text], ...]; render() turns that
  // into spans with textContent, so input is never parsed as HTML.

  function scan(src, rules) {
    const out = [];
    let i = 0;
    let plain = "";
    const flush = () => { if (plain) { out.push([null, plain]); plain = ""; } };
    outer: while (i < src.length) {
      for (const [re, fn] of rules) {
        re.lastIndex = i;
        const m = re.exec(src);
        if (m && m[0].length) {
          flush();
          const r = fn(m, src, i);
          if (Array.isArray(r[0])) out.push(...r); else out.push(r);
          i += m[0].length;
          continue outer;
        }
      }
      plain += src[i++];
    }
    flush();
    return out;
  }

  function hclString(s) {
    // Split "${...}" interpolations out of a string literal.
    const parts = [];
    const re = /\$\{[^}]*\}/g;
    let last = 0, m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push(["tok-string", s.slice(last, m.index)]);
      parts.push(["tok-interp", m[0]]);
      last = m.index + m[0].length;
    }
    if (last < s.length) parts.push(["tok-string", s.slice(last)]);
    return parts;
  }

  const HCL_BLOCKS = new Set(["resource", "data", "variable", "output", "locals", "module", "provider", "terraform", "dynamic", "moved", "import"]);

  function tokHCL(src) {
    return scan(src, [
      [/#[^\n]*|\/\/[^\n]*/y, (m) => ["tok-comment", m[0]]],
      [/"(?:[^"\\\n]|\\.)*"/y, (m) => hclString(m[0])],
      [/\b\d+(?:\.\d+)?\b/y, (m) => ["tok-number", m[0]]],
      [/\b(?:true|false|null)\b/y, (m) => ["tok-bool", m[0]]],
      [/[A-Za-z_][\w-]*/y, (m, s, i) => {
        const word = m[0];
        const rest = s.slice(i + word.length);
        if (/^\s*\(/.test(rest)) return ["tok-func", word];
        if (/^[ \t]*=(?!=)/.test(rest)) return ["tok-prop", word];
        const lineStart = s.lastIndexOf("\n", i - 1) + 1;
        if (HCL_BLOCKS.has(word) && /^\s*$/.test(s.slice(lineStart, i))) return ["tok-keyword", word];
        return [null, word];
      }],
    ]);
  }

  function tokJSON(src) {
    return scan(src, [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, (m) => ["tok-prop", m[0]]],
      [/"(?:[^"\\]|\\.)*"/y, (m) => ["tok-string", m[0]]],
      [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, (m) => ["tok-number", m[0]]],
      [/\b(?:true|false|null)\b/y, (m) => ["tok-bool", m[0]]],
    ]);
  }

  function tokShellLine(line) {
    if (/^\s*#/.test(line)) return [["tok-comment", line]];
    let first = true;
    return scan(line, [
      [/^\$ /y, (m) => ["tok-prompt", m[0]]],
      [/'[^']*'|"(?:[^"\\]|\\.)*"/y, (m) => { first = false; return ["tok-string", m[0]]; }],
      [/\s--?[A-Za-z][\w-]*/y, (m) => { first = false; return ["tok-flag", m[0]]; }],
      [/\\$/y, (m) => ["tok-comment", m[0]]],
      [/[A-Za-z][\w.-]*/y, (m) => {
        if (first) { first = false; return ["tok-cmd", m[0]]; }
        return [null, m[0]];
      }],
    ]);
  }

  function tokShell(src) {
    const out = [];
    const lines = src.split("\n");
    let continued = false;
    lines.forEach((line, n) => {
      if (continued && !/^\s*#/.test(line)) {
        // continuation line: no command word
        out.push(...scan(line, [
          [/'[^']*'|"(?:[^"\\]|\\.)*"/y, (m) => ["tok-string", m[0]]],
          [/(?:^|\s)--?[A-Za-z][\w-]*/y, (m) => ["tok-flag", m[0]]],
          [/\\$/y, (m) => ["tok-comment", m[0]]],
        ]));
      } else {
        out.push(...tokShellLine(line));
      }
      continued = /\\$/.test(line);
      if (n < lines.length - 1) out.push([null, "\n"]);
    });
    return out;
  }

  // Terminal transcript: "$ " lines are commands, "!" lines are errors,
  // "{" blocks are JSON output, others plain.
  function tokTerm(src) {
    const out = [];
    const lines = src.split("\n");
    lines.forEach((line, n) => {
      if (line.startsWith("$ ")) out.push(...tokShellLine(line));
      else if (line.startsWith("!")) out.push(["tok-err", line.slice(1)]);
      else if (/^\s*[{}"]/.test(line)) out.push(...tokJSON(line));
      else out.push([null, line]);
      if (n < lines.length - 1) out.push([null, "\n"]);
    });
    return out;
  }

  function tokPlan(src) {
    const out = [];
    const lines = src.split("\n");
    lines.forEach((line, n) => {
      if (/^\s*#/.test(line)) out.push(["tok-comment", line]);
      else if (/^\s*\+/.test(line)) out.push(["tok-add", line]);
      else if (/^(Plan|Apply complete)/.test(line)) out.push(["tok-ok", line]);
      else if (line.startsWith("$ ")) out.push(...tokShellLine(line));
      else out.push([null, line]);
      if (n < lines.length - 1) out.push([null, "\n"]);
    });
    return out;
  }

  const TOKENIZERS = { hcl: tokHCL, json: tokJSON, shell: tokShell, term: tokTerm, plan: tokPlan };

  function highlight(src, lang, marks) {
    const frag = document.createDocumentFragment();
    const tok = TOKENIZERS[lang];
    if (!tok) { frag.appendChild(document.createTextNode(src)); return frag; }
    const marked = new Set((marks || []).filter(Boolean));
    for (const [cls, text] of tok(src)) {
      let node = cls ? h("span", { class: cls, text }) : document.createTextNode(text);
      if (marked.has(text)) node = h("mark", { class: "hl" }, node);
      frag.appendChild(node);
    }
    return frag;
  }

  function codeBlock(opts) {
    const code = h("code", null, highlight(opts.code, opts.lang, opts.marks));
    const pre = h("pre", { tabindex: "0", "aria-label": opts.label || opts.name || "Code" }, code);
    const head = opts.name || opts.copy !== false
      ? h("div", { class: "code__head" },
          h("span", { class: "code__name" }, opts.kind ? h("b", { text: opts.kind }) : null, opts.name || ""),
          opts.copy === false ? null : copyButton(() => opts.code, "Copy " + (opts.name || "code")))
      : null;
    return h("div", { class: "code" + (opts.cls ? " " + opts.cls : "") }, head, pre);
  }

  function fillCode(container, opts) {
    const block = codeBlock(opts);
    container.className = block.className;
    clear(container);
    append(container, Array.from(block.childNodes));
  }

  /* ------------------------------------------------------------------ */
  /* Time                                                                */
  /* ------------------------------------------------------------------ */

  function parseTime(s) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  function relTime(ms, now) {
    if (ms == null) return "unknown";
    const s = Math.round(((now || Date.now()) - ms) / 1000);
    if (s < 5) return "just now";
    if (s < 60) return s + " s ago";
    const m = Math.floor(s / 60);
    if (m < 60) return m + " min ago";
    const hr = Math.floor(m / 60);
    if (hr < 24) return hr + " h ago";
    const d = Math.floor(hr / 24);
    if (d < 30) return d + (d === 1 ? " day ago" : " days ago");
    return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function isoNoMs(d) {
    return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  /* ------------------------------------------------------------------ */
  /* Hashing (demo fix filenames match the backend's fingerprint)        */
  /* ------------------------------------------------------------------ */

  async function sha256Hex(text) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch (_) {
      // Insecure context: fall back to FNV-1a. Only used for sample filenames.
      let h1 = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) { h1 ^= text.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
      return (h1 >>> 0).toString(16).padStart(8, "0").repeat(8);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Demo backend: follows docs/web-api.md exactly                       */
  /* ------------------------------------------------------------------ */

  const REASONS = [
    ["no identity-based policy allows", "missing_identity_allow", "No identity-based policy allows this action."],
    ["explicit deny in an identity-based policy", "explicit_deny_identity", "An identity-based policy explicitly denies this action."],
    ["explicit deny in a service control policy", "explicit_deny_scp", "A service control policy explicitly denies this action."],
    ["no service control policy allows", "missing_scp_allow", "No service control policy allows this action."],
    ["explicit deny in a resource-based policy", "explicit_deny_resource", "A resource-based policy explicitly denies this action."],
    ["no resource-based policy allows", "missing_resource_allow", "No resource-based policy allows this action."],
    ["explicit deny in a permissions boundary", "explicit_deny_boundary", "A permissions boundary explicitly denies this action."],
    ["no permissions boundary allows", "missing_boundary_allow", "No permissions boundary allows this action."],
    ["explicit deny in a session policy", "explicit_deny_session", "A session policy explicitly denies this action."],
    ["no session policy allows", "missing_session_allow", "No session policy allows this action."],
    ["VPC endpoint policy", "vpc_endpoint_policy", "A VPC endpoint policy blocks this action."],
  ];

  const NOT_FIXABLE_NOTE = {
    explicit_deny_identity: "An explicit deny overrides any Allow, so WhyDenied reports it for a human instead of adding a permission.",
    explicit_deny_scp: "A service control policy blocks this action for the whole account, so a new Allow on the role would not help.",
    missing_scp_allow: "The account's service control policies do not allow this action, so a new Allow on the role would not help.",
    explicit_deny_resource: "The resource's own policy denies this call, so a human needs to review that policy rather than the role.",
    missing_resource_allow: "Access is decided by the resource's own policy, which WhyDenied does not edit automatically.",
    explicit_deny_boundary: "A permissions boundary denies this action, so an Allow on the role would still be blocked.",
    missing_boundary_allow: "The role's permissions boundary does not allow this action, so an Allow on the role alone would not help.",
    explicit_deny_session: "A session policy denies this action, so it has to be changed where the session is created.",
    missing_session_allow: "The session policy does not allow this action, so it has to be changed where the session is created.",
    vpc_endpoint_policy: "A VPC endpoint policy blocks this call, which WhyDenied does not edit automatically.",
    unknown: "AWS did not state why the call was denied, so WhyDenied cannot be sure an Allow would fix it.",
  };

  const MSG_RE = /not authorized to perform:\s*(\S+)(?:\s+on resource:\s*(\S+))?/;

  function snake(s) {
    return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  }

  async function demoTry(body) {
    const text = String((body && body.error) || "");
    if (text.length > 4000) return [400, { error: "The message is longer than 4000 characters." }];
    const m = MSG_RE.exec(text);
    const userM = /User:\s*(arn:aws[\w-]*:(?:sts|iam)::\d{12}:\S+?)\s+is not authorized/.exec(text);
    if (!m) return [400, { error: "No AccessDenied message was found. Paste the full error, including \"is not authorized to perform\"." }];

    const action = m[1].replace(/[.,;]+$/, "");
    const resource = (m[2] || "*").replace(/^["']|["'.,;]+$/g, "");
    const caller = userM ? userM[1] : "";

    let principalArn = caller || "unknown";
    let type = "unknown";
    let roleName = null;
    let am;
    if ((am = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\//.exec(caller))) {
      principalArn = "arn:" + am[1] + ":iam::" + am[2] + ":role/" + am[3];
      type = "role"; roleName = am[3];
    } else if ((am = /^arn:(aws[\w-]*):iam::(\d{12}):role\/(?:.*\/)?([^/]+)$/.exec(caller))) {
      type = "role"; roleName = am[3];
    } else if (/^arn:aws[\w-]*:iam::\d{12}:root$/.test(caller)) {
      type = "root";
    } else if (/^arn:aws[\w-]*:iam::\d{12}:user\//.test(caller)) {
      type = "user";
    }

    let reason = "unknown", reasonText = "AWS did not state a reason.";
    for (const [phrase, code, txt] of REASONS) {
      if (text.includes(phrase)) { reason = code; reasonText = txt; break; }
    }

    const denial = {
      principal_arn: principalArn,
      principal_type: type,
      role_name: roleName,
      action,
      resource,
      reason,
      reason_text: reasonText,
    };

    let note = null;
    if (type === "user" || type === "root") {
      note = "The caller is " + (type === "root" ? "the root user" : "an IAM user") + ", not a role, so WhyDenied records the denial without opening a pull request.";
    } else if (type !== "role") {
      note = "The caller could not be identified as an IAM role, so there is no role to fix.";
    } else if (action.includes("*")) {
      note = "WhyDenied refuses to grant a wildcard action.";
    } else if (reason !== "missing_identity_allow") {
      note = NOT_FIXABLE_NOTE[reason] || NOT_FIXABLE_NOTE.unknown;
    }
    if (note) return [200, { denial, fixable: false, fix: null, note }];

    const hash = (await sha256Hex(principalArn + "|" + action.toLowerCase() + "|" + resource)).slice(0, 6);
    const label = "whydenied_" + snake(action) + "_" + hash;
    const roleAddr = "aws_iam_role." + snake(roleName);
    const hcl = [
      "# Generated by WhyDenied. Review before merging.",
      "#",
      "# " + principalArn,
      "# was denied " + action,
      "# on " + resource,
      "# because no identity-based policy allowed it.",
      "# First seen " + isoNoMs(Date.now()) + ".",
      "",
      'resource "aws_iam_role_policy" "' + label + '" {',
      '  name = "' + label + '"',
      "  role = " + roleAddr + ".name",
      "",
      "  policy = jsonencode({",
      '    Version = "2012-10-17"',
      "    Statement = [{",
      '      Effect   = "Allow"',
      '      Action   = "' + action + '"',
      '      Resource = "' + resource + '"',
      "    }]",
      "  })",
      "}",
      "",
    ].join("\n");
    return [200, {
      denial,
      fixable: true,
      fix: { filename: label + ".tf", hcl },
      note: "The role address " + roleAddr + " is inferred from the role name. In a real run WhyDenied reads it from your repository.",
    }];
  }

  function blockBody(content, start) {
    let depth = 1, i = start;
    while (i < content.length && depth) {
      const c = content[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    return content.slice(start, i - 1);
  }

  function topLevel(body) {
    let out = "", depth = 0;
    for (const c of body) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (depth === 0) out += c;
    }
    return out;
  }

  const MATCH_HINT = " so WhyDenied can match denials to this role.";

  function demoCheck(body) {
    const files = (body && body.files) || {};
    const paths = Object.keys(files);
    if (paths.length > 200) return [400, { error: "Too many files: the limit is 200." }];
    let size = 0;
    for (const p of paths) size += String(files[p]).length;
    if (size > 1000000) return [400, { error: "The files are larger than 1 MB in total." }];

    const roles = [];
    const roleRe = /resource\s+"aws_iam_role"\s+"([\w-]+)"\s*\{/g;
    for (const path of paths.sort()) {
      if (!path.endsWith(".tf")) continue;
      const content = String(files[path]);
      let m;
      roleRe.lastIndex = 0;
      while ((m = roleRe.exec(content))) {
        const top = topLevel(blockBody(content, m.index + m[0].length));
        const nameM = /^[ \t]*name[ \t]*=[ \t]*(.+?)[ \t]*$/m.exec(top);
        const prefix = /^[ \t]*name_prefix[ \t]*=/m.test(top);
        const role = { address: "aws_iam_role." + m[1], name: null, path, ready: false, issue: null };
        if (nameM) {
          const raw = nameM[1];
          const lit = /^"([^"]*)"$/.exec(raw);
          if (lit && !lit[1].includes("${")) {
            role.name = lit[1];
            role.ready = true;
          } else if (lit) {
            role.issue = "Name uses interpolation (" + raw + "). Set a literal name" + MATCH_HINT;
          } else {
            role.issue = "Name comes from an expression (" + raw + "). Set a literal name" + MATCH_HINT;
          }
        } else if (prefix) {
          role.issue = "Uses name_prefix. Set an explicit name" + MATCH_HINT;
        } else {
          role.issue = "Has no name, so Terraform generates a random one. Set an explicit name" + MATCH_HINT;
        }
        roles.push(role);
      }
    }
    return [200, { roles, summary: { total: roles.length, ready: roles.filter((r) => r.ready).length } }];
  }

  function demoFeed() {
    const now = Date.now();
    const ago = (min) => isoNoMs(now - min * 60000);
    return [200, {
      denials: [
        {
          action: "ssm:GetParameter",
          role_name: "orders-api-role",
          resource: "arn:aws:ssm:us-east-1:123456789012:parameter/demo/orders-api/db-url",
          status: "pr_open",
          pr_url: EXAMPLE_PR,
          seen_count: 3,
          first_seen: ago(47),
          last_seen: ago(2),
        },
        {
          action: "dynamodb:ListTables",
          role_name: "reporting-batch",
          resource: "arn:aws:dynamodb:us-east-1:123456789012:table/*",
          status: "role_not_found",
          pr_url: null,
          seen_count: 6,
          first_seen: ago(260),
          last_seen: ago(38),
        },
        {
          action: "ec2:RunInstances",
          role_name: "ci-deploy-role",
          resource: "arn:aws:ec2:us-east-1:123456789012:instance/*",
          status: "needs_human",
          pr_url: null,
          seen_count: 1,
          first_seen: ago(95),
          last_seen: ago(95),
        },
        {
          action: "kms:Decrypt",
          role_name: "orders-api-role",
          resource: "arn:aws:kms:us-east-1:123456789012:key/7f3e2a41-9b0c-4d5e-8a1f-2c6b9d0e4f18",
          status: "error",
          pr_url: null,
          seen_count: 2,
          first_seen: ago(1440 + 180),
          last_seen: ago(1440 + 20),
        },
      ],
      updated_at: isoNoMs(now),
    }];
  }

  const DEMO_ROUTES = { "POST /try": demoTry, "POST /check": demoCheck, "GET /feed": demoFeed };

  /* ------------------------------------------------------------------ */
  /* API client                                                          */
  /* ------------------------------------------------------------------ */

  // Returns { status, data } or throws Error with .kind = "network".
  async function api(method, path, body) {
    if (DEMO) {
      await new Promise((r) => setTimeout(r, 280 + Math.random() * 320));
      const [status, data] = await DEMO_ROUTES[method + " " + path](body);
      return { status, data: JSON.parse(JSON.stringify(data)) };
    }
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      const err = new Error("network");
      err.kind = "network";
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  }

  function apiErrorMessage(e, res) {
    if (e && e.kind === "network") return "Could not reach the WhyDenied API. Check your connection and try again.";
    if (res && res.data && typeof res.data.error === "string") return res.data.error;
    if (res) return "The WhyDenied API returned an unexpected response (HTTP " + res.status + ").";
    return "Something went wrong. Try again.";
  }

  function setBusy(btn, busy) {
    btn.setAttribute("aria-busy", busy ? "true" : "false");
    btn.disabled = !!busy;
  }

  /* ------------------------------------------------------------------ */
  /* Architecture: stages and artefacts                                  */
  /* ------------------------------------------------------------------ */

  const EVT = {
    role: "whydenied-test-denied",
    roleArn: "arn:aws:iam::123456789012:role/whydenied-test-denied",
    sessionArn: "arn:aws:sts::123456789012:assumed-role/whydenied-test-denied/botocore-session-1789727017",
    resource: "arn:aws:sqs:us-east-1:123456789012:wd-test",
    id: "ced4c3605fda0eba",
    file: "infra/whydenied_sqs_createqueue_ced4c3.tf",
    time: "2026-09-18T10:24:06Z",
    msg: "User: arn:aws:sts::123456789012:assumed-role/whydenied-test-denied/botocore-session-1789727017 is not authorized to perform: sqs:createqueue on resource: arn:aws:sqs:us-east-1:123456789012:wd-test because no identity-based policy allows the sqs:createqueue action",
  };

  const FIX_HCL = [
    "# Generated by WhyDenied. Review before merging.",
    "#",
    "# " + EVT.roleArn,
    "# was denied sqs:CreateQueue",
    "# on " + EVT.resource,
    "# because no identity-based policy allowed it.",
    "# First seen " + EVT.time + ".",
    "",
    'resource "aws_iam_role_policy" "whydenied_sqs_createqueue_ced4c3" {',
    '  name = "whydenied_sqs_createqueue_ced4c3"',
    "  role = aws_iam_role.test_denied.name",
    "",
    "  policy = jsonencode({",
    '    Version = "2012-10-17"',
    "    Statement = [{",
    '      Effect   = "Allow"',
    '      Action   = "sqs:CreateQueue"',
    '      Resource = "' + EVT.resource + '"',
    "    }]",
    "  })",
    "}",
    "",
  ].join("\n");

  const AI_NOTES = {
    summary: "The workload tried to create the SQS queue wd-test and failed because its role has no policy that allows sqs:CreateQueue.",
    looks_expected: true,
    risk: "low",
    risk_reason: "CreateQueue on one named queue cannot read, change or delete any existing data.",
    reviewer_tip: "Confirm the workload is meant to create this queue at runtime rather than rely on Terraform to create it.",
  };

  function stageNotes(items) {
    return h("ol", { class: "notes" }, items.map((t) => h("li", null, h("span", null, t))));
  }

  function aiCard() {
    return h("div", { class: "memo" },
      h("div", { class: "memo__head" },
        h("span", { text: "Review memo, AI assisted" }),
        stamp("outline", "Risk " + AI_NOTES.risk, "stamp--flat")),
      h("p", { class: "memo__summary", text: AI_NOTES.summary }),
      h("dl", { class: "kv" },
        h("div", { class: "kv__row" }, h("dt", { text: "Looks expected" }), h("dd", { text: AI_NOTES.looks_expected ? "Yes, fits what the role is for" : "No, check this carefully" })),
        h("div", { class: "kv__row" }, h("dt", { text: "Risk" }), h("dd", { text: AI_NOTES.risk_reason })),
        h("div", { class: "kv__row" }, h("dt", { text: "Check first" }), h("dd", { text: AI_NOTES.reviewer_tip }))),
      h("p", { class: "memo__foot", text: "Written by the model from the error and the Terraform. The model returns JSON, which is validated, trimmed to plain text and stripped of links and markup. It never sees or edits the fix." }));
  }

  function slackCard() {
    return h("div", { class: "chat" },
      h("div", { class: "chat__avatar", "aria-hidden": "true", text: "W" }),
      h("div", null,
        h("div", { class: "chat__meta" }, h("strong", { text: "WhyDenied" }), "app, 10:24"),
        h("div", { class: "chat__msg" },
          h("p", { class: "chat__title", text: "AccessDenied: sqs:CreateQueue" }),
          h("div", { class: "chat__fields" },
            h("div", { class: "chat__field" }, h("strong", { text: "Role" }), h("code", { text: EVT.role })),
            h("div", { class: "chat__field" }, h("strong", { text: "Status" }), h("span", { text: "Fix PR opened" }))),
          h("div", { class: "chat__field" }, h("strong", { text: "Resource" }), h("code", { text: EVT.resource })),
          h("a", { class: "btn btn--sm", href: EXAMPLE_PR, rel: "noopener", text: "Review fix PR" }))));
  }

  function prCard() {
    const section = (title, ...body) => h("div", { class: "pr__section" }, h("h5", { text: title }), ...body);
    return h("article", { class: "pr" },
      stamp("outline", "PR open", "stamp--corner"),
      h("header", { class: "pr__head" },
        h("h4", { class: "pr__title" }, "WhyDenied: allow sqs:CreateQueue for " + EVT.role + " ", h("span", { class: "muted", text: "#1" })),
        h("div", { class: "pr__sub" },
          h("span", null, h("strong", { text: "whydenied-bot" }), " wants to merge 1 commit into ", h("code", { text: "main" }), " from ", h("code", { text: "whydenied/" + EVT.id })))),
      h("div", { class: "pr__body" },
        section("What happened",
          h("p", null, h("code", { text: EVT.roleArn }), " was denied ", h("strong", null, h("code", { text: "sqs:CreateQueue" })), " on ", h("code", { text: EVT.resource }), "."),
          h("p", { class: "muted" }, "AWS said: ", h("em", { text: "because no identity-based policy allows the sqs:createqueue action" }), ". First seen " + EVT.time + " in ", h("code", { text: "us-east-1" }), ".")),
        section("The fix",
          h("p", null, "Adds ", h("code", { text: EVT.file }), ", an inline policy on ", h("code", { text: "aws_iam_role.test_denied" }), " that allows ", h("strong", { text: "only" }), " sqs:CreateQueue on ", h("strong", { text: "only" }), " that resource. Nothing else about the role changes.")),
        section("AI review",
          h("p", { text: AI_NOTES.summary }),
          h("ul", null,
            h("li", null, h("strong", { text: "Looks like normal use of this role: " }), "yes"),
            h("li", null, h("strong", { text: "Risk if granted: " }), "low. " + AI_NOTES.risk_reason),
            h("li", null, h("strong", { text: "Check before merging: " }), AI_NOTES.reviewer_tip))),
        section("Before merging",
          h("ul", { class: "pr__tasks" },
            h("li", null, h("span", { class: "pr__box", "aria-hidden": "true" }), "The role should be able to do this. If not, close this PR and fix the caller instead."),
            h("li", null, h("span", { class: "pr__box", "aria-hidden": "true" }), "Run ", h("code", { text: "terraform plan" }), " and check the only change is this one policy.")))),
      h("footer", { class: "pr__foot" },
        h("span", { text: "Approval required. Merging is blocked until a reviewer approves." }),
        h("a", { href: EXAMPLE_PR, rel: "noopener", text: "See a real WhyDenied PR" })));
  }

  const STAGES = [
    {
      id: "workload", kicker: "Stage 1", title: "The workload is denied",
      desc: "A Lambda function, container, CI job or script calls AWS and gets AccessDenied. The call fails and nothing else happens yet.",
      render: () => codeBlock({ name: "terminal", lang: "term", nameIcon: false, code: "$ aws sqs create-queue --queue-name wd-test\n!An error occurred (AccessDenied) when calling the CreateQueue operation:\n!" + EVT.msg }),
    },
    {
      id: "cloudtrail", kicker: "Stage 2", title: "CloudTrail records the denied call",
      desc: "CloudTrail logs every management API call, including failures, with the caller identity, action, resource and AWS's reason. This excerpt is a real captured event.",
      render: () => codeBlock({
        name: "tests/events/sqs_create_queue_denied.json (excerpt)", lang: "json",
        code: JSON.stringify({
          "detail-type": "AWS API Call via CloudTrail",
          source: "aws.sqs",
          detail: {
            userIdentity: {
              type: "AssumedRole",
              arn: EVT.sessionArn,
              sessionContext: { sessionIssuer: { type: "Role", arn: EVT.roleArn } },
            },
            eventTime: EVT.time,
            eventSource: "sqs.amazonaws.com",
            eventName: "CreateQueue",
            awsRegion: "us-east-1",
            errorCode: "AccessDenied",
            errorMessage: EVT.msg,
            readOnly: false,
            resources: [{ type: "AWS::SQS::Queue", ARN: EVT.resource }],
          },
        }, null, 2),
      }),
    },
    {
      id: "eventbridge", kicker: "Stage 3", title: "An EventBridge rule matches denials",
      desc: "One rule forwards every AccessDenied and UnauthorizedOperation event to the analyzer. It is enabled with ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS so read-only calls such as List and Describe are included too.",
      render: () => codeBlock({
        name: "template.yaml: DenialRule.EventPattern", lang: "json",
        code: JSON.stringify({
          "detail-type": ["AWS API Call via CloudTrail"],
          detail: { errorCode: [{ prefix: "AccessDenied" }, "UnauthorizedOperation", "Client.UnauthorizedOperation"] },
        }, null, 2),
      }),
    },
    {
      id: "analyzer", kicker: "Stage 4", title: "The analyzer parses the denial",
      desc: "Pure code, no AI. It resolves the temporary session to the IAM role, fixes the action's casing and classifies AWS's reason. Only missing identity-policy Allows continue to a fix.",
      render: () => [
        codeBlock({
          name: "parse_denial(event)", lang: "json",
          code: JSON.stringify({
            id: EVT.id, principal_arn: EVT.roleArn, action: "sqs:CreateQueue", resource: EVT.resource,
            reason: "missing_identity_allow", error_code: "AccessDenied", read_only: false, region: "us-east-1", event_time: EVT.time,
          }, null, 2),
        }),
        stageNotes([
          "Session ARN assumed-role/whydenied-test-denied/botocore-session-... becomes role/whydenied-test-denied.",
          "The lower-case sqs:createqueue in the message is corrected to sqs:CreateQueue from eventSource and eventName.",
          "id is a fingerprint of (role, action, resource), so repeats are counted, not reopened.",
        ]),
      ],
    },
    {
      id: "dynamodb", kicker: "State", title: "Stored once, counted every time",
      desc: "Each (role, action, resource) is one item in the whydenied-denials table. Only the first occurrence triggers a fix; later ones increment the count.",
      render: () => codeBlock({
        name: "whydenied-denials item", lang: "json",
        code: JSON.stringify({
          id: EVT.id, principal_arn: EVT.roleArn, action: "sqs:CreateQueue", resource: EVT.resource,
          status: "pr_open", pr_url: "https://github.com/<owner>/<repo>/pull/1", seen_count: 1,
          first_seen: EVT.time, last_seen: EVT.time,
        }, null, 2),
      }),
    },
    {
      id: "github", kicker: "Stage 5", title: "The exact fix, as Terraform",
      desc: "WhyDenied finds the aws_iam_role with name = \"whydenied-test-denied\" in your repository and writes one inline policy next to it, on a new branch.",
      render: () => codeBlock({ kind: "Listing", name: EVT.file, lang: "hcl", code: FIX_HCL, marks: ['"sqs:CreateQueue"'] }),
    },
    {
      id: "ai", kicker: "Optional", title: "AI review notes for the reviewer",
      desc: "OpenAI or Amazon Bedrock reads the denial and the role's Terraform and helps the reviewer decide. It writes notes only; the fix is already fixed in code.",
      render: aiCard,
    },
    {
      id: "notify", kicker: "Optional", title: "An alert reaches the team",
      desc: "Slack and Discord webhooks get the action, role, resource and a link to the pull request.",
      render: slackCard,
    },
    {
      id: "review", kicker: "Stage 6", title: "A human reviews and merges",
      desc: "The pull request explains what happened, what the fix grants and what to check. Nothing reaches IAM until someone merges it.",
      render: prCard,
    },
    {
      id: "apply", kicker: "Stage 7", title: "terraform apply, as usual",
      desc: "Your normal pipeline applies the merged change. The plan shows exactly one new policy and nothing else.",
      render: () => codeBlock({
        name: "terraform plan", lang: "plan", nameIcon: false,
        code: [
          "$ terraform plan",
          "",
          "  # aws_iam_role_policy.whydenied_sqs_createqueue_ced4c3 will be created",
          '  + resource "aws_iam_role_policy" "whydenied_sqs_createqueue_ced4c3" {',
          '      + id     = (known after apply)',
          '      + name   = "whydenied_sqs_createqueue_ced4c3"',
          '      + policy = jsonencode(',
          "          + {",
          "              + Statement = [",
          "                  + {",
          '                      + Action   = "sqs:CreateQueue"',
          '                      + Effect   = "Allow"',
          '                      + Resource = "' + EVT.resource + '"',
          "                    },",
          "                ]",
          '              + Version   = "2012-10-17"',
          "            }",
          "        )",
          '      + role   = "whydenied-test-denied"',
          "    }",
          "",
          "Plan: 1 to add, 0 to change, 0 to destroy.",
        ].join("\n"),
      }),
    },
    {
      id: "success", kicker: "Stage 8", title: "The role gains one exact permission",
      desc: "The same call now succeeds. The role grew by a single reviewed permission on a single resource, and the change lives in code.",
      render: () => codeBlock({
        name: "terminal", lang: "term", nameIcon: false,
        code: '$ aws sqs create-queue --queue-name wd-test\n{\n    "QueueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/wd-test"\n}',
      }),
    },
  ];

  function initArchitecture() {
    const svg = $("#arch");
    if (!svg) return;
    const scroller = $(".arch-scroll");
    const nodes = Array.from(svg.querySelectorAll(".node"));
    const nodeOf = {};
    nodes.forEach((n) => { nodeOf[n.dataset.stage] = n; });
    const order = STAGES.map((s) => s.id);
    let current = null;

    function select(id, opts) {
      const idx = order.indexOf(id);
      if (idx < 0) return;
      const stage = STAGES[idx];
      current = id;
      nodes.forEach((n) => {
        const on = n.dataset.stage === id;
        n.classList.toggle("is-active", on);
        n.setAttribute("aria-pressed", on ? "true" : "false");
      });
      const kick = clear($("#stage-kicker"));
      append(kick, ["Fig. " + (idx + 2), h("span", { text: stage.kicker })]);
      $("#stage-title").textContent = stage.title;
      $("#stage-desc").textContent = stage.desc;
      $("#stage-count").textContent = (idx + 1) + " / " + order.length;
      const body = clear($("#stage-body"));
      const content = stage.render();
      const wrap = h("div", { class: opts && opts.animate === false ? "" : "stage-fade" }, content);
      append(body, [wrap]);
      if (opts && opts.reveal) revealNode(id);
    }

    function revealNode(id) {
      const n = nodeOf[id];
      if (!n || scroller.scrollWidth <= scroller.clientWidth) return;
      const box = n.getBBox();
      const scale = svg.getBoundingClientRect().width / 1010;
      const center = (box.x + box.width / 2) * scale;
      scroller.scrollTo({ left: Math.max(0, center - scroller.clientWidth / 2), behavior: reducedMotion.matches ? "auto" : "smooth" });
    }

    nodes.forEach((n) => {
      n.addEventListener("click", () => select(n.dataset.stage, {}));
      n.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.dataset.stage, {}); }
      });
    });
    $("#stage-prev").addEventListener("click", () => {
      const i = order.indexOf(current);
      select(order[(i - 1 + order.length) % order.length], { reveal: true });
    });
    $("#stage-next").addEventListener("click", () => {
      const i = order.indexOf(current);
      select(order[(i + 1) % order.length], { reveal: true });
    });

    select("cloudtrail", { animate: false });
    initPulse(svg, nodeOf);
  }

  /* Pulse animation along the flow and around the green return loop. */
  function initPulse(svg, nodeOf) {
    const layer = $("#arch-pulses");
    const toggle = $("#arch-toggle");
    const label = $(".arch-toggle__label", toggle);
    const path = (id) => svg.getElementById ? svg.getElementById(id) : document.getElementById(id);

    const timeline = [];
    let t = 0;
    const light = (stage, tone, start, dur) => timeline.push({ kind: "light", stage, tone, start, dur });
    const pulse = (id, tone, start, dur) => {
      const el = path(id);
      timeline.push({ kind: "pulse", el, len: el.getTotalLength(), tone, start, dur });
    };

    light("workload", "deny", t, 1000);
    t += 350; pulse("e-deny", "deny", t, 600); t += 600;
    light("cloudtrail", "flow", t, 900);
    t += 300; pulse("e-ct", "flow", t, 550); t += 550;
    light("eventbridge", "flow", t, 900);
    t += 300; pulse("e-eb", "flow", t, 550); t += 550;
    light("analyzer", "flow", t, 1500);
    t += 450;
    pulse("e-gh", "flow", t, 800); pulse("e-ai", "flow", t + 120, 800); pulse("e-nt", "flow", t + 240, 800); pulse("e-db", "flow", t, 600);
    light("dynamodb", "flow", t + 600, 900);
    t += 800;
    light("github", "flow", t, 2600);
    light("ai", "flow", t + 120, 900);
    light("notify", "flow", t + 240, 900);
    t += 450;
    const loop = path("e-loop");
    const loopLen = loop.getTotalLength();
    const loopDur = 3900;
    pulse("e-loop", "ok", t, loopDur);
    // Light each pill as the pulse passes its centre on the bottom edge.
    [["review", 854], ["apply", 560], ["success", 288]].forEach(([stage, cx]) => {
      for (let l = 0; l <= loopLen; l += 3) {
        const p = loop.getPointAtLength(l);
        if (p.y > 345 && p.x <= cx) { light(stage, "ok", t + (l / loopLen) * loopDur - 250, 800); break; }
      }
    });
    t += loopDur;
    light("workload", "ok", t - 150, 1500);
    t += 2400;
    const TOTAL = t;

    const LIT = { deny: "is-lit-deny", flow: "is-lit", ok: "is-lit-ok" };
    const pool = [];
    function dot(i) {
      if (!pool[i]) {
        const g = document.createElementNS(SVG_NS, "g");
        const mark = document.createElementNS(SVG_NS, "rect");
        mark.setAttribute("x", "-3.5");
        mark.setAttribute("y", "-3.5");
        mark.setAttribute("width", "7");
        mark.setAttribute("height", "7");
        g.appendChild(mark);
        layer.appendChild(g);
        pool[i] = g;
      }
      return pool[i];
    }

    let raf = 0, start = 0, pausedAt = 0, userPaused = false, visible = true;

    function clearFrame() {
      pool.forEach((g) => g && g.setAttribute("opacity", "0"));
      Object.values(nodeOf).forEach((n) => n.classList.remove("is-lit", "is-lit-deny", "is-lit-ok"));
    }

    function frame(now) {
      const tt = (now - start) % TOTAL;
      const want = {};
      let used = 0;
      for (const ev of timeline) {
        if (tt < ev.start || tt > ev.start + ev.dur) continue;
        if (ev.kind === "light") { want[ev.stage] = LIT[ev.tone]; continue; }
        const p = (tt - ev.start) / ev.dur;
        const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        const pt = ev.el.getPointAtLength((ev.tone === "ok" ? p : eased) * ev.len);
        const g = dot(used++);
        g.setAttribute("class", "pulse pulse--" + ev.tone);
        g.setAttribute("transform", "translate(" + pt.x.toFixed(1) + " " + pt.y.toFixed(1) + ")");
        g.setAttribute("opacity", Math.min(1, p * 8, (1 - p) * 8).toFixed(2));
      }
      for (let i = used; i < pool.length; i++) pool[i].setAttribute("opacity", "0");
      for (const [stage, n] of Object.entries(nodeOf)) {
        for (const cls of ["is-lit", "is-lit-deny", "is-lit-ok"]) {
          const on = want[stage] === cls;
          if (n.classList.contains(cls) !== on) n.classList.toggle(cls, on);
        }
      }
      raf = requestAnimationFrame(frame);
    }

    function shouldRun() {
      return !userPaused && visible && !document.hidden && !reducedMotion.matches;
    }

    function update() {
      if (shouldRun()) {
        if (!raf) {
          start = performance.now() - pausedAt;
          raf = requestAnimationFrame(frame);
        }
      } else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        pausedAt = (performance.now() - start) % TOTAL;
        clearFrame();
      }
      document.documentElement.classList.toggle("reduced-motion", reducedMotion.matches);
    }

    toggle.addEventListener("click", () => {
      userPaused = !userPaused;
      toggle.setAttribute("aria-pressed", userPaused ? "true" : "false");
      label.textContent = userPaused ? "Play animation" : "Pause animation";
      update();
    });
    document.addEventListener("visibilitychange", update);
    if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", update);
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        visible = entries[0].isIntersecting;
        update();
      }, { threshold: 0.15 }).observe(svg);
    }
    update();
  }

  /* ------------------------------------------------------------------ */
  /* Step 1: Try it                                                      */
  /* ------------------------------------------------------------------ */

  const EXAMPLES = [
    {
      label: "Missing permission on a Lambda role",
      text: "[ERROR] AccessDeniedException: An error occurred (AccessDeniedException) when calling the GetParameter operation: User: arn:aws:sts::123456789012:assumed-role/orders-api-role/orders-api is not authorized to perform: ssm:GetParameter on resource: arn:aws:ssm:us-east-1:123456789012:parameter/demo/orders-api/db-url because no identity-based policy allows the ssm:GetParameter action",
    },
    {
      label: "Lower-case action from the CLI",
      text: "An error occurred (AccessDenied) when calling the CreateQueue operation: User: arn:aws:sts::123456789012:assumed-role/whydenied-test-denied/botocore-session-1789727017 is not authorized to perform: sqs:createqueue on resource: arn:aws:sqs:us-east-1:123456789012:wd-test because no identity-based policy allows the sqs:createqueue action",
    },
    {
      label: "Blocked by an SCP, not fixable",
      text: "An error occurred (UnauthorizedOperation) when calling the RunInstances operation: You are not authorized to perform this operation. User: arn:aws:sts::123456789012:assumed-role/ci-deploy-role/github-actions is not authorized to perform: ec2:RunInstances on resource: arn:aws:ec2:us-east-1:123456789012:instance/* with an explicit deny in a service control policy",
    },
  ];

  function initTry() {
    const form = $("#try-form");
    const input = $("#try-input");
    const count = $("#try-count");
    const submit = $("#try-submit");
    const exBtn = $("#try-example");
    const exLabel = $("#try-example-label");
    const out = $("#try-result");
    let exIdx = 0;
    let seq = 0;

    const updateCount = () => {
      const n = input.value.length;
      count.textContent = n + " / 4000";
      count.classList.toggle("is-over", n > 4000);
    };
    input.addEventListener("input", () => { updateCount(); input.removeAttribute("aria-invalid"); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
    });

    exBtn.addEventListener("click", () => {
      const ex = EXAMPLES[exIdx % EXAMPLES.length];
      input.value = ex.text;
      updateCount();
      exLabel.textContent = "Example " + ((exIdx % EXAMPLES.length) + 1) + " of " + EXAMPLES.length + ": " + ex.label;
      exIdx++;
      exBtn.textContent = "Try another example";
      form.requestSubmit();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) {
        input.setAttribute("aria-invalid", "true");
        clear(out).appendChild(callout("error", h("p", { text: "Paste an AccessDenied error first, or use an example." })));
        input.focus();
        return;
      }
      if (text.length > 4000) {
        input.setAttribute("aria-invalid", "true");
        clear(out).appendChild(callout("error", h("p", { text: "The message is longer than 4000 characters. Paste only the error." })));
        return;
      }
      const my = ++seq;
      setBusy(submit, true);
      let res = null;
      try {
        res = await api("POST", "/try", { error: text });
        if (my !== seq) return;
        if (res.status === 200 && res.data && res.data.denial) renderTry(out, res.data);
        else clear(out).appendChild(callout("error", h("p", { text: apiErrorMessage(null, res) })));
      } catch (err) {
        if (my === seq) clear(out).appendChild(callout("error", h("p", { text: apiErrorMessage(err, res) })));
      } finally {
        if (my === seq) setBusy(submit, false);
      }
    });
  }

  const TYPE_LABEL = { role: "IAM role", user: "IAM user", root: "Root user", unknown: "Unknown" };

  function renderTry(out, data) {
    const d = data.denial || {};
    const fixable = data.fixable === true && data.fix && typeof data.fix.hcl === "string";
    const val = (v) => (v == null || v === "" ? "Not found" : String(v));

    const row = (k, v, sub, mono) => h("div", { class: "kv__row" },
      h("dt", { text: k }),
      h("dd", { class: mono ? "mono" : null }, val(v), sub ? h("span", { class: "sub", text: sub }) : null));

    const denialPanel = h("section", { class: "panel", "aria-label": "Parsed denial" },
      h("div", { class: "panel__head" }, h("span", null, h("b", { text: "Table 1" }), "Parsed denial"), h("span", { text: TYPE_LABEL[d.principal_type] || val(d.principal_type) })),
      h("dl", { class: "kv" },
        row("Role", d.role_name || (d.principal_type === "role" ? null : "Not a role"), d.principal_arn || null, true),
        row("Action", d.action, null, true),
        row("Resource", d.resource, null, true),
        row("Reason", d.reason_text || d.reason, d.reason && d.reason_text ? d.reason : null)));

    let fixPanel;
    if (fixable) {
      fixPanel = codeBlock({ kind: "Listing 1", name: String(data.fix.filename || "fix.tf"), lang: "hcl", code: data.fix.hcl, label: "Generated Terraform fix", marks: ['"' + String(d.action || "") + '"'] });
    } else {
      fixPanel = h("section", { class: "panel", "aria-label": "No automatic fix" },
        h("div", { class: "panel__head" }, h("span", null, h("b", { text: "Listing 1" }), "Terraform fix")),
        h("div", { class: "empty-fix" },
          h("strong", { text: "No automatic fix" }),
          h("span", { text: "WhyDenied records this denial and alerts a human instead of opening a pull request." })));
    }

    const head = h("div", { class: "result__head" },
      fixable ? stamp("outline", "Fixable", "stamp--lg stamp--thunk") : stamp("dashed", "Needs human", "stamp--lg stamp--thunk"),
      h("span", { class: "result__note", text: fixable ? "WhyDenied would open a pull request with the listing below." : "WhyDenied would record this and alert a human." }),
      sampleTag());

    const nodes = [head, h("div", { class: "try-grid" }, denialPanel, fixPanel)];
    if (data.note) nodes.push(callout(fixable ? "info" : "warn", h("p", { text: String(data.note) })));
    clear(out);
    append(out, nodes);
  }

  /* ------------------------------------------------------------------ */
  /* Step 2: Check your Terraform                                        */
  /* ------------------------------------------------------------------ */

  function parseRepo(input) {
    let s = String(input || "").trim();
    if (!s) return null;
    s = s.replace(/^git@github\.com:/i, "")
      .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
    const parts = s.split("/");
    if (parts.length < 2) return null;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return null;
    return { owner, name, full: owner + "/" + name };
  }

  class GitHubError extends Error {}

  async function ghJSON(url) {
    let res;
    try {
      res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    } catch (e) {
      throw new GitHubError("Could not reach GitHub. Check your connection and try again.");
    }
    if (res.ok) return res.json();
    const remaining = res.headers.get("x-ratelimit-remaining");
    if ((res.status === 403 || res.status === 429) && (remaining === "0" || res.status === 429)) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const when = reset ? " Try again after " + new Date(reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + "." : " Try again later.";
      throw new GitHubError("GitHub's limit for anonymous API requests (60 an hour per IP address) has been reached." + when);
    }
    if (res.status === 404) throw new GitHubError("Repository not found. It may be private or misspelled; only public repositories can be checked from this page.");
    if (res.status === 409) throw new GitHubError("This repository is empty.");
    if (res.status === 451) throw new GitHubError("This repository is unavailable for legal reasons.");
    throw new GitHubError("GitHub returned an error (HTTP " + res.status + "). Try again in a moment.");
  }

  const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  const checkState = { lastRepo: null };

  function initCheck(onRepoChecked) {
    const form = $("#check-form");
    const input = $("#check-input");
    const submit = $("#check-submit");
    const progress = $("#check-progress");
    const out = $("#check-result");
    let seq = 0;

    $("#check-demo").addEventListener("click", () => {
      input.value = DEMO_REPO;
      input.removeAttribute("aria-invalid");
      form.requestSubmit();
    });
    input.addEventListener("input", () => input.removeAttribute("aria-invalid"));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const repo = parseRepo(input.value);
      if (!repo) {
        input.setAttribute("aria-invalid", "true");
        clear(out).appendChild(callout("error", h("p", { text: "Enter a repository as owner/name, for example " + DEMO_REPO + ", or paste its GitHub URL." })));
        input.focus();
        return;
      }
      input.value = repo.full;
      const my = ++seq;
      const alive = () => my === seq;
      setBusy(submit, true);
      clear(out);
      const say = (t) => { if (alive()) progress.textContent = t; };

      try {
        say("Looking up " + repo.full + "...");
        const base = "https://api.github.com/repos/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.name);
        const meta = await ghJSON(base);
        if (!alive()) return;
        const branch = String(meta.default_branch || "main");
        say("Reading the file tree of " + branch + "...");
        const tree = await ghJSON(base + "/git/trees/" + encPath(branch) + "?recursive=1");
        if (!alive()) return;

        const all = (tree.tree || []).filter((n) => n.type === "blob" && /\.tf$/i.test(n.path) && !/(^|\/)\.terraform\//.test(n.path));
        all.sort((a, b) => a.path.localeCompare(b.path));
        const notes = [];
        if (tree.truncated) notes.push("The repository is too large for GitHub to list in one request, so some files may be missing.");
        if (!all.length) {
          say("");
          clear(out).appendChild(callout("warn",
            h("p", null, h("strong", { text: "No .tf files found" }), " on the ", h("code", { text: branch }), " branch of ", repoLink(repo), "."),
            h("p", { text: "WhyDenied needs the IAM roles it fixes to be defined in Terraform in this repository." })));
          return;
        }
        let files = all;
        if (files.length > 200) {
          notes.push("Checked the first 200 of " + all.length + " .tf files.");
          files = files.slice(0, 200);
        }

        let done = 0;
        say("Reading " + files.length + " Terraform " + (files.length === 1 ? "file" : "files") + "...");
        const raw = "https://raw.githubusercontent.com/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.name) + "/" + encPath(branch) + "/";
        const contents = await mapLimit(files, 8, async (f) => {
          let text = null;
          try {
            const r = await fetch(raw + encPath(f.path));
            if (r.ok) text = await r.text();
          } catch (_) { text = null; }
          done++;
          say("Reading Terraform files " + done + " / " + files.length + "...");
          return text;
        });
        if (!alive()) return;

        const payload = {};
        let total = 0, skipped = 0, failed = 0;
        files.forEach((f, i) => {
          const text = contents[i];
          if (text == null) { failed++; return; }
          if (total + text.length > 950000) { skipped++; return; }
          payload[f.path] = text;
          total += text.length;
        });
        if (failed) notes.push(failed + (failed === 1 ? " file" : " files") + " could not be downloaded and were skipped.");
        if (skipped) notes.push(skipped + (skipped === 1 ? " file was" : " files were") + " skipped to stay under the 1 MB limit.");

        say("Matching roles...");
        const res = await api("POST", "/check", { files: payload });
        if (!alive()) return;
        say("");
        if (res.status !== 200 || !res.data || !Array.isArray(res.data.roles)) {
          clear(out).appendChild(callout("error", h("p", { text: apiErrorMessage(null, res) })));
          return;
        }
        renderCheck(out, repo, branch, Object.keys(payload).length, res.data, notes);
        checkState.lastRepo = repo.full;
        onRepoChecked(repo.full);
      } catch (err) {
        if (!alive()) return;
        say("");
        const msg = err instanceof GitHubError ? err.message : apiErrorMessage(err, null);
        clear(out).appendChild(callout("error", h("p", { text: msg })));
      } finally {
        if (alive()) setBusy(submit, false);
      }
    });
  }

  function repoLink(repo) {
    return h("a", { href: "https://github.com/" + repo.full, rel: "noopener", text: repo.full });
  }

  function renderCheck(out, repo, branch, fileCount, data, notes) {
    const roles = data.roles;
    const total = data.summary && Number.isFinite(data.summary.total) ? data.summary.total : roles.length;
    const ready = data.summary && Number.isFinite(data.summary.ready) ? data.summary.ready : roles.filter((r) => r.ready).length;
    const nodes = [];

    const fill = h("div", { class: "meter__fill" });
    fill.style.width = total ? Math.round((ready / total) * 100) + "%" : "0%";
    nodes.push(h("div", { class: "summary" },
      h("div", null,
        h("div", { class: "summary__num" }, ready + "/" + total),
        h("div", { class: "summary__label" }, (total === 1 ? "role" : "roles") + " ready in ", repoLink(repo), " (" + fileCount + (fileCount === 1 ? " file" : " files") + ", " + branch + ")")),
      h("div", { class: "meter", role: "meter", "aria-valuemin": "0", "aria-valuemax": String(total || 0), "aria-valuenow": String(ready), "aria-label": "Roles ready" }, fill),
      sampleTag()));

    if (!roles.length) {
      nodes.push(callout("warn",
        h("p", null, h("strong", { text: "No aws_iam_role resources found." }), " WhyDenied opens fixes against the repository that defines your roles. Point it at the repository with your ", h("code", { text: "aws_iam_role" }), " resources, or add them here.")));
    } else {
      const list = h("ol", { class: "roles" });
      let n = 0;
      for (const r of roles) {
        const ok = r.ready === true;
        const pathLink = r.path
          ? h("a", { href: "https://github.com/" + repo.full + "/blob/" + encPath(branch) + "/" + encPath(String(r.path)), rel: "noopener", text: String(r.path) })
          : null;
        list.appendChild(h("li", { class: "role" },
          h("span", { class: "role__no", text: "R" + (++n) }),
          h("div", { class: "role__main" },
            r.name ? h("div", { class: "role__name", text: String(r.name) }) : h("div", { class: "role__name is-null", text: "No explicit name" }),
            h("div", { class: "role__meta" }, String(r.address || ""), pathLink ? " in " : null, pathLink),
            !ok && r.issue ? h("p", { class: "role__issue", text: String(r.issue) }) : null),
          ok ? stamp("outline", "Ready") : stamp("dashed", "Needs change")));
      }
      nodes.push(list);
      if (ready === total) nodes.push(callout("ok", h("p", { text: "Every role can be matched. WhyDenied can open fixes for all of them." })));
      else if (ready === 0) nodes.push(callout("warn", h("p", { text: "No role can be matched yet. Give each role a literal name = \"...\" and WhyDenied can fix it." })));
    }
    if (notes.length) nodes.push(callout("info", notes.map((n) => h("p", { text: n }))));
    clear(out);
    append(out, nodes);
  }

  /* ------------------------------------------------------------------ */
  /* Step 3: Deploy                                                      */
  /* ------------------------------------------------------------------ */

  function initDeploy() {
    const form = $("#deploy-form");
    const repoIn = $("#deploy-repo");
    const launch = $("#launch-btn");
    const note = $("#launch-note");
    let userEdited = false;

    repoIn.addEventListener("input", () => { userEdited = true; update(); });
    form.addEventListener("change", update);
    form.addEventListener("submit", (e) => e.preventDefault());

    function update() {
      const repo = parseRepo(repoIn.value);
      const provider = (form.querySelector('input[name="provider"]:checked') || {}).value || "openai";
      const slack = $("#deploy-slack").checked;
      const discord = $("#deploy-discord").checked;
      const repoText = repo ? repo.full : "<owner>/<terraform-repo>";
      repoIn.setAttribute("aria-invalid", repoIn.value.trim() && !repo ? "true" : "false");

      $("#provider-help").textContent = {
        openai: "Uses gpt-5-mini with a key you store in SSM. The model writes review notes only; the fix is generated by code.",
        bedrock: "Uses Claude Haiku 4.5 on Amazon Bedrock through the stack's IAM role, so there is no key to store. Enable model access in the Bedrock console first.",
        none: "Pull requests are opened without AI review notes.",
      }[provider];

      if (!TEMPLATE_URL) {
        disable("Not available on this copy of the page: no template URL is configured. Use the SAM CLI below.");
      } else if (!repo) {
        disable(repoIn.value.trim() ? "Enter the repository as owner/name." : "Enter your Terraform repository to continue.");
      } else {
        launch.setAttribute("href",
          "https://console.aws.amazon.com/cloudformation/home?region=" + REGION + "#/stacks/quickcreate" +
          "?templateURL=" + encodeURIComponent(TEMPLATE_URL) +
          "&stackName=whydenied" +
          "&param_GitHubRepo=" + encodeURIComponent(repo.full) +
          "&param_AIProvider=" + encodeURIComponent(provider));
        launch.removeAttribute("aria-disabled");
        launch.removeAttribute("tabindex");
        launch.setAttribute("target", "_blank");
        note.textContent = "Stack whydenied in " + REGION + ", opens in a new tab.";
      }

      const lines = [
        "# Required: lets WhyDenied open pull requests on " + repoText,
        "aws ssm put-parameter --region " + REGION + " --type SecureString \\",
        "  --name /whydenied/github-token --value '<github-token>'",
      ];
      if (provider === "openai") {
        lines.push("", "# AI review notes via OpenAI",
          "aws ssm put-parameter --region " + REGION + " --type SecureString \\",
          "  --name /whydenied/openai-api-key --value '<openai-api-key>'");
      }
      if (slack) {
        lines.push("", "# Slack alerts",
          "aws ssm put-parameter --region " + REGION + " --type SecureString \\",
          "  --name /whydenied/slack-webhook --value '<slack-webhook-url>'");
      }
      if (discord) {
        lines.push("", "# Discord alerts",
          "aws ssm put-parameter --region " + REGION + " --type SecureString \\",
          "  --name /whydenied/discord-webhook --value '<discord-webhook-url>'");
      }
      const count = lines.filter((l) => l.startsWith("aws ")).length;
      fillCode($("#ssm-code"), { name: count + (count === 1 ? " parameter" : " parameters") + " in " + REGION, lang: "shell", code: lines.join("\n"), nameIcon: false, label: "SSM commands" });

      fillCode($("#sam-code"), {
        name: "SAM CLI", lang: "shell", nameIcon: false, label: "SAM CLI commands",
        code: [
          "git clone https://github.com/tusharkhatriofficial/whydenied.git",
          "cd whydenied",
          "sam build",
          "sam deploy --guided --region " + REGION + " \\",
          "  --parameter-overrides GitHubRepo=" + repoText + " AIProvider=" + provider,
        ].join("\n"),
      });
    }

    function disable(msg) {
      launch.removeAttribute("href");
      launch.removeAttribute("target");
      launch.setAttribute("aria-disabled", "true");
      launch.setAttribute("role", "link");
      launch.setAttribute("tabindex", "0");
      note.textContent = msg;
    }
    launch.addEventListener("click", (e) => {
      if (launch.getAttribute("aria-disabled") === "true") e.preventDefault();
    });

    update();
    return {
      prefill(full) {
        if (userEdited && repoIn.value.trim()) return;
        repoIn.value = full;
        update();
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Live feed                                                           */
  /* ------------------------------------------------------------------ */

  // Status is carried by the stamp's form and word, never by colour alone.
  const STATUS = {
    pr_open: ["outline", "PR open"],
    needs_human: ["dashed", "Needs human"],
    role_not_found: ["dashed", "Role not found"],
    not_a_role: ["dotted", "Not a role"],
    error: ["double", "Error"],
  };

  function initFeed() {
    const box = $("#feed");
    const state = $("#feed-state");
    const stateText = $("#feed-state-text");
    const updated = $("#feed-updated");
    const refresh = $("#feed-refresh");
    let lastOk = 0;
    let seen = null;
    let timer = 0;
    let loading = false;
    let hasData = false;

    box.appendChild(h("div", { class: "skeleton", "aria-hidden": "true" }, [0, 1, 2, 3].map(() => h("div", { class: "skeleton__row" }))));

    function setState(kind, text) {
      state.className = "feed-status__state is-" + kind;
      stateText.textContent = text;
    }

    function tickTimes() {
      const now = Date.now();
      box.querySelectorAll("time[data-ts]").forEach((t) => { t.textContent = relTime(Number(t.dataset.ts), now); });
      if (lastOk) updated.textContent = "Updated " + relTime(lastOk, now);
    }

    async function load() {
      if (loading) return;
      loading = true;
      setBusy(refresh, true);
      box.setAttribute("aria-busy", "true");
      try {
        const res = await api("GET", "/feed");
        if (res.status !== 200 || !res.data || !Array.isArray(res.data.denials)) throw Object.assign(new Error("bad"), { res });
        lastOk = Date.now();
        render(res.data.denials);
        setState(DEMO ? "demo" : "live", DEMO ? "Sample data" : "Live");
        if (res.data.updated_at) updated.title = "Server time " + String(res.data.updated_at);
      } catch (err) {
        setState("error", "Offline");
        if (!hasData) {
          clear(box).appendChild(h("div", { class: "feed-empty" },
            h("strong", { text: "The feed is unavailable right now" }),
            h("span", { text: apiErrorMessage(err.kind ? err : null, err.res || null) + " It retries every 15 seconds." })));
        }
      } finally {
        loading = false;
        setBusy(refresh, false);
        box.setAttribute("aria-busy", "false");
        tickTimes();
      }
    }

    function render(list) {
      hasData = true;
      const now = Date.now();
      const keyOf = (d) => [d.role_name, d.action, d.resource].join("|");
      const fresh = new Set();
      if (seen) list.forEach((d) => { if (!seen.has(keyOf(d))) fresh.add(keyOf(d)); });
      seen = new Set(list.map(keyOf));

      if (!list.length) {
        clear(box).appendChild(h("div", { class: "feed-empty" },
          h("strong", { text: "No denials yet" }),
          h("span", { text: "When a role in the demo account is denied, it appears here within a minute." })));
        return;
      }

      const tbody = h("tbody");
      for (const d of list.slice(0, 20)) {
        const [kind, text] = STATUS[d.status] || ["dotted", String(d.status || "unknown")];
        const last = parseTime(d.last_seen);
        const first = parseTime(d.first_seen);
        let pr = h("span", { class: "feed__none", text: "No PR" });
        if (d.pr_url && /^https:\/\/github\.com\//.test(String(d.pr_url))) {
          const num = /\/pull\/(\d+)/.exec(String(d.pr_url));
          pr = h("a", { class: "feed__pr", href: String(d.pr_url), rel: "noopener" }, num ? "#" + num[1] : "View PR", h("span", { "aria-hidden": "true", text: " \u2197" }));
        }
        const seenN = Number(d.seen_count) || 0;
        const isNew = fresh.has(keyOf(d));
        tbody.appendChild(h("tr", { class: isNew ? "is-new" : null },
          h("td", { "data-col": "what" },
            h("span", { class: "feed__action", text: String(d.action || "unknown") }),
            isNew ? stamp("solid", "New", "stamp--new stamp--thunk") : null,
            h("span", { class: "feed__resource", title: String(d.resource || ""), text: String(d.resource || "") })),
          h("td", { "data-col": "role" }, h("span", { class: "feed__role", text: String(d.role_name || "") })),
          h("td", { "data-col": "status" }, stamp(kind, text)),
          h("td", { "data-col": "seen", class: "feed__num num" }, seenN + (seenN === 1 ? " time" : " times")),
          h("td", { "data-col": "time", class: "feed__time" },
            last != null ? h("time", { datetime: new Date(last).toISOString(), "data-ts": String(last), title: (first != null ? "First seen " + new Date(first).toLocaleString() + ". " : "") + "Last seen " + new Date(last).toLocaleString() }, relTime(last, now)) : "unknown"),
          h("td", { "data-col": "pr" }, pr)));
      }
      clear(box).appendChild(h("table", { class: "feed-table" },
        h("caption", { class: "visually-hidden", text: "Recent denials in the demo account, newest first" }),
        h("thead", null, h("tr", null,
          ["Denied action", "Role", "Status", "Seen", "Last seen", "Pull request"].map((c) => h("th", { scope: "col", class: c === "Seen" ? "num" : null, text: c })))),
        tbody));
    }

    function schedule() {
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden) load(); }, 15000);
    }

    refresh.addEventListener("click", () => { load(); schedule(); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - lastOk > 15000) load(); });
    setInterval(tickTimes, 5000);
    load();
    schedule();
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  function boot() {
    if (DEMO) $("#demo-banner").hidden = false;
    initArchitecture();
    initTry();
    const deploy = initDeploy();
    initCheck((full) => deploy.prefill(full));
    initFeed();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
