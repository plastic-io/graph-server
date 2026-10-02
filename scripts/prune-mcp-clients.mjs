#!/usr/bin/env node
/**
 * Remove the Auth0 applications that MCP clients registered for themselves.
 *
 * Every client that connects by Dynamic Client Registration creates an
 * application in the tenant — `tpc_…`, "third party" — and nothing ever takes
 * it away again.  Reconnect a few agents, re-authenticate a few times, and the
 * tenant hits its limit and refuses the next one:
 *
 *     HTTP 403  too_many_entities
 *     "You reached the limit of entities of this type for this tenant."
 *
 * At that point nobody can connect anything, including the things that were
 * working yesterday.  This lists what registered itself and removes what has
 * gone quiet, so the limit is something that gets swept rather than something
 * that stops the project.
 *
 * It never asks for a secret and never prints one: the token comes from the
 * environment, is used, and is not logged.
 *
 *   AUTH0_DOMAIN=dev-xxxx.us.auth0.com \
 *   AUTH0_TOKEN=<a Management API token with read:clients delete:clients> \
 *   node scripts/prune-mcp-clients.mjs                     # says what it would remove
 *   node scripts/prune-mcp-clients.mjs --delete            # removes it
 *   node scripts/prune-mcp-clients.mjs --keep-test-apps    # leave the dashboard's own alone
 *
 * AUTH0_KEEP=<client id or name>,… keeps anything you name, whatever it is.
 *
 * A token is minted in the Auth0 dashboard: Applications → APIs → Auth0
 * Management API → API Explorer.  It is short-lived, which is the point.
 */

const domain = process.env.AUTH0_DOMAIN;
const token = process.env.AUTH0_TOKEN;
const remove = process.argv.includes("--delete");
/** Anything that has not been used for this long is a candidate. */
const days = Number((process.argv.find((a) => a.startsWith("--days=")) || "--days=2").split("=")[1]);
/** Applications to leave alone whatever their age, by client id or name. */
const keep = (process.env.AUTH0_KEEP || "").split(",").map((s) => s.trim()).filter(Boolean);

if (!domain || !token) {
    console.error("Set AUTH0_DOMAIN and AUTH0_TOKEN.  The token is not read from anywhere else and is never printed.");
    process.exit(2);
}

const api = async (path, init = {}) => {
    const response = await fetch(`https://${domain}/api/v2${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`${init.method || "GET"} ${path} → ${response.status} ${body.slice(0, 200)}`);
    }
    return response.status === 204 ? null : response.json();
};

/** Every application in the tenant, a page at a time. */
async function clients() {
    const all = [];
    for (let page = 0; page < 50; page++) {
        const batch = await api(`/clients?page=${page}&per_page=100&include_totals=false&fields=client_id,name,app_type,is_first_party,client_metadata&include_fields=true`);
        if (!batch.length) { break; }
        all.push(...batch);
        if (batch.length < 100) { break; }
    }
    return all;
}

const registered = (client) =>
    /^tpc_/.test(client.client_id) || client.is_first_party === false;

/**
 * Auth0 makes one of these the first time anybody opens an API's Test tab, and
 * nothing uses it afterwards.  They are not clients of anything; they are the
 * residue of having looked at something.  On a tenant of ten applications,
 * five of them turned out to be these.
 */
const leftByTheDashboard = (client) =>
    !registered(client) && /\(Test Application\)$/.test(String(client.name || "").trim());

(async () => {
    const all = await clients();
    const theirs = all.filter(registered);
    const residue = all.filter(leftByTheDashboard);
    const mine = all.filter((c) => !registered(c) && !leftByTheDashboard(c));
    console.log(`${all.length} applications in this tenant: ${mine.length} yours, ${theirs.length} registered by clients, ${residue.length} left behind by the dashboard.`);
    if (mine.length) {
        console.log("\nYours, which are never touched:");
        mine.forEach((c) => console.log(`  ${c.name} (${c.client_id})`));
    }
    if (residue.length) {
        console.log("\nTest applications, which Auth0 made when somebody opened an API's Test tab:");
        residue.forEach((c) => console.log(`  ${c.client_id}  ${c.name}`));
        console.log("  (deleting these deletes no API; the Test tab makes another if it is ever needed)");
    }
    if (!theirs.length && !residue.length) {
        console.log("\nNothing registered itself and nothing was left behind; the limit is not this.");
        return;
    }

    const sweepable = process.argv.includes("--keep-test-apps") ? theirs : theirs.concat(residue);
    const kept = sweepable.filter((c) => keep.includes(c.client_id) || keep.includes(c.name));
    const candidates = sweepable.filter((c) => !kept.includes(c));
    console.log(`\n${candidates.length} to remove${kept.length ? `, ${kept.length} kept by name` : ""}:`);
    candidates.forEach((c) => console.log(`  ${c.client_id}  ${c.name || "(no name)"}`));

    if (!remove) {
        console.log(`\nNothing was removed.  Run again with --delete to remove these ${candidates.length}.`);
        console.log("Anything still connected re-registers the next time it signs in, which is what makes this safe.");
        return;
    }
    let gone = 0;
    for (const client of candidates) {
        try {
            await api(`/clients/${client.client_id}`, { method: "DELETE" });
            gone += 1;
            console.log(`removed ${client.client_id}`);
        } catch (err) {
            console.error(`could not remove ${client.client_id}: ${err.message}`);
        }
    }
    console.log(`\n${gone} removed; ${all.length - gone} applications left.`);
})().catch((err) => {
    console.error(String(err.message || err));
    process.exit(1);
});
