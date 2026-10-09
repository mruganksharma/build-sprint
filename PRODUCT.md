# PRODUCT.md

## 1. The job
When I am losing out on job opportunities, I want a solution that helps me identify the right job opportunities for me, so I can apply to them quickly and grab them before others do.

Other moments it happens: I invest too much time identifying the right job opportunities. I scroll through various apps and websites to find the right fit.

Who, by situation: someone actively looking for their next job (laid off, or wanting to leave their current company) who keeps finding the right openings too late.

Today they hire: LinkedIn, Naukri, IIMJobs, Google Alerts, or company career pages to find relevant job alerts. Some pay a recruitment agency (around ₹50K), but often fear it's a scam, or the agency doesn't deliver.

(Advanced, optional) What needs doing: [ ]
(Advanced, optional) How they want to feel: [ ]
(Advanced, optional) How they want to look to others: [ ]

## 2. The switch
What they'd fire: the job apps and web portals they spend time searching every day.

The forces that matter:
- Push (outside them): laid off, or desperate for a career switch because they don't want to stay at their current company. Not finding the right opportunity, or not applying in time.
- Pull (inside them): better career and financial growth.
- Anxiety (the risk of trying you): trusting that the listings are actually right for them. It's a career and financial move, so a bad pick is costly.
- Habit (the way they already do it): job portals today. They use WhatsApp daily anyway (WhatsApp is parked for later, see section 5).

What the product does about each: [force] -> [what it does] — [not filled yet]
The one worry onboarding must remove: [not filled yet, one line, in their words]

## 3. The core flow
Today (before the product):
1. Prepare their resume.
2. Create accounts on various portals.
3. Search for the position they want.
4. Search in the market they want their next job in.
5. Look at each job posting.
6. Read through the job description (JD).
7. Decide whether it suits their experience.
8. Decide whether it's relevant to them.
9. Apply.
10. By then, many people have already applied.

With my product:
1. The moment it hurts: they're job hunting and missing good openings.
2. They give the product their resume and preferences (role, city, and anything else they care about).
3. The product searches for relevant job openings online. For now, LinkedIn's public job pages only.
4. It compares each job with the resume and preferences.
5. It filters out the ones that don't fit.
6. It rates the remaining jobs on: experience in the market, seniority of the role, their experience and knowledge based on the resume, and the preferences they gave. It removes duplicates.
7. It shares the matching jobs with the user, newest first.
8. If a job has a caveat (for example, older posting or a partial match), it says so.
9. It suggests what to change in the resume for that JD, if they want to apply.
10. The user opens the job link and applies themselves.
Last: they've applied to the right jobs early, without hours of searching.

Freshness rule: if the user picks a time window (for example "last 24 hours"), use theirs. If not, default to the last 7 days, newest first. User's choice always wins.

Things it takes to get the job done today: [count] · With my product: [count]

What must not happen:
- Step 7: never show an empty list without saying why. If nothing matches, tell the user plainly and ask which job site they'd like it to search instead. (Only sites that show jobs publicly, without a login, can be searched.)
- Step 7: never show a job as a match without saying how well it matches.

Other flows: [ ]

## 4. Onboarding
First value: it finds relevant job openings for them with minimum time spent.
The smallest commitment we ask for: their resume or CV.
The worry it removes: time spent searching across multiple portals and skimming through endless openings.

From opening the link to the first value:
1. [where they come from, and what they open] — [not filled yet]
2. They upload their resume and say what they're looking for.
3. First value: a short list of matching jobs.

Login: [not decided yet]
What we don't ask on day one: [ ]
What we ask later, and when: [ ]

## 5. v1
Does (must haves): shows at least 5 to 10 job openings relevant to the user's experience or preferences, which they can apply to.
Doesn't (not this sprint, parked): resume revamp, auto-apply, WhatsApp (needs Meta's WhatsApp Business API, an outside service).
Nice to have: [ ]
How I'll know it worked (what they do, not what they say): they tap through to at least one job, and they come back later to look or search again.

## 6. The riskiest guess
If this is false, the product is pointless: LinkedIn doesn't allow automated access, so we'd need an alternative.

Thirty-minute check, no code — what happened (2026-10-08):
- Finding jobs: works. A plain request to LinkedIn's public job search (no login, no account) returned 10 real jobs in the Mumbai area.
- Matching: needed. Only 3 of the 10 were actually "Senior Product Analyst". LinkedIn matches loosely, so the app must filter by title and fit itself.
- Freshness: in the last 24 hours, only 2 relevant jobs; in the last 7 days, 5. That's why the default window is 7 days.
- Still a risk: LinkedIn's rules don't allow automated collection, and repeated requests can get blocked. Backup: company career pages that publish their open jobs publicly (to be tested). Paid scraping services are not used in v1 (outside service, and they don't change LinkedIn's rules).

## 7. Milestones
1. I can skim through relevant openings quickly.
2. I can talk to it and say what I like and don't like, quickly.
Last: I can close it, reopen it, and my data is still there.
(Parked: apply quickly through WhatsApp.)
