// The questions the app asks after a resume arrives. Plain text so they work in any WhatsApp.

export const METROS = [
  "Mumbai",
  "Delhi NCR",
  "Bengaluru",
  "Hyderabad",
  "Chennai",
  "Pune",
  "Kolkata",
  "Ahmedabad",
];

export const industryQuestion = (industry: string) =>
  `Your resume shows you work in ${industry}. Do you want jobs in the same industry or a different one?\n1. Same (${industry})\n2. Different`;

export const industryInputQuestion =
  "Which industry do you want jobs in? You can name more than one, e.g. Fintech, Healthcare.";

export const locationQuestion = (location: string) =>
  `You're based in ${location}. Where do you want to work?\n1. ${location}\n2. Somewhere else`;

export const metroQuestion = `Which city do you want to work in? Reply with a number, or type any other city.\n${METROS.map((city, i) => `${i + 1}. ${city}`).join("\n")}`;

export const DAYS = [1, 7, 30];
export const daysQuestion = "How recent should the jobs be?\n1. Last 24 hours\n2. Last 7 days\n3. Last 30 days";
export const daysText = (days: number) => (days === 1 ? "the last 24 hours" : `the last ${days} days`);

export const allSet = (industries: string[], location: string, days: number) =>
  `All set. Searching LinkedIn and company career pages for ${industries.join(", ")} jobs in ${location} from ${daysText(days)} now. This takes a couple of minutes.`;

export const searchingAgain = (industries: string[], location: string) =>
  `Searching LinkedIn and company career pages for ${industries.length ? `${industries.join(", ")} ` : ""}jobs in ${location}. This takes a couple of minutes.`;

export const stillSearching = "I'm still searching. Your jobs will arrive here in a minute or two.";

export const savedForNext = "I've saved that for your next search. Reply 'jobs' whenever you want me to search.";

export const searchQueuedText =
  "Your current search is still running. I'll search again with this as soon as it finishes.";

export const portalNoted = (site: string) =>
  `Noted: ${site}. I can only search LinkedIn today, but I've saved it for later. Reply 'jobs' to search LinkedIn again, or 'change' to update what you're looking for.`;

export const noSuchJob = (n: number) => `There's no job ${n} in my last list. Reply 'jobs' for a new list.`;
export const noListYet = "I haven't sent you a list of jobs yet. Reply 'jobs' to search.";
export const ratedJob = (job: string, yes: boolean) =>
  yes ? `Got it: I'll look out for more jobs like ${job}.` : `Got it: I'll show you fewer jobs like ${job}.`;

export const noAngleBrackets = "Please reply without the < and > characters.";

export const likedReply = "Got it. I'll look out for more jobs like that one.";
export const dislikedReply = "Got it. I'll show you fewer jobs like that one.";

// Someone the app knows says hi again: remind them where things stand, without asking Claude.
export const welcomeBack = (industries: string[], location: string, days: number, searching: boolean) =>
  `Welcome back! I'm looking for ${industries.length ? `${industries.join(", ")} ` : ""}jobs in ${location} from ${daysText(days)}.\n\n` +
  (searching
    ? "I'm searching right now. Your jobs will arrive here in a minute or two."
    : "Reply 'jobs' for new jobs, or tell me what to change, like a different city or industry.");

export const welcomeBackMidQuestion = (question: string) => `Welcome back! Let's pick up where we left off.\n\n${question}`;

// Daily job alerts, asked once after their first reply to a job list.
export const alertsQuestion =
  "Want me to send you new jobs every day?\n1. Yes, every morning (9 am)\n2. Yes, every evening (6 pm)\n3. Yes, at another time\n4. No thanks";
export const alertsTimeQuestion = "What time should I send them? For example: 8 am, or 7:30 pm.";
const hourText = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;
export const alertsOn = (hour: number) =>
  `Done. Every day around ${hourText(hour)} (India time) I'll search and send you any new jobs. If there's nothing new, I'll send a one-line note to say so. Say 'stop alerts' anytime.`;
export const alertsOff = "No problem. If you change your mind, just say 'daily alerts'.";
export const alertHeader = (count: number) => `Your daily job alert: ${count} new job${count === 1 ? "" : "s"} for you on LinkedIn, newest first:`;
// A daily alert that found nothing new still says so, so a quiet day doesn't look like a fault.
export const alertNothing = (looked: number, what: string, place: string, period: string) =>
  `Your daily job alert: nothing new today. ${looked ? `I looked at ${looked} ${what}jobs in ${place} from ${period}, but none fit what you asked for.` : `I found no ${what}jobs in ${place} from ${period}.`} I'll look again tomorrow.\n\nReply 'jobs' to search now, or 'change' to widen your search, e.g. jobs from the last 7 days.`;

// Joining with the phrase when all spots are taken, and later when a spot opens (guests.ts).
export const joinFull =
  "Thanks for your interest in Job Finder! It's full right now. I've saved your place in line and will message you here when a spot opens.";
export const spotOpened =
  "Good news: a spot opened up on Job Finder. Send me your resume (PDF, Word, a photo or plain text) and I'll start finding jobs that fit you.";

// "Delete my data": asked once, then done.
export const deleteConfirm =
  "This will permanently delete your resume, preferences, messages and job history. Reply DELETE to confirm, or anything else to keep everything.";
export const deleteDone = "Done. Everything you shared with Job Finder is deleted. Send a resume anytime to start again.";
export const deleteKept = "Okay, nothing was deleted. Everything is as it was.";
export const deleteBusy = "I'm in the middle of a job search for you. Try 'delete my data' again in 2 minutes.";
