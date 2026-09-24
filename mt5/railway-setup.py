#!/usr/bin/env python3
"""One step: add Dave's MT5 service to a Railway project that already runs the Dave bot.

    RAILWAY_TOKEN=... python3 mt5/railway-setup.py            # finds the project running the bot
    RAILWAY_TOKEN=... python3 mt5/railway-setup.py --project <project id or name>

Get the token at railway.com -> Account Settings -> Tokens (an account token, not a project token).

What it does -- the same four steps as mt5/README.md, so nobody has to remember them:
  1. creates the service "dave-mt5" from this same GitHub repo and branch as the bot, built from
     mt5/Dockerfile, rebuilt only when mt5/ or ea/ change;
  2. gives it a 0.5 GB volume at /data (the login settings survive a redeploy);
  3. generates a long random MT5_AGENT_SECRET and sets it on BOTH services;
  4. lets Railway deploy both.
Safe to run again: anything already in place is left as it is (an existing secret is kept).
Standard library only -- nothing to install.
"""
import argparse
import json
import os
import secrets
import sys
import time
import urllib.request

API = "https://backboard.railway.com/graphql/v2"
MT5 = "dave-mt5"


def gql(token, query, variables=None):
    req = urllib.request.Request(
        API,
        data=json.dumps({"query": query, "variables": variables or {}}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", "User-Agent": "dave-mt5-setup"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)
    if out.get("errors"):
        raise SystemExit("Railway said: " + "; ".join(e.get("message", "?") for e in out["errors"]))
    return out["data"]


PROJECT_Q = """query($id:String!){project(id:$id){id name
  environments{edges{node{id name}}}
  services{edges{node{id name serviceInstances{edges{node{environmentId source{repo image} latestDeployment{meta}}}}}}}
  volumes{edges{node{id name volumeInstances{edges{node{serviceId mountPath}}}}}}}}"""


def load_project(token, pid):
    return gql(token, PROJECT_Q, {"id": pid})["project"]


def repo_of(service):
    for e in service["serviceInstances"]["edges"]:
        src = (e["node"].get("source") or {}).get("repo")
        if src:
            meta = (e["node"].get("latestDeployment") or {}).get("meta") or {}
            return src, meta.get("branch")
    return None, None


def find_project(token, want):
    # Projects live in workspaces; the top-level `projects` list comes back empty for them.
    workspaces = gql(token, "{me{workspaces{projects{edges{node{id name}}}}}}")["me"]["workspaces"]
    projects = [p for w in workspaces for p in w["projects"]["edges"]]
    if want:
        for p in projects:
            if want in (p["node"]["id"], p["node"]["name"]):
                return load_project(token, p["node"]["id"])
        raise SystemExit("No project called %r on this account." % want)
    # The project whose services include one built from a GitHub repo (the bot), not only dave-mt5.
    matches = []
    for p in projects:
        proj = load_project(token, p["node"]["id"])
        if any(repo_of(s["node"])[0] and s["node"]["name"] != MT5 for s in proj["services"]["edges"]):
            matches.append(proj)
    if len(matches) != 1:
        names = ", ".join(m["name"] for m in matches) or "none"
        raise SystemExit("Couldn't tell which project runs the bot (found: %s). Run again with --project <name>." % names)
    return matches[0]


def variables(token, pid, eid, sid):
    return gql(token, "query($p:String!,$e:String!,$s:String){variables(projectId:$p,environmentId:$e,serviceId:$s)}",
               {"p": pid, "e": eid, "s": sid})["variables"]


def set_var(token, pid, eid, sid, name, value):
    gql(token, "mutation($i:VariableUpsertInput!){variableUpsert(input:$i)}",
        {"i": {"projectId": pid, "environmentId": eid, "serviceId": sid, "name": name, "value": value}})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", help="Railway project id or name (default: the one running the bot)")
    ap.add_argument("--branch", help="git branch to build from (default: the bot's branch)")
    args = ap.parse_args()
    token = os.environ.get("RAILWAY_TOKEN", "").strip()
    if not token:
        raise SystemExit("Set RAILWAY_TOKEN first (railway.com -> Account Settings -> Tokens).")

    proj = find_project(token, args.project)
    pid = proj["id"]
    env = next((e["node"] for e in proj["environments"]["edges"] if e["node"]["name"] == "production"), None) or proj["environments"]["edges"][0]["node"]
    eid = env["id"]
    services = {s["node"]["name"]: s["node"] for s in proj["services"]["edges"]}
    bot = next((s for n, s in services.items() if n != MT5 and repo_of(s)[0]), None)
    if not bot:
        raise SystemExit("Project %r has no service built from GitHub -- deploy the Dave bot first." % proj["name"])
    repo, bot_branch = repo_of(bot)
    branch = args.branch or bot_branch
    print("Project: %s   bot: %s (%s%s)" % (proj["name"], bot["name"], repo, " @ " + branch if branch else ""))

    # The secret: keep one that already exists on either side, so running this again breaks nothing.
    bot_vars = variables(token, pid, eid, bot["id"])
    mt5 = services.get(MT5)
    mt5_vars = variables(token, pid, eid, mt5["id"]) if mt5 else {}
    secret = mt5_vars.get("MT5_AGENT_SECRET") or bot_vars.get("MT5_AGENT_SECRET") or secrets.token_urlsafe(32)

    created = False
    if mt5:
        print("1. %s already exists -- keeping it." % MT5)
    else:
        inp = {"projectId": pid, "environmentId": eid, "name": MT5, "source": {"repo": repo},
               "variables": {"RAILWAY_DOCKERFILE_PATH": "mt5/Dockerfile", "MT5_AGENT_SECRET": secret}}
        if branch:
            inp["branch"] = branch
        mt5 = gql(token, "mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id name}}", {"i": inp})["serviceCreate"]
        created = True
        print("1. created %s from %s" % (MT5, repo))
    if mt5_vars.get("RAILWAY_DOCKERFILE_PATH") != "mt5/Dockerfile" or mt5_vars.get("MT5_AGENT_SECRET") != secret:
        set_var(token, pid, eid, mt5["id"], "RAILWAY_DOCKERFILE_PATH", "mt5/Dockerfile")
        set_var(token, pid, eid, mt5["id"], "MT5_AGENT_SECRET", secret)
    gql(token, "mutation($s:String!,$e:String!,$i:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$s,environmentId:$e,input:$i)}",
        {"s": mt5["id"], "e": eid, "i": {"watchPatterns": ["mt5/**", "ea/**"], "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10}})

    # Railway lists a new volume's attachment a little after creating it, so also go by its name,
    # and treat "a service can only have one volume" as already done rather than as a failure.
    has_volume = any(
        v["node"].get("name", "").startswith(MT5 + "-volume")
        or any(vi["node"]["serviceId"] == mt5["id"] for vi in v["node"]["volumeInstances"]["edges"])
        for v in proj["volumes"]["edges"]
    )
    if has_volume:
        print("2. volume already attached -- keeping it.")
    else:
        try:
            gql(token, "mutation($i:VolumeCreateInput!){volumeCreate(input:$i){id}}",
                {"i": {"projectId": pid, "environmentId": eid, "serviceId": mt5["id"], "mountPath": "/data"}})
            print("2. added a volume at /data")
        except SystemExit as e:
            if "only have one volume" not in str(e):
                raise
            print("2. volume already attached -- keeping it.")

    if bot_vars.get("MT5_AGENT_SECRET") == secret:
        print("3. the bot already has the matching secret.")
    else:
        set_var(token, pid, eid, bot["id"], "MT5_AGENT_SECRET", secret)  # this redeploys the bot
        print("3. set MT5_AGENT_SECRET on both services (the bot restarts to pick it up)")

    if created:
        print("4. Railway is building %s now -- the first build takes about 5 minutes." % MT5)
        print("\nDone. When it's up, send /mt5 to the bot and choose Connect account.")
    else:
        print("\nEverything was already in place. Send /mt5 to the bot to use it.")


if __name__ == "__main__":
    main()
