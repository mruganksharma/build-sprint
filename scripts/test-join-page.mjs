// The /join page: a QR code and a button that open WhatsApp with the joining phrase typed.
// Checks the page on dev, that the QR code holds exactly the WhatsApp link, and the "not open yet"
// note when no number is set (removes JOIN_WHATSAPP_NUMBER on dev for a moment, then puts it back).
// No Claude calls. Never prints the number. Run: npm run test:join-page
import { execSync } from "node:child_process";
import qrcode from "qrcode-generator";
import { check, finish } from "./test-helpers.mjs";

const site = execSync("grep ^CONVEX_SITE_URL= .env.local").toString().split("=")[1].trim();
const number = execSync("npx convex env get JOIN_WHATSAPP_NUMBER").toString().trim();
const PHRASE = "Hi, I want you to find me jobs"; // same as convex/guests.ts
const get = async () => {
  const res = await fetch(`${site}/join`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", html: await res.text() };
};

let removed = false;
try {
  check("JOIN_WHATSAPP_NUMBER is set on dev (digits only)", /^\d{10,13}$/.test(number), `…${number.slice(-4)}`);
  const link = `https://wa.me/${number}?text=${encodeURIComponent(PHRASE)}`;
  const page = await get();
  check("page loads as a web page", page.status === 200 && page.type.startsWith("text/html"), `${page.status} ${page.type}`);
  check("button opens WhatsApp with the joining phrase typed", page.html.includes(`href="${link}"`));
  const qr = qrcode(0, "M");
  qr.addData(link);
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
  check("QR code holds exactly that link", page.html.includes(svg));
  check("links to the privacy policy", page.html.includes('href="/privacy"'));
  check("works at phone width", page.html.includes('name="viewport" content="width=device-width'));
  check("no scripts on the page", !/<script/i.test(page.html));

  execSync("npx convex env remove JOIN_WHATSAPP_NUMBER", { stdio: "ignore" });
  removed = true;
  const empty = await get();
  check("no number set: says it isn't open yet, no QR or link", empty.status === 200 && empty.html.includes("isn't open to new people yet") && !empty.html.includes("<svg") && !empty.html.includes("wa.me"));
} finally {
  if (removed) execSync(`npx convex env set JOIN_WHATSAPP_NUMBER ${number}`, { stdio: "ignore" });
}
finish();
