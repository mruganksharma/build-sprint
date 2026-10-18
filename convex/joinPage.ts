import qrcode from "qrcode-generator";
import { JOIN_PHRASE } from "./guests";

// The page people open to start using Job Finder: a QR code (to scan from a laptop or poster) and
// a button (on a phone), both opening WhatsApp with the joining phrase already typed.
// Served at /join by http.ts. The number comes from the Convex environment variable
// JOIN_WHATSAPP_NUMBER (country code + number, digits only), never from code.

export function joinLink(number: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(JOIN_PHRASE)}`;
}

// The QR code as an SVG image, drawn here (no outside service).
export function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}

const page = (body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Finder on WhatsApp</title>
<style>
  :root { --text: #1a1a1a; --muted: #555; --bg: #fff; --link: #0b57d0; }
  @media (prefers-color-scheme: dark) { :root { --text: #eee; --muted: #aaa; --bg: #121212; --link: #8ab4f8; } }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 16px; color: var(--text); background: var(--bg); text-align: center; }
  h1 { font-size: 1.7rem; margin: 0 0 8px; }
  p { margin: 0 0 20px; }
  .qr { width: 240px; max-width: 100%; margin: 0 auto 8px; padding: 8px; background: #fff; border-radius: 12px; }
  .qr svg { display: block; width: 100%; height: auto; }
  .hint { color: var(--muted); font-size: 0.9rem; }
  .button { display: inline-block; margin: 8px 0 24px; padding: 14px 28px; border-radius: 999px; background: #1a7f4b; color: #fff; font-weight: 600; text-decoration: none; }
  a { color: var(--link); }
  footer { font-size: 0.85rem; color: var(--muted); }
</style>
</head>
<body>
<h1>Job Finder</h1>
${body}
<footer><a href="/privacy">Privacy policy</a></footer>
</body>
</html>`;

export function joinPageHtml(number: string | undefined): string {
  if (!number || !/^\d{10,13}$/.test(number)) {
    return page(`<p>Job Finder isn't open to new people yet. Please check back soon.</p>`);
  }
  const link = joinLink(number);
  return page(`<p>Send your resume on WhatsApp and get jobs that fit you, with a short reason for each.</p>
<div class="qr">${qrSvg(link)}</div>
<p class="hint">Scan with your phone's camera to open the chat.</p>
<a class="button" href="${link}">Chat on WhatsApp</a>
<p class="hint">WhatsApp opens with a message ready. Just tap send.</p>`);
}
