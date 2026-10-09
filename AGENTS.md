# AGENTS.md

## 1. How the product works
Interface: existing Whatsapp app on the user phone  and the one thing they do there: submit their resume and start searching for relevant jobs 
Business logic: Once you have the users resume, we would tell me their current industry and ask if they are looking for opportunity in the same industry or different, if different we let the user pick the industry are looking for the opportunity. Next would be seeking confirmation on the region or area in which are they are looking for the opportunity. Basis on the resume we would if they would want the job in the area or region they are current or different location. If they different location. Give option of the metro cities. If the user enters a different location apart from the metro cites capture that. Once we have necessary information we system would go and skim for relevant job and share the links of those to user in the chat which meet the criteria set 
Database: User preferences needs to saved at a user level additionally basis on the conversation and response received from the user on various offerings the system should then smartly recommend similar kind of reference in the future. What do i mean by user preference and user level data. Users resume ,contact details , linkedin url , industry preference , location preference , the look back period on job search, the job portal recommendation they have if incase of. Anything explicitly theuser mentioned to be taken care of should be maintained at a user specific level. The history of the job recommendation and their corresponding outcomes , caveats and response should be saved separately.  The system have capture the logic it used to deliver a job opportunity and also for the once that it didnt because if the user shares a sample job opportunity which the system didnt give then the system should be able to use the same rationale and explain the user in the message and basis on the conversation outcome improve the logic for that user if required. 
One additional thing that needs to be saved at the user is the resume that the user gives. Now this resume can be in either of  these forms it can be .pdf, .docx,.doc, a google drive link , or a plain text file with .txt extension a link to their website too.also it can be a photograph of their resume which they have it handy on their phone  Do not accept if the data is in coming in excel or ppt or anything which acts as security risk to the platform or anything where the user can pass in carrots <>. If they do so please ask them to share the data in the required format or structure. If the content is in a unrecongised text or format politely disregard the msg and ask them to share in correct format stucture
Third party: Claude in our case . its saved on Convex , Whatsapp as thats what we are using for communication
In v1: web scrapping for opportunities (LinkedIn's public job pages, no login).
Not in v1: scrapping people linkedin post , recommendation on changes on the tweak on the resume if required. Auto apply, message draft for linkedin connections and cold email draft

When I report a bug, I'll name the part. Look there first, and tell me if you think I named the wrong one.

## 2. How we work
- Read PRODUCT.md, PLAN.md and PROGRESS.md before anything else.
- Before writing code, tell me in two or three sentences what you think I'm after, then your plan. Wait for my yes. Don't guess.
- One milestone at a time: the next one in PLAN.md, working end to end. Nothing outside it.
- If I ask for something new mid-milestone, add it to the parked list in PLAN.md and carry on.
- Never say "done" until you've seen it work (a test, or a screenshot at phone width) and told me how to check it on my phone.
- When I report a bug, find the cause before changing anything. Fix only that.
- When we add something new, write tests so what already works doesn't break. When I drop a feature, drop its tests.
- Build and test only in [where my users will use it: WhatsApp, the web, ...]. No web test page for a product that lives somewhere else.
- After I confirm a milestone works: commit, push, and add one line to PROGRESS.md.
- Never put a key or password in code, in a VITE_ variable (those are sent to every visitor) or in a committed file.
- [a rule of your own: anything you've had to say twice]

## 3. Shipping
Live link: https://doting-dalmatian-957.convex.site
Repo: https://github.com/mruganksharma/build-sprint.git public
Deploy: npm run deploy. A push never deploys by itself. After I say a milestone works: commit, push, then deploy.
Keys: ANTHROPIC_API_KEY lives in Convex environment variables, set for dev and for prod. Never in code, a VITE_ variable or a committed file. Never ask me to paste it into chat.
.gitignore covers .env.local.
Real people's data (chats, names, phone numbers) never goes in the repo, not even as a test file. Tests use made-up examples.
Every limit and every "is this allowed" check happens in a Convex function, never only on screen.
Before I share the link: I open it on my phone, logged out, on mobile data, and do the core flow once.

## 4. The AI call
Model: [Claude Opus 5.5], thinking moderate because that what i use for building 
What goes in, and its limit: hese forms it can be .pdf, .docx,.doc, a google drive link , or a plain text file with .txt extension a link to their website too.also it can be a photograph of their resume which they have it handy on their phone  Do not accept if the data is in coming in excel or ppt or anything which acts as security risk to the platform or anything where the user can pass in carrots <>. The size of this incoming attachment can not be greater than 1 MB
Where it runs: a Convex action. Never in the interface.
Key: ANTHROPIC_API_KEY in Convex environment variables, dev and prod.
Reply cap: max_output_tokens [4000]
Calls cap: at most [100] AI calls an hour across the app, checked in the kitchen (Convex rate limiter)
Provider limit: a hard monthly limit of [$ 5], set by me
When a cap is hit or the call fails: show "[Busy right now. Try again in a few minutes.]"
Login: [none in v1, because we doing a whatsapp based jouney
The AI must never: make personal comments on the users and its preferences.Talk to any one else impersonating the user. Should not text anyone else apart from the user.
