import {createRequire} from "node:module";
import {writeFile} from "node:fs/promises";
const url=process.env.REMOTE_FIXTURE_URL;
const output=process.env.REMOTE_QA_OUTPUT;
if(!url||!output||!["127.0.0.1","localhost"].includes(new URL(url).hostname))throw new Error("Set a disposable loopback REMOTE_FIXTURE_URL and REMOTE_QA_OUTPUT");
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE??"playwright-core");
const browser=await chromium.connectOverCDP(process.env.BROWSER_CDP??"http://127.0.0.1:9222");
const context=await browser.newContext({viewport:{width:390,height:844}});const page=await context.newPage();
const report={syntheticBrowserAndAccount:true,checks:[],errors:[]};
page.on("pageerror",error=>report.errors.push(String(error)));
const check=(name,value)=>{if(!value)throw new Error(name);report.checks.push(name);};
try{
  await page.goto(url);const enable=page.getByRole("button",{name:"Enable notifications for this computer"});await enable.waitFor();await page.waitForFunction(()=>!Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Enable notifications for this computer").disabled);
  check("no automatic permission or subscription",await page.evaluate(()=>pushQa.counts.permissions===0&&pushQa.counts.subscriptions===0));
  await page.evaluate(()=>pushQa.setPermissionResult("denied"));await enable.click();await page.getByText(/Notifications were not enabled/).waitFor();
  check("denied permission leaves registration absent",await page.evaluate(()=>pushQa.counts.subscriptions===0&&!pushQa.accountCalls.some(call=>call.method==="POST")));
  await page.reload();await enable.waitFor();await enable.click();await page.getByText("Configured for this computer.",{exact:true}).waitFor();
  check("explicit setup binds exactly once",await page.evaluate(()=>pushQa.counts.permissions===1&&pushQa.counts.subscriptions===1&&pushQa.commands.filter(command=>command.kind==="configureNotifications").length===1));
  await page.getByRole("button",{name:"Disable notifications for this computer"}).click();await page.getByText("Notifications were disabled for this browser and computer.",{exact:true}).waitFor();
  check("scoped disable keeps shared browser subscription",await page.evaluate(()=>pushQa.counts.unsubscriptions===0&&pushQa.accountCalls.filter(call=>call.method==="DELETE").length===1));
  await page.evaluate(()=>pushQa.bindingFailure(true));await enable.click();await page.getByText(/did not confirm its binding/).waitFor();
  check("uncertain binding neither retries nor deletes",await page.evaluate(()=>pushQa.commands.filter(command=>command.kind==="configureNotifications").length===2&&pushQa.accountCalls.filter(call=>call.method==="DELETE").length===1&&pushQa.counts.unsubscriptions===0));
  check("mobile layout fits",await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`${output}/push-mobile.png`});
  check("no browser errors",report.errors.length===0);report.result="passed";
}catch(error){report.result="failed";report.failure=String(error);process.exitCode=1;}
finally{await context.close();await browser.close();await writeFile(`${output}/push-ui.json`,JSON.stringify(report,null,2));}
