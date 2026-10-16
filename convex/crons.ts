import { cronJobs } from "convex/server";

// No timers. Daily job alerts are booked per user at the time they chose (see alerts.ts).
const crons = cronJobs();

export default crons;
