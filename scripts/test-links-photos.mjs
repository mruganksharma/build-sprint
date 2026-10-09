// Milestone 3 test: made-up resumes sent as photos and links, against the DEV deployment.
// Makes a few real Claude calls and fetches a few public pages. Run: npm run test:links
import { finish, makeFiles, run, runCases, sendFile, sendText, upload } from "./test-helpers.mjs";

const f = makeFiles();
const SAVED = /^Got your resume: .*Product Manager/i;
// "Websites" holding the made-up resume: files in Convex storage have public addresses.
const htmlLink = run("profile:fileUrl", { fileId: await upload(f("priya.html"), "text/html") });
const pdfLink = run("profile:fileUrl", { fileId: await upload(f("priya.pdf"), "application/pdf") });

await runCases([
  { name: "photo of a resume is saved", send: (p) => sendFile(p, f("priya.png"), "priya.png", "image/png"), saved: true, file: true, reply: SAVED },
  { name: "tiny unreadable photo asks for a clearer one", send: (p) => sendFile(p, f("priya-tiny.png"), "priya-tiny.png", "image/png"), saved: false, reply: /couldn't read that photo clearly/ },
  { name: "link to a resume web page is saved", send: (p) => sendText(p, `My CV: ${htmlLink}`), saved: true, reply: SAVED },
  { name: "link to a resume PDF is saved", send: (p) => sendText(p, pdfLink), saved: true, file: true, reply: SAVED },
  { name: "LinkedIn link explains Save to PDF", send: (p) => sendText(p, "https://www.linkedin.com/in/priya-nair-example"), saved: false, reply: /Save to PDF/ },
  { name: "private or missing Drive file explains sharing", send: (p) => sendText(p, "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456/view?usp=sharing"), saved: false, reply: /Anyone with the link/ },
  { name: "broken link is refused", send: (p) => sendText(p, "https://raw.githubusercontent.com/mruganksharma/build-sprint/main/no-such-file-here"), saved: false, reply: /couldn't open that link/ },
  { name: "page with almost no text is refused", send: (p) => sendText(p, "https://example.com"), saved: false, reply: /couldn't find any text|doesn't look like a resume/ },
  { name: "local address is refused", send: (p) => sendText(p, "http://localhost:3000/cv"), saved: false, reply: /couldn't open that link/ },
]);
finish();
