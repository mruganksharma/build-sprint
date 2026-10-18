// Guests: a stranger who sends exactly the joining phrase is let in (at most 20); after that they
// wait in line and get the "full" reply; when a guest leaves, the oldest in line gets the spot.
// ("queued" = waiting for the Hermes relay; Meta replies are never queued.) Made-up numbers only; nothing is really sent. Never collects the outbox (that would take real
// users' waiting replies). Stop the Hermes "jobs" gateway first: it would try to send to the
// made-up guests. A few Claude calls at most. Run: npm run test:guests
import { execSync } from "node:child_process";
import { check, finish, newPhone, run } from "./test-helpers.mjs";

const site = execSync("grep ^CONVEX_SITE_URL= .env.local").toString().split("=")[1].trim();
const secret = execSync("npx convex env get HERMES_RELAY_SECRET").toString().trim();
const post = (path, body, key = secret) =>
  fetch(`${site}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
const PHRASE = "Hi, I want you to find me jobs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (phone) => run("whatsapp:messagesForPhone", { phone }).filter((m) => m.direction === "out");
const isGuest = (phone) => run("guests:isGuest", { phone });
const join = async (phone, text = PHRASE) => {
  const res = await post("/hermes/join", { phone, text });
  return res.status === 200 ? res.json() : res.status;
};

try {
  // ---- joining ----
  const a = newPhone();
  check("join: wrong secret refused", (await post("/hermes/join", { phone: a, text: PHRASE }, "wrong")).status === 403);
  check("join: a plain 'Hi' is not the phrase (refused, not a guest)", (await join(a, "Hi")) === 403 && !isGuest(a));
  check("incoming: a stranger who isn't a guest is refused", (await post("/hermes/incoming", { phone: a, messageId: `t-${a}-0`, type: "text", text: "hello" })).status === 403);
  const first = await join(a, "hi, i want you to FIND me jobs!!");
  check("join: the phrase (any case or punctuation) → joined", first.status === "joined" && isGuest(a), JSON.stringify(first));
  check("join: sending it again → already a guest", (await join(a)).status === "guest");
  check("guest list for the relay includes them", run("guests:guestPhones", {}).includes(a));
  const res = await post("/hermes/incoming", { phone: a, messageId: `t-${a}-1`, type: "text", text: PHRASE });
  check("incoming: a guest's message is accepted", res.status === 200, `got ${res.status}`);
  let greeting = [];
  for (let i = 0; i < 15 && !greeting.length; i++) {
    await sleep(2000);
    greeting = out(a);
  }
  check("a new guest gets the usual welcome, sent through Hermes", greeting.length > 0 && greeting[0].status === "queued", (greeting[0]?.text ?? "").slice(0, 80));

  // ---- full ----
  const before = run("guests:list", {});
  const fill = [];
  for (let i = before.guests.length; i < before.max; i++) {
    const p = newPhone();
    fill.push(p);
    run("guests:join", { phone: p });
  }
  check(`list is now full (${before.max})`, run("guests:list", {}).guests.length === before.max);
  const late = newPhone();
  const later = newPhone();
  const full = await join(late);
  check("full: the next person gets the 'full' reply and waits in line", full.status === "full" && /full right now/.test(full.reply ?? "") && !isGuest(late), JSON.stringify(full));
  await join(later);
  check("full: the line keeps its order", run("guests:list", {}).waiting.slice(-2).join() === [late, later].map((p) => `…${p.slice(-4)}`).join());

  // ---- leaving frees a spot ----
  const leaver = fill[0] ?? a;
  run("erase:eraseUser", { phone: leaver });
  check("terminal erase: they leave the list", !isGuest(leaver));
  check("their spot goes to the first in line", isGuest(late) && !isGuest(later));
  const opened = out(late);
  check("…who gets 'a spot opened up', waiting for the relay", opened.length === 1 && /spot opened up/.test(opened[0].text) && opened[0].status === "queued", JSON.stringify(opened));

  // ---- "delete my data" through Hermes ----
  await post("/hermes/incoming", { phone: a, messageId: `t-${a}-2`, type: "text", text: "delete my data" });
  await sleep(6000);
  await post("/hermes/incoming", { phone: a, messageId: `t-${a}-3`, type: "text", text: "DELETE" });
  let done = [];
  for (let i = 0; i < 15 && !done.length; i++) {
    await sleep(2000);
    done = out(a).filter((m) => /^Done\. Everything you shared/.test(m.text));
  }
  check("delete my data: the 'Done' reply goes back through Hermes (not Meta)", done.length === 1 && done[0].status === "queued", JSON.stringify(done));
  check("…and they stay a guest until it has gone out", isGuest(a));
  run("erase:dropGoodbye", { phone: a, text: done[0]?.text ?? "", tries: 12 });
  check("after it has gone: they leave the list, and the next in line gets the spot", !isGuest(a) && isGuest(later));
} finally {
  const cleared = run("erase:eraseTestUsers", {});
  console.log(`cleanup: erased ${cleared.users} made-up users`);
}
check("cleanup: no made-up guests left", !run("guests:list", {}).guests.length || run("guests:guestPhones", {}).every((p) => !p.startsWith("1555")));
finish();
