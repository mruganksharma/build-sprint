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

export const allSet = (industries: string[], location: string) =>
  `All set. Searching LinkedIn for ${industries.join(", ")} jobs in ${location} now. This takes a couple of minutes.`;

export const searchingAgain = (industries: string[], location: string) =>
  `Searching LinkedIn for ${industries.length ? `${industries.join(", ")} ` : ""}jobs in ${location}. This takes a couple of minutes.`;

export const stillSearching = "I'm still searching. Your jobs will arrive here in a minute or two.";

export const readyHelp =
  "Reply 'jobs' to search for jobs, 'change' to update what you're looking for, or send a new resume anytime.";

export const pleaseChoose = (question: string) => `Please reply 1 or 2.\n\n${question}`;

export const noAngleBrackets = "Please reply without the < and > characters.";

export const likedReply = "Got it. I'll look out for more jobs like that one.";
export const dislikedReply = "Got it. I'll show you fewer jobs like that one.";
