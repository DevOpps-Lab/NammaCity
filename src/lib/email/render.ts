/**
 * Renders the composed plain-text complaint into a clean, email-safe HTML body.
 *
 * The plain text stays the single source of truth (it is what the Outbox shows
 * and what non-HTML clients read); this only prettifies it. Styles are inlined
 * because email clients strip <style> blocks. Blocks are separated by blank
 * lines: the leading `To:` line becomes a heading, all-`label: value` blocks
 * become a table, and everything else becomes a paragraph (wrapped lines are
 * rejoined).
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const KV = /^([^:]{1,34}?)\s*:\s+(\S.*)$/;
/** A numbered statutory question, e.g. "1. What action has been taken?" */
const NUMBERED = /^\s*(\d+)\.\s+(.*)$/;

/**
 * An RTI application is not a complaint and must not be dressed as one. It is a
 * statutory information request under the RTI Act 2005, and the complaint
 * footer — "will be marked resolved only when a resident confirms the repair
 * with a photograph" — is simply untrue of it. Same renderer, honest chrome.
 */
export function rtiTextToHtml(subject: string, body: string): string {
  return render(subject, body, {
    subtitle: "Application under the Right to Information Act, 2005",
    footer:
      "Sent via NammaCity on behalf of a resident. The RTI Act 2005 provides for a reply within 30 days. This application concerns the status of a civic complaint tracked on a public ledger.",
  });
}

export function complaintTextToHtml(
  subject: string,
  body: string,
  photoCid?: string | null
): string {
  return render(subject, body, {
    photoCid,
    subtitle: "Citizen-verified civic complaint",
    footer:
      "Sent via NammaCity · This complaint is tracked publicly and will be marked resolved only when a resident confirms the repair with a photograph, not on a status update alone.",
  });
}

interface RenderOptions {
  photoCid?: string | null;
  subtitle: string;
  footer: string;
}

function render(
  subject: string,
  body: string,
  { photoCid, subtitle, footer }: RenderOptions
): string {
  const blocks = body.replace(/\r/g, "").split(/\n\s*\n/);
  const parts: string[] = [];
  let recipient = "";

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (!lines.length) continue;

    if (!recipient && /^to:\s*/i.test(lines[0])) {
      recipient = lines[0].replace(/^to:\s*/i, "").trim();
      continue;
    }
    // "To the Public Information Officer, <body>" — the RTI's form of address.
    if (!recipient && /^to the /i.test(lines[0])) {
      recipient = lines[0].trim();
      continue;
    }

    const kvs = lines.map((l) => KV.exec(l)).filter(Boolean) as RegExpExecArray[];
    if (kvs.length === lines.length) {
      const rows = kvs
        .map(
          (m) =>
            `<tr><td style="padding:4px 14px 4px 0;color:#64748b;white-space:nowrap;vertical-align:top;font-size:13px">${esc(
              m[1].trim()
            )}</td><td style="padding:4px 0;color:#0f172a;font-size:13px">${esc(
              m[2].trim()
            )}</td></tr>`
        )
        .join("");
      parts.push(
        `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:14px 0;width:100%">${rows}</table>`
      );
    } else if (lines.some((l) => NUMBERED.test(l))) {
      // A numbered block is a list, not a paragraph. `lines.join(" ")` below is
      // right for the complaint, whose prose is hard-wrapped — but it collapsed
      // the RTI's four statutory questions into one run-on sentence. Indented
      // continuation lines fold back into the item they belong to.
      const items: string[] = [];
      for (const line of lines) {
        const m = NUMBERED.exec(line);
        if (m) items.push(m[2].trim());
        else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
        else items.push(line.trim());
      }
      parts.push(
        `<ol style="margin:12px 0;padding-left:20px;color:#334155;font-size:14px;line-height:1.6">${items
          .map((i) => `<li style="margin:6px 0">${esc(i)}</li>`)
          .join("")}</ol>`
      );
    } else {
      parts.push(
        `<p style="margin:12px 0;color:#334155;font-size:14px;line-height:1.6">${esc(
          lines.join(" ")
        )}</p>`
      );
    }
  }

  const photoBlock = photoCid
    ? `<div style="margin:18px 0"><img src="cid:${esc(
        photoCid
      )}" alt="Reported defect (redacted)" style="width:100%;max-width:520px;border-radius:10px;border:1px solid #e2e8f0" /><p style="margin:6px 0 0;color:#94a3b8;font-size:11px">Redacted on the reporting device · EXIF stripped</p></div>`
    : "";

  const recipientBlock = recipient
    ? `<p style="margin:0 0 4px;color:#0f172a;font-size:15px;font-weight:600">${esc(
        recipient
      )}</p>`
    : "";

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f1f5f9">
<div style="max-width:600px;margin:0 auto;padding:24px 16px">
  <div style="background:#0f766e;border-radius:12px 12px 0 0;padding:16px 20px">
    <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.01em">NammaCity</div>
    <div style="color:#99f6e4;font-size:12px;margin-top:2px">${esc(subtitle)}</div>
  </div>
  <div style="background:#ffffff;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;padding:22px 20px">
    ${recipientBlock}
    ${photoBlock}
    ${parts.join("\n")}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0" />
    <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.5">${esc(footer)}</p>
  </div>
</div>
</body></html>`;
}
