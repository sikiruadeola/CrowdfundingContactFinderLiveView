/**
 * kickstarter.js
 *
 * Everything Kickstarter specific. Every network call in this file runs
 * through page.evaluate with the browser's own fetch, never a separate
 * outside request, so it always carries the exact cookies and fingerprint
 * of whichever browser tab just cleared the human check. That is the whole
 * point of the live view step: once cleared, stay inside that one trusted
 * session for everything that follows.
 */

import * as cheerio from 'cheerio';
import { log } from 'crawlee';

const DISCOVER_ROOT = 'https://www.kickstarter.com/discover/advanced';

/**
 * A background fetch call from inside the page carries different signals
 * than a real page visit and got blocked by Cloudflare even right after the
 * browser itself had already cleared its check. A real navigation, the same
 * thing a person does by typing an address and pressing enter, is what
 * actually works reliably, so every request here is a real page.goto, never
 * a fetch. A short pause between requests keeps this looking like a person
 * clicking around, not a script hammering the site.
 */
async function realNavigationGetJson(page, url) {
    await sleep(2500 + Math.random() * 2000);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && !response.ok()) throw new Error(`status ${response.status()}`);
    const text = await page.evaluate(() => document.body.innerText);
    return JSON.parse(text);
}

async function realNavigationGetHtml(page, url) {
    await sleep(2500 + Math.random() * 2000);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && !response.ok()) throw new Error(`status ${response.status()}`);
    return page.content();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns true the moment the page no longer looks like a Cloudflare
 * challenge, used by liveView.js to know when to hand control back.
 */
export async function looksClearedOfChallenge(page) {
    const title = await page.title().catch(() => '');
    return !/just a moment|checking your browser|attention required/i.test(title);
}

/**
 * Walks one category, one state, page by page, stopping on the first empty
 * page, the first real error, or the two hundred page ceiling Kickstarter
 * itself enforces, whichever comes first.
 */
export async function discoverProjects(page, { categoryId, state, sort = 'newest', maxPages = 200 }) {
    const projects = [];

    for (let p = 1; p <= maxPages; p += 1) {
        const url = `${DISCOVER_ROOT}?format=json&category_id=${categoryId}&state=${state}&sort=${sort}&page=${p}`;

        let body;
        try {
            body = await realNavigationGetJson(page, url);
        } catch (error) {
            log.warning(`Discovery page ${p} for state ${state} failed: ${error.message}. Stopping this state here.`);
            break;
        }

        const pageProjects = body?.projects || [];
        if (pageProjects.length === 0) {
            log.info(`State ${state}, page ${p} came back empty. Reached the end of this slice.`);
            break;
        }

        projects.push(...pageProjects);
    }

    return projects;
}

/**
 * Reads one project's own public page from inside the browser session.
 * Returns the full story text and every outbound link on the page that
 * does not point back at kickstarter.com.
 */
export async function fetchProjectPage(page, projectUrl) {
    try {
        const html = await realNavigationGetHtml(page, projectUrl);
        const $ = cheerio.load(html);

        const storyText = $('body').text().replace(/\s+/g, ' ').slice(0, 200000);

        const links = new Set();
        $('a[href^="http"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) links.add(href);
        });

        return { storyText, links: cleanLinks([...links]) };
    } catch (error) {
        log.warning(`Could not read project page ${projectUrl}: ${error.message}`);
        return { storyText: '', links: [] };
    }
}

function cleanLinks(urls) {
    const skipHosts = [
        'kickstarter.com', 'ksr-ugc.imgix.net', 'facebook.com', 'twitter.com', 'x.com',
        'instagram.com', 'google.com', 'gstatic.com', 'googleapis.com', 'apple.com',
        'play.google.com', 'youtube.com', 'youtu.be', 'schema.org', 'w3.org',
        'trustarc.com', 'privacy-mgmt.com', 'sift.com', 'qualtrics.com',
    ];

    const out = new Map();

    for (const raw of urls) {
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }

        const host = parsed.hostname.replace(/^www\./, '');
        if (skipHosts.some((h) => host === h || host.endsWith(`.${h}`))) continue;

        parsed.hash = '';
        for (const p of [...parsed.searchParams.keys()]) {
            if (/^(utm_|fbclid|gclid|ref$)/i.test(p)) parsed.searchParams.delete(p);
        }

        const key = `${host}${parsed.pathname}`;
        if (!out.has(key)) out.set(key, parsed.toString());
    }

    return [...out.values()];
}

export function splitLinks(urls) {
    const socialHosts = [
        'twitter.com', 'x.com', 'instagram.com', 'facebook.com', 'tiktok.com',
        'linkedin.com', 'threads.net', 'reddit.com', 'discord.gg', 'discord.com',
        'patreon.com', 'twitch.tv', 'linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co',
        'substack.com', 'medium.com', 'github.com', 'pinterest.com', 'vimeo.com',
    ];

    const ownSites = [];
    const socialProfiles = [];

    for (const url of urls) {
        let host;
        try {
            host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
            continue;
        }

        const isAggregator = ['linktr.ee', 'beacons.ai', 'bio.link', 'carrd.co'].some(
            (h) => host === h || host.endsWith(`.${h}`),
        );

        if (isAggregator) {
            ownSites.push(url);
        } else if (socialHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
            socialProfiles.push(url);
        } else {
            ownSites.push(url);
        }
    }

    return { ownSites, socialProfiles };
}
