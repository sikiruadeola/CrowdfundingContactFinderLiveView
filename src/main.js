/**
 * main.js
 *
 * Launches one real, visible Chromium browser and drives the whole run
 * through that single browser, start to finish. If Kickstarter shows a
 * Cloudflare challenge at any point, the run pauses and streams that exact
 * browser live through this actor's own container URL, so a real person can
 * open it and solve the challenge with their own hands. The run only ever
 * continues once that clears.
 *
 * Everything after that point stays inside the same browser tab, using the
 * page's own fetch rather than a separate outside request, so the passed
 * check is never left behind.
 */

import { Actor } from 'apify';
import { chromium } from 'playwright';
import { log } from 'crawlee';
import { extractEmails, extractUrls, rankEmails } from './emailFinder.js';
import { discoverProjects, fetchProjectPage, splitLinks, looksClearedOfChallenge } from './kickstarter.js';
import { waitForHumanToClearChallenge } from './liveView.js';

await Actor.init();

const input = (await Actor.getInput()) || {};

const {
    categoryId,
    states = ['live', 'failed'],
    sort = 'newest',
    maxPagesPerState = 200,
    maxProjects = 0,
    crawlCreatorSites = true,
    maxSitePagesEach = 4,
    minimumScore = 0,
    challengeWaitMinutes = 15,
} = input;

if (!categoryId) {
    throw new Error('No categoryId supplied. Design is 7, Film and Video is 10, Games is 12, Technology is 16.');
}

const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

async function ensurePastAnyChallenge(url, reason) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => undefined);
    if (await looksClearedOfChallenge(page)) return;

    await waitForHumanToClearChallenge(page, {
        reason,
        timeoutMs: challengeWaitMinutes * 60 * 1000,
        isCleared: () => looksClearedOfChallenge(page),
    });
}

/* ================================================================== */
/* STEP 1. Land on Kickstarter and clear whatever shows up.            */
/* ================================================================== */

await ensurePastAnyChallenge('https://www.kickstarter.com/discover', 'the check Kickstarter shows before allowing search');

/* ================================================================== */
/* STEP 2. Discover, one state at a time, keep only underfunded.       */
/* ================================================================== */

const store = await Actor.openKeyValueStore('KICKSTARTER-LIVEVIEW-STATE', { forceCloud: true });
const stateKey = `CATEGORY-${categoryId}`;
const savedState = (await store.getValue(stateKey)) || { seenProjectIds: [] };
const seenProjectIds = new Set(savedState.seenProjectIds || []);

const underfunded = [];

for (const state of states) {
    log.info(`Searching category ${categoryId}, state ${state}.`);
    const projects = await discoverProjects(page, { categoryId, state, sort, maxPages: maxPagesPerState });
    log.info(`State ${state} returned ${projects.length} projects before any filtering.`);

    for (const p of projects) {
        if (seenProjectIds.has(p.id)) continue;
        if (!(p.pledged < p.goal)) continue;

        seenProjectIds.add(p.id);
        underfunded.push(p);

        if (maxProjects > 0 && underfunded.length >= maxProjects) break;
    }

    await store.setValue(stateKey, { seenProjectIds: [...seenProjectIds] });
    if (maxProjects > 0 && underfunded.length >= maxProjects) break;
}

log.info(`${underfunded.length} new underfunded projects to process this run.`);

if (underfunded.length === 0) {
    log.info('Nothing new found in this slice.');
    await browser.close();
    await Actor.exit();
}

/* ================================================================== */
/* STEP 3. Read each project page, and each creator's own website.     */
/* ================================================================== */

let withEmail = 0;

for (const project of underfunded) {
    const projectUrl = project?.urls?.web?.project;
    const creatorUrl = project?.creator?.urls?.web?.user;
    if (!projectUrl) continue;

    const { storyText, links } = await fetchProjectPage(page, projectUrl);

    if (!(await looksClearedOfChallenge(page))) {
        await waitForHumanToClearChallenge(page, {
            reason: 'a check that came back while reading a project page',
            timeoutMs: challengeWaitMinutes * 60 * 1000,
            isCleared: () => looksClearedOfChallenge(page),
        });
    }

    const hits = [...extractEmails(storyText, { source: 'projectStory', sourceUrl: projectUrl })];
    const allLinks = [...new Set([...links, ...extractUrls(storyText)])];
    const { ownSites, socialProfiles } = splitLinks(allLinks);

    const pagesChecked = [projectUrl];

    if (crawlCreatorSites) {
        for (const site of ownSites.slice(0, 2)) {
            try {
                const { storyText: siteText } = await fetchProjectPage(page, site);
                hits.push(...extractEmails(siteText, { source: 'siteBody', sourceUrl: site }));
                pagesChecked.push(site);
            } catch {
                /* keep going even if one site fails */
            }
            if (hits.length && maxSitePagesEach > 0) break;
        }
    }

    const ownDomains = ownSites.map((u) => safeHost(u)).filter(Boolean);
    const { emails } = rankEmails(hits, ownDomains);
    const kept = emails.filter((e) => e.score >= minimumScore);

    if (kept.length) withEmail += 1;

    await Actor.pushData({
        projectId: project.id,
        projectName: project.name,
        projectUrl,
        state: project.state,
        goal: project.goal,
        pledged: project.pledged,
        currency: project.currency,
        percentFunded: project.goal ? Math.round((project.pledged / project.goal) * 1000) / 10 : null,
        country: project.country,
        location: project?.location?.displayable_name || null,

        creatorName: project?.creator?.name || null,
        creatorUrl,

        bestEmail: kept.length ? kept[0].email : null,
        bestEmailConfidence: kept.length ? kept[0].confidence : null,
        bestEmailScore: kept.length ? kept[0].score : null,
        bestEmailFoundOn: kept.length ? kept[0].sourceUrl : null,
        whyThisEmail: kept.length ? kept[0].reasons.join('; ') : null,

        allEmails: kept.map((e) => ({
            email: e.email, score: e.score, confidence: e.confidence, source: e.source, sourceUrl: e.sourceUrl, reasons: e.reasons,
        })),

        linkedSites: ownSites,
        socialProfiles,
        pagesChecked,
        blurb: project.blurb,
        scrapedAt: new Date().toISOString(),
    });

    log.info(`${kept.length ? 'SAVED with an email' : 'Saved, no email found'}: ${project.name}`);
}

log.info(`Done. Found at least one address for ${withEmail} of ${underfunded.length} underfunded projects.`);

await browser.close();
await Actor.exit();

function safeHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}
