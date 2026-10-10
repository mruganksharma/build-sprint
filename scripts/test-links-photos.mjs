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
  { name: "resume sent as two photos is read as one", saved: true, file: true, reply: SAVED,
    send: async (p) => {
      // Upload both first, then hand them over back to back, like two photos sent together.
      const ids = [await upload(f("page1.png"), "image/png"), await upload(f("page2.png"), "image/png")];
      for (const [i, fileId] of ids.entries()) run("resume:ingestFile", { phone: p, fileId, fileName: `page${i + 1}.png`, mimeType: "image/png" });
    },
    expect: (pr, p) => pr.fileCount === 2 && /Acme Cloud/.test(pr.resumeText) && /EDUCATION|Example Business School/i.test(pr.resumeText) &&
      run("whatsapp:messagesForPhone", { phone: p }).filter((m) => m.direction === "out" && /more pages/.test(m.text)).length === 1 },
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
