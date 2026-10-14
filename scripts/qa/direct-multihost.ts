import {join} from "node:path";

type Pairing = {endpoint: string; installationId: string; hostPublicKey: string; nonce: string; label: string};
type MultiHostOptions = {
  page: any; origin: string; pairingA: Pairing; pairingB: Pairing; markerA: string; markerB: string; directory: string;
  check(name: string, value: unknown): void;
  waitFor(ready: () => Promise<boolean>, timeout?: number): Promise<void>;
  network(host: string, blocked: boolean): void;
  active(host: string): number;
  attempts(host: string): number;
  geometry(value: unknown): void;
};

export async function qualifyDirectMultiHost({page, origin, pairingA, pairingB, markerA, markerB, directory, check, waitFor, network, active, attempts, geometry}: MultiHostOptions) {
  const input = () => page.getByRole("textbox", {name:"Message the agent",exact:true});
  const message = (marker: string) => page.getByLabel("Your message", {exact:true}).getByText(marker, {exact:true});
  const card = (pair: Pairing) => page.getByText(pair.endpoint, {exact:true}).locator("..").locator("..");
  const draftA = "MULTIHOST_A_PRIVATE_DRAFT", draftB = "MULTIHOST_B_PRIVATE_DRAFT";
  const hostA = new URL(pairingA.endpoint).hostname, hostB = new URL(pairingB.endpoint).hostname;
  const home = async () => {
    await page.getByRole("button", {name:"Computers",exact:true}).click();
    await page.getByRole("heading", {name:"Your computers",exact:true}).waitFor();
  };
  const connect = async (pair: Pairing, draft: string) => {
    await card(pair).getByRole("button", {name:"Connect",exact:true}).click();
    await input().waitFor();
    await waitFor(async () => await input().inputValue() === draft);
    await message(pair === pairingA ? markerA : markerB).waitFor();
    await page.getByText("Reconnecting to your computer…", {exact:true}).waitFor({state:"hidden"});
  };
  const pair = async (value: Pairing, marker: string, other: string) => {
    await page.goto(`${origin}/#directPair=${Buffer.from(JSON.stringify(value)).toString("base64url")}`);
    await page.getByRole("button", {name:"Pair and connect",exact:true}).click();
    await input().waitFor();
    await message(marker).waitFor();
    check(`multihost_${value === pairingA ? "a" : "b"}_initial_history_is_scoped`, await input().inputValue() === "" && await message(other).count() === 0 && new URL(page.url()).hash === "");
  };
  const remember = async (draft: string) => {
    await page.getByRole("button", {name:"Drafts off",exact:true}).click();
    await page.getByRole("button", {name:"Remember drafts on this device",exact:true}).click();
    await page.getByRole("button", {name:"Offline history",exact:true}).click();
    await page.getByRole("button", {name:"Save history on this device",exact:true}).click();
    await page.getByRole("list", {name:"Saved conversations",exact:true}).getByRole("button").first().waitFor();
    await page.getByRole("button", {name:"Close offline history",exact:true}).click();
    await input().fill(draft);
    await page.locator('[data-draft-status="saved"]').waitFor();
  };
  const history = async (value: Pairing, marker: string, other: string) => {
    await card(value).getByRole("button", {name:"Offline history",exact:true}).click();
    await page.getByRole("list", {name:"Saved conversations",exact:true}).getByRole("button").first().click();
    const dialog = page.getByRole("dialog", {name:"Offline history",exact:true});
    await dialog.locator("article").getByText(marker, {exact:true}).waitFor();
    check(`multihost_${value === pairingA ? "a" : "b"}_offline_history_excludes_other_host`, await dialog.getByText(other, {exact:true}).count() === 0);
    await page.getByRole("button", {name:"Close offline history",exact:true}).click();
  };
  const storage = () => page.evaluate(async ({endpointA, endpointB}: {endpointA: string; endpointB: string}) => {
    const rows = (database: string, store: string) => new Promise<any[]>((resolve, reject) => {
      let db: IDBDatabase | undefined, completed = false;
      const done = (error?: unknown, result?: any[]) => {if (completed) return; completed = true; clearTimeout(timer); db?.close(); if (error) reject(error); else resolve(result!);};
      const timer = setTimeout(() => done(new Error("Scoped storage inventory deadline")), 5000);
      const request = indexedDB.open(database, 1);
      request.onerror = () => done(request.error ?? new Error("Scoped storage inventory failed"));
      request.onblocked = () => done(new Error("Scoped storage inventory blocked"));
      request.onupgradeneeded = () => {request.transaction?.abort(); done(new Error("Scoped storage inventory missing"));};
      request.onsuccess = () => {
        db = request.result;
        if (completed) {db.close(); return;}
        try {
          const tx = db.transaction(store, "readonly"), all = tx.objectStore(store).getAll();
          tx.oncomplete = () => done(undefined, all.result);
          tx.onabort = tx.onerror = () => done(tx.error ?? new Error("Scoped storage inventory aborted"));
        } catch (error) {done(error);}
      };
    });
    const profiles = await rows("grok-direct-hosts-v1", "profiles"), drafts = await rows("grok-remote-drafts.v2", "drafts");
    const a = profiles.find(value => value.endpoint === endpointA), b = profiles.find(value => value.endpoint === endpointB);
    return {profiles: profiles.length, a: Boolean(a), b: Boolean(b), independent: Boolean(a && b && a.installationId !== b.installationId && a.hostPublicKey !== b.hostPublicKey && a.pair.sessionId !== b.pair.sessionId), rowsA:drafts.filter(row => row.scope.includes(endpointA)).length, rowsB:drafts.filter(row => row.scope.includes(endpointB)).length};
  }, {endpointA:pairingA.endpoint,endpointB:pairingB.endpoint});

  try {
    await pair(pairingA, markerA, markerB);
    await remember(draftA);
    for (const [name, changed] of [["key", {hostPublicKey:pairingA.hostPublicKey}], ["installation", {installationId:pairingA.installationId}]] as const) {
      await page.goto(`${origin}/#directPair=${Buffer.from(JSON.stringify({...pairingB, ...changed})).toString("base64url")}`);
      await page.getByRole("button", {name:"Pair and connect",exact:true}).click();
      await page.getByText("The computer could not be reached. Check its connection, Tailscale or HTTPS address, and that Spanreed is running. Then reconnect.", {exact:true}).waitFor();
      const rejected = await storage();
      check(`multihost_crossed_${name}_cannot_pair_or_expose_foreign_content`, rejected.profiles === 1 && rejected.a && !rejected.b && rejected.rowsA >= 2 && rejected.rowsB === 0 && await message(markerB).count() === 0 && await input().count() === 0);
    }
    await pair(pairingB, markerB, markerA);
    await remember(draftB);
    const saved = await storage();
    check("multihost_two_pairings_and_two_separate_draft_history_scopes_saved", saved.profiles === 2 && saved.independent && saved.rowsA >= 2 && saved.rowsB >= 2);
    await home();
    const originalDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    const measurements: any[] = [];
    for (const width of [390, 2560]) {
      await page.setViewportSize({width,height:width === 390 ? 844 : 1440});
      for (const dark of [false, true]) {
        await page.evaluate((value: boolean) => document.documentElement.classList.toggle("dark", value), dark);
        const cards = [];
        for (const value of [pairingA, pairingB]) cards.push(await card(value).evaluate((element: HTMLElement) => {
          const heading = element.querySelector("h2")!.getBoundingClientRect(), endpoint = element.querySelector("p")!.getBoundingClientRect();
          const actions = Array.from(element.querySelectorAll("button")).filter(button => ["Connect", "Offline history"].includes(button.textContent!.trim())).map(button => {const box = button.getBoundingClientRect(); return {label:button.textContent!.trim(),width:box.width,height:box.height,top:box.top};});
          return {headingWidth:heading.width,endpointWidth:endpoint.width,identityBottom:Math.max(heading.bottom,endpoint.bottom),actions};
        }));
        measurements.push({width,dark,cards});
        await page.screenshot({path:join(directory, `multihost-computers-${width}-${dark ? "dark" : "light"}.png`)});
      }
    }
    geometry(measurements);
    for (const {width,dark,cards} of measurements) {
      const suffix = `${width}_${dark ? "dark" : "light"}`;
      check(`multihost_computer_identity_has_useful_width_${suffix}`, cards.every((value: any) => value.headingWidth >= 200 && value.endpointWidth >= 200));
      check(`multihost_computer_actions_have_44px_targets_${suffix}`, cards.every((value: any) => value.actions.length === 2 && value.actions.every((action: any) => action.width >= 44 && action.height >= 44)));
      if (width === 390) check(`multihost_mobile_actions_follow_identity_${suffix}`, cards.every((value: any) => value.actions.every((action: any) => action.top >= value.identityBottom)));
    }
    await page.evaluate((value: boolean) => document.documentElement.classList.toggle("dark", value), originalDark);
    await page.setViewportSize({width:390,height:844});
    check("multihost_computer_list_fits_mobile_and_has_two_independent_connect_actions", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth) && await page.getByRole("button", {name:"Connect",exact:true}).count() === 2);
    await page.setViewportSize({width:2560,height:1440});
    await waitFor(async () => active(hostA) === 0 && active(hostB) === 0);
    network(hostA, true); network(hostB, true);
    const attemptsA = attempts(hostA), attemptsB = attempts(hostB);
    await history(pairingA, markerA, markerB);
    await history(pairingB, markerB, markerA);
    check("multihost_offline_history_does_not_attempt_either_host", active(hostA) === 0 && active(hostB) === 0 && attempts(hostA) === attemptsA && attempts(hostB) === attemptsB);
    network(hostA, false); network(hostB, false);
    await connect(pairingA, draftA);
    check("multihost_return_to_a_restores_only_its_draft_and_history", await message(markerA).count() === 1 && await message(markerB).count() === 0);
    const beforeFailure = attempts(hostA);
    network(hostA, true);
    await page.getByText("Reconnecting to your computer…", {exact:true}).waitFor();
    await waitFor(async () => attempts(hostA) > beforeFailure);
    check("multihost_a_recovery_reaches_unavailable_host", active(hostA) === 0);
    await home();
    await connect(pairingB, draftB);
    const attemptsAfterSwitch = attempts(hostA);
    network(hostA, false);
    await waitFor(async () => active(hostA) === 0 && active(hostB) > 0);
    await page.waitForTimeout(4500);
    check("multihost_a_pending_retry_cancelled_after_switch_to_b", attempts(hostA) === attemptsAfterSwitch && active(hostA) === 0 && active(hostB) > 0);
    check("multihost_switch_during_a_recovery_keeps_b_draft_identity_and_history", await input().inputValue() === draftB && await message(markerB).count() === 1 && await message(markerA).count() === 0 && await page.getByText("Reconnecting to your computer…", {exact:true}).count() === 0);
    await page.screenshot({path:join(directory, "multihost-b-after-a-disconnect.png")});
    await home();
    await connect(pairingA, draftA);
    await page.getByRole("button", {name:"Forget this browser",exact:true}).click();
    await page.getByRole("heading", {name:"Your computers",exact:true}).waitFor();
    const revoked = await storage();
    check("multihost_revoking_a_deletes_only_a_pairing_draft_and_history", revoked.profiles === 1 && !revoked.a && revoked.b && revoked.rowsA === 0 && revoked.rowsB >= 2);
    await history(pairingB, markerB, markerA);
    await connect(pairingB, draftB);
    check("multihost_b_remains_usable_after_a_revocation", await message(markerB).count() === 1 && await page.getByRole("button", {name:"Forget this browser",exact:true}).isEnabled());
    await page.reload();
    await connect(pairingB, draftB);
    check("multihost_surviving_b_pairing_and_draft_persist_after_reload", await message(markerB).count() === 1 && await message(markerA).count() === 0);
    await page.getByRole("button", {name:"Forget this browser",exact:true}).click();
    await page.getByRole("heading", {name:"Your computers",exact:true}).waitFor();
    const cleared = await storage();
    check("multihost_explicit_cleanup_removes_both_scopes", cleared.profiles === 0 && cleared.rowsA === 0 && cleared.rowsB === 0);
  } finally {network(hostA, false); network(hostB, false);}
}
