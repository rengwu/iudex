// PRD requirement parser + lint — a faithful port of the deleted Go package
// `internal/spec`. Parsing a PRD's structure is a document-display concern, not
// state-machine logic (the "never reimplement Derive" invariant does not apply),
// so it lives in the GUI. The raw markdown stays ground truth; the parser never
// throws. Id minting is NOT here — it moved into the to-prd skill as an explicit
// grep-derived numbering pass (file-scoped max+1, append-only).
import type { PRD, Requirement, SpecDoc } from "../types";
import * as api from "./api";

export type LintWarning = { line: number; message: string };

// Any ATX heading, capturing the hashes and the text.
const headingRe = /^(#{1,6})\s+(.*)$/;
// A well-formed requirement heading's text: REQ-<n|?>: title.
const reqRe = /^REQ-(\d+|\?):\s*(.*\S.*)$/;
// A metadata line directly under a heading: "> key: value".
const metaRe = /^>\s*([A-Za-z][\w-]*):\s*(.*)$/;

const validStatus = new Set(["active", "parked", "out-of-scope"]);

// Normalize CRLF and split into lines (strip a trailing \r from each).
function splitLines(content: string): string[] {
  return content.split("\n").map((l) => l.replace(/\r$/, ""));
}

// Parse one PRD file's content. `file` is the basename, recorded on the PRD.
// Unrecognized content is preserved as requirement bodies or ignored prose;
// parsing never fails, so the raw markdown stays ground truth.
export function parsePrd(file: string, content: string): PRD {
  const lines = splitLines(content);
  const prd: PRD = { file, title: "", requirements: [] };

  let i = 0;
  while (i < lines.length) {
    const h = headingRe.exec(lines[i]);
    if (h === null) {
      i++;
      continue;
    }
    const level = h[1].length;
    const text = h[2].trim();
    if (level === 1 && prd.title === "") {
      prd.title = text;
    }
    const m = reqRe.exec(text);
    if (m === null) {
      i++;
      continue;
    }

    const req: Requirement = {
      id: "REQ-" + m[1],
      title: m[2].trim(),
      status: "active",
      body: "",
    };
    i++;

    // Metadata lines directly under the heading, until the first non-meta line.
    for (; i < lines.length; i++) {
      const mm = metaRe.exec(lines[i]);
      if (mm === null) break;
      if (mm[1].toLowerCase() === "status") {
        req.status = mm[2].trim();
      }
    }

    // Body runs until the next requirement heading or a same-or-shallower
    // section heading; deeper non-requirement headings stay part of the body.
    const body: string[] = [];
    for (; i < lines.length; i++) {
      const hl = headingRe.exec(lines[i]);
      if (hl !== null) {
        const htext = hl[2].trim();
        if (reqRe.test(htext) || hl[1].length <= level) break;
      }
      body.push(lines[i]);
    }
    req.body = body.join("\n").trim();
    prd.requirements.push(req);
  }
  return prd;
}

// Validate one PRD file's content and return warnings (1-indexed lines). It
// flags headings that start "REQ-" but aren't well-formed, unresolved REQ-?
// placeholders, duplicate ids within the file, and unknown status values.
export function lintPrd(content: string): LintWarning[] {
  const lines = splitLines(content);
  const warnings: LintWarning[] = [];
  const seen = new Map<string, number>(); // id -> first line it was defined on

  for (let idx = 0; idx < lines.length; idx++) {
    const h = headingRe.exec(lines[idx]);
    if (h === null) continue;
    const text = h[2].trim();
    if (!text.startsWith("REQ-")) continue;
    const ln = idx + 1;

    const m = reqRe.exec(text);
    if (m === null) {
      warnings.push({
        line: ln,
        message: `malformed requirement heading "${text}" — expected 'REQ-<n>: <title>'`,
      });
      continue;
    }
    if (m[1] === "?") {
      warnings.push({
        line: ln,
        message:
          "unresolved placeholder REQ-? — assign the next id (see the to-prd skill's numbering step)",
      });
    } else {
      const id = "REQ-" + m[1];
      const first = seen.get(id);
      if (first !== undefined) {
        warnings.push({ line: ln, message: `duplicate ${id} (first defined at line ${first})` });
      } else {
        seen.set(id, ln);
      }
    }

    // Validate status on the metadata lines directly under this heading.
    for (let j = idx + 1; j < lines.length; j++) {
      const mm = metaRe.exec(lines[j]);
      if (mm === null) break;
      if (mm[1].toLowerCase() === "status") {
        const val = mm[2].trim();
        if (!validStatus.has(val)) {
          warnings.push({
            line: j + 1,
            message: `unknown status "${val}" — expected active, parked, or out-of-scope`,
          });
        }
      }
    }
  }
  return warnings;
}

// Load the whole PRD spec: list the files, read each, parse it — preserving the
// sorted order `list_prds` returns. Replaces the old `iudex spec --json` read.
export async function loadSpec(root: string): Promise<SpecDoc> {
  const files = await api.listPrds(root);
  const prds: PRD[] = [];
  for (const file of files) {
    const content = await api.readPrd(root, file);
    prds.push(parsePrd(file, content));
  }
  return { prds };
}
