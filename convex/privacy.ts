// The privacy policy page Meta requires before the WhatsApp app can be published.
// Served at /privacy by http.ts. Keep it true to what the code does; update the date when it changes.

const CONTACT = "jobfinder2027@gmail.com";
const UPDATED = "10 October 2026";

export const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Finder privacy policy</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 680px; margin: 0 auto; padding: 24px 16px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #121212; } a { color: #8ab4f8; } }
</style>
</head>
<body>
<h1>Job Finder privacy policy</h1>
<p>Last updated: ${UPDATED}</p>

<p>Job Finder is a WhatsApp service that finds job openings that match your resume and what you're looking for. This page explains what we keep, why, and who else handles it.</p>

<h2>What we keep</h2>
<ul>
  <li>Your WhatsApp phone number, and the messages you send us and our replies.</li>
  <li>Your resume: the file, photo or link you send, and the text we read from it.</li>
  <li>Details from your resume: your current role, industry and city, and your email address and LinkedIn profile address if your resume includes them.</li>
  <li>What you tell us you want: industry, city, how recent the jobs should be, other job sites you mention, and which jobs you said you like or don't like.</li>
  <li>Your job search history: the jobs we looked at for you, whether we sent them, and the reason.</li>
</ul>

<h2>How we use it</h2>
<p>Only to find jobs for you, explain why a job does or doesn't fit, and reply to your messages. We don't sell your data, show you ads, or share your resume with employers. We only message you, and only in reply to you.</p>

<h2>Who else handles your data</h2>
<ul>
  <li><strong>Meta (WhatsApp)</strong> carries the messages between you and us.</li>
  <li><strong>Anthropic</strong>, an AI company, reads your resume and job postings for us, to check how well each job fits you. We send it your resume, your preferences and the job description.</li>
  <li><strong>Convex</strong> stores your data and runs our service on its servers.</li>
  <li><strong>LinkedIn</strong>: we read LinkedIn's public job listings. We don't send your data to LinkedIn.</li>
</ul>

<h2>How long we keep it</h2>
<p>We keep your data while you use Job Finder. You can ask us to delete it at any time, and we will delete your resume, details, preferences, messages and job history.</p>

<h2>Your choices</h2>
<p>To see, correct or delete your data, email <a href="mailto:${CONTACT}">${CONTACT}</a> from any address and tell us the WhatsApp number you used. You can stop using Job Finder at any time by not messaging us.</p>

<h2>Age</h2>
<p>Job Finder is for people aged 18 and over.</p>

<h2>Changes</h2>
<p>If we change this policy, we'll update the date at the top of this page.</p>

<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>
</body>
</html>`;
