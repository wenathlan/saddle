/**
 * robots context groups local rule parsing, fetch caching and active aliases.
 */

export interface RobotsDirective { userAgent: string; allow: string[]; disallow: string[]; crawlDelay?: number; }
export interface RobotsGroup { agents: string[]; allow: string[]; disallow: string[]; delay?: number; sitemaps: string[]; }
export interface RobotsTxt { directives: RobotsDirective[]; groups: RobotsGroup[]; sitemaps: string[]; crawlDelay?: number; }

const cache = new Map<string, { robots: RobotsTxt; fetchedAt: number }>();
const cachettl = 24 * 60 * 60 * 1000;

/** Parses robots text into both historical directives and active groups. */
export function robotsrules(text = ""): RobotsTxt { const directives: RobotsDirective[] = []; const groups: RobotsGroup[] = []; const sitemaps: string[] = []; let directive: RobotsDirective | null = null; let group: RobotsGroup | null = null; for (const raw of text.split(/\r?\n/)) { const line = raw.split("#", 1)[0].trim(); if (!line) continue; const separator = line.indexOf(":"); if (separator < 0) continue; const key = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim(); if (key === "user-agent") { directive = { userAgent: value, allow: [], disallow: [] }; directives.push(directive); group = { agents: [value.toLowerCase()], allow: [], disallow: [], sitemaps: [] }; groups.push(group); } else if (key === "allow" && value) { directive?.allow.push(value); group?.allow.push(value); } else if (key === "disallow" && value) { directive?.disallow.push(value); group?.disallow.push(value); } else if (key === "crawl-delay" && Number.isFinite(Number(value))) { const delay = Number(value); if (directive) directive.crawlDelay = delay; if (group) group.delay = delay; } else if (key === "sitemap" && value) { sitemaps.push(value); if (group) group.sitemaps.push(value); } } return { directives, groups, sitemaps, crawlDelay: directives.find((value) => value.crawlDelay !== undefined)?.crawlDelay }; }

/** Fetches and caches a site's robots policy without failing the caller's scrape. */
export async function fetchRobotsTxt(siteUrl: string, options: { timeout?: number; userAgent?: string } = {}): Promise<RobotsTxt> { const base = siteUrl.replace(/\/$/, ""); const robotsUrl = `${base}/robots.txt`; const cached = cache.get(robotsUrl); if (cached && Date.now() - cached.fetchedAt < cachettl) return cached.robots; try { const response = await fetch(robotsUrl, { headers: { "User-Agent": options.userAgent ?? "Saddle/1.8.19" }, signal: AbortSignal.timeout(options.timeout ?? 5000) }); const robots = response.ok ? robotsrules(await response.text()) : robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } catch { const robots = robotsrules(); cache.set(robotsUrl, { robots, fetchedAt: Date.now() }); return robots; } }

/** Checks whether a URL is allowed for a selected agent. */
export function isAllowed(url: string, robots: RobotsTxt, userAgent = "*"): boolean { try { const path = new URL(url).pathname; const rules = robots.directives.filter((value) => matchagent(value.userAgent, userAgent)); return !rules.some((value) => value.disallow.some((pattern) => pattern && path.startsWith(pattern) && !value.allow.some((allowed) => allowed.length >= pattern.length && path.startsWith(allowed)))); } catch { return true; } }

/** Returns the selected agent's crawl delay. */
export function getCrawlDelay(robots: RobotsTxt, userAgent = "*"): number | undefined { return robots.directives.find((value) => matchagent(value.userAgent, userAgent))?.crawlDelay ?? robots.crawlDelay; }
export function getSitemaps(robots: RobotsTxt): string[] { return [...robots.sitemaps]; }
export function robotsallowed(rules: RobotsTxt, target: string, agent = "*"): boolean { return isAllowed(target, rules, agent); }
export function robotsdelay(rules: RobotsTxt, agent = "*"): number { return getCrawlDelay(rules, agent) ?? 0; }
function matchagent(pattern: string, userAgent: string): boolean { const normalized = pattern.toLowerCase(); const candidate = userAgent.toLowerCase(); return normalized === "*" || candidate.includes(normalized.replaceAll("*", "")); }
