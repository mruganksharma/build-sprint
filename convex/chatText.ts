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
  `All set. I'll look for ${industries.join(", ")} jobs in ${location}.`;

export const readyHelp =
  "You're all set. Send a new resume anytime, or reply 'change' to update what you're looking for.";

export const pleaseChoose = (question: string) => `Please reply 1 or 2.\n\n${question}`;

export const noAngleBrackets = "Please reply without the < and > characters.";
