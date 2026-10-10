// Milestone 2 test: made-up resumes sent as files and text, against the DEV deployment.
// Makes a few real Claude calls. Run: npm run test:resume
import { RESUME, finish, makeFiles, runCases, sendFile, sendText, sendWhatsApp } from "./test-helpers.mjs";

const RECIPE = `Grandma's lemon cake. Ingredients: 200 g butter, 200 g sugar, 4 eggs, 200 g flour, 2 lemons, a pinch of salt.
Method: cream the butter and sugar until pale. Beat in the eggs one at a time. Fold in the flour, salt and lemon zest.
Bake at 180 C for 45 minutes. Mix the lemon juice with icing sugar and pour over the warm cake. Leave to cool before slicing.
Serves eight. Keeps for three days in a tin.`;
const f = makeFiles();
const SAVED = /^Got your resume: .*Product Manager/i;

await runCases([
  { name: "pasted resume text is saved", send: (p) => sendText(p, RESUME), saved: true, reply: SAVED },
  { name: "PDF resume is saved", send: (p) => sendFile(p, f("priya.pdf"), "priya.pdf", "application/pdf"), saved: true, file: true, reply: SAVED },
  { name: "Word resume is saved", send: (p) => sendFile(p, f("priya.docx"), "priya.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), saved: true, file: true, reply: SAVED },
  { name: "old Word (.doc) resume is saved", send: (p) => sendFile(p, f("priya.doc"), "priya.doc", "application/msword"), saved: true, file: true, reply: SAVED },
  { name: "email and LinkedIn link are picked up from the resume", send: (p) => sendText(p, RESUME), saved: true, reply: SAVED,
    expect: (pr) => pr.contactEmail === "priya.nair@example.com" && /linkedin\.com\/in\/priya-nair-example/.test(pr.linkedinUrl ?? "") },
  { name: ".txt resume is saved", send: (p) => sendFile(p, f("priya.txt"), "priya.txt", "text/plain"), saved: true, file: true, reply: SAVED },
  { name: "short hello gets the welcome", send: (p) => sendText(p, "Hi"), saved: false, reply: /^Hi! Send me your resume/ },
  { name: "text with < > is refused", send: (p) => sendText(p, RESUME + "\n<script>alert(1)</script>"), saved: false, reply: /without the < and >/ },
  { name: "pasted recipe is not a resume", send: (p) => sendText(p, RECIPE), saved: false, reply: /doesn't look like a resume/ },
  { name: "Excel file is refused", send: (p) => sendWhatsApp(p, { type: "document", document: { id: "111", filename: "cv.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }), saved: false, reply: /can't read that kind of file/ },
  { name: "WhatsApp photo without Meta token says it can't read it", send: (p) => sendWhatsApp(p, { type: "image", image: { id: "222", mime_type: "image/jpeg" } }), saved: false, reply: /couldn't read that file/ },
  { name: "file over 1 MB is refused", send: (p) => sendFile(p, f("big.pdf"), "big.pdf", "application/pdf"), saved: false, reply: /over 1 MB/ },
]);
finish();
