// Resumes sent as files and photos through the Hermes relay route (/hermes/incoming), the way the
// relay on the Mac sends them: name, type and contents. Made-up resume, made-up numbers (added to
// HERMES_ALLOWED_PHONES for the run, then removed). About 3 Claude calls.
// Reads replies from the app's message log, not the relay's outbox, so the live relay can keep running.
// Run: npm run test:hermes-files
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { check, finish, makeFiles, newPhone, run, site } from "./test-helpers.mjs";

const envGet = (name) => execSync(`npx convex env get ${name}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const envSet = (name, value) => execSync(`npx convex env set ${name} '${value}'`, { stdio: "ignore" });
const secret = envGet("HERMES_RELAY_SECRET");
const f = makeFiles();

const send = (phone, file) =>
  fetch(`${site}/hermes/incoming`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ phone, messageId: `file-${phone}-${Math.random()}`, ...file }),
  });
const file = (name, type, mimeType) => ({ type, fileName: name, mimeType, fileBase64: readFileSync(f(name)).toString("base64") });
async function replyFor(phone, want) {
  let out = [];
  for (let i = 0; i < 60; i++) {
    out = run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out").map((m) => m.text);
    if (out.some((t) => want.test(t))) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return out.find((t) => want.test(t)) ?? out.at(-1) ?? null;
}

const SAVED = /^Got your resume/;
const cases = [
  { name: "PDF resume is read and saved", file: file("priya.pdf", "document", "application/pdf"), want: SAVED, saved: true },
  { name: "Word resume is read and saved", file: file("priya.docx", "document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), want: SAVED, saved: true },
  { name: "photo of a resume is read and saved", file: file("priya.png", "image", "image/png"), want: SAVED, saved: true },
  { name: "file the relay marked too big is refused", file: { type: "document", fileName: "cv.pdf", mimeType: "application/pdf", tooBig: true }, want: /over 1 MB/ },
  { name: "file over 1 MB that got through anyway is refused", file: file("big.pdf", "document", "application/pdf"), want: /over 1 MB/ },
  { name: "Excel file is refused", file: { type: "document", fileName: "cv.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileBase64: Buffer.from("PK fake").toString("base64") }, want: /can't read that kind of file/ },
];

const before = envGet("HERMES_ALLOWED_PHONES");
for (const c of cases) c.phone = newPhone();
envSet("HERMES_ALLOWED_PHONES", [before, ...cases.map((c) => c.phone)].filter(Boolean).join(","));
try {
  await Promise.all(cases.map(async (c) => {
    const res = await send(c.phone, c.file);
    c.status = res.status;
    c.got = c.status === 200 ? await replyFor(c.phone, c.want) : null;
    c.profile = run("profile:getByPhone", { phone: c.phone });
  }));
  for (const c of cases) {
    const savedOk = c.saved ? !!c.profile && c.profile.resumeTextLength > 200 && c.profile.hasFile : !c.profile;
    check(c.name, c.status === 200 && !!c.got && c.want.test(c.got) && savedOk, `status ${c.status}, reply: ${c.got}`);
  }
} finally {
  envSet("HERMES_ALLOWED_PHONES", before);
}
finish();
