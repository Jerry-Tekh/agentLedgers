/**
 * Headless DOM smoke test for the built app. Not a substitute for a real
 * browser + wallet extension + live chain -- jsdom doesn't run CSS layout or
 * a real MetaMask extension -- but it does execute the actual React tree,
 * real event dispatch, and the actual wallet.ts/env.ts modules, so it
 * catches mount-time crashes, broken navigation, and unhandled promise
 * rejections that static typechecking cannot.
 *
 * This test runs without VITE_AGENTLEDGER_CONTRACT_ADDRESS / _CHAIN set (tsx
 * doesn't populate import.meta.env the way Vite's build does), which is
 * exactly the "forgot to configure the deployment" scenario -- it verifies
 * the app degrades to a clear configuration-error screen instead of a blank
 * page or a crash. The complementary check -- that Vite actually inlines
 * real env values into the production bundle -- is a separate build-time
 * verification (see README's Verification section), since that requires the
 * real Vite build pipeline, not this Node-only harness.
 *
 * Run with: npm run smoke-test
 */
import { JSDOM } from "jsdom";

const errors = [];
const originalConsoleError = console.error;

async function main() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
  });

  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);

  console.error = (...args) => {
    errors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: App } = await import("../src/App.tsx");

  const container = document.getElementById("root");
  const root = createRoot(container);

  let step = "initial landing mount";
  root.render(React.createElement(App));
  await tick();

  assert(document.querySelector(".hero-headline"), step, "hero headline should render on landing");
  assert(document.querySelector(".brand-name")?.textContent === "AgentLedger", step, "brand name should render in navbar");
  assert(!document.querySelector(".hero img"), step, "hero must not contain an image element");
  assertNoPlaceholder(container.innerHTML, step);

  step = "CTA navigates to app view";
  const ctaButtons = [...document.querySelectorAll("button")].filter((b) => b.textContent === "Launch app");
  assert(ctaButtons.length >= 1, step, "expected at least one 'Launch app' CTA button");
  ctaButtons[0].dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  await tick();

  assert(window.location.hash === "#/app", step, `expected hash to be #/app, got ${window.location.hash}`);

  step = "missing env config shows a clear config-error screen, not a crash or a form";
  assert(
    document.body.textContent.includes("This deployment isn't configured yet"),
    step,
    "should show the configuration-error screen when VITE_AGENTLEDGER_CONTRACT_ADDRESS/_CHAIN aren't set",
  );
  assert(
    document.body.textContent.includes("VITE_AGENTLEDGER_CONTRACT_ADDRESS"),
    step,
    "config-error screen should name the required env var",
  );
  assert(!document.getElementById("contract-address"), step, "there must be no manual contract-address input anywhere in the app");
  assert(!document.getElementById("chain-select"), step, "there must be no manual network-select input anywhere in the app");
  assert(
    !document.body.textContent.includes("Dev mode"),
    step,
    "there must be no dev-mode/private-key path exposed in the UI",
  );

  const unhandled = errors.filter((e) => !e.includes("Warning:"));
  if (unhandled.length) {
    console.log("\n--- console.error output during test run ---");
    unhandled.forEach((e) => console.log(e));
    throw new Error(`${unhandled.length} unexpected console.error call(s) during mount/interaction -- see above`);
  }

  console.log(
    "\nAll smoke-test assertions passed: landing renders with no image in the hero and no placeholder copy, " +
      "the CTA navigates to /#/app, and a missing env-var configuration degrades to a clear error screen " +
      "with no manual address/network/dev-key inputs anywhere in the UI.",
  );
}

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(cond, step, msg) {
  if (!cond) {
    throw new Error(`[${step}] ${msg}`);
  }
}

function assertNoPlaceholder(html, step) {
  const bannedPhrases = ["lorem ipsum", "placeholder text", "TODO", "coming soon", "your text here"];
  for (const phrase of bannedPhrases) {
    if (html.toLowerCase().includes(phrase.toLowerCase())) {
      throw new Error(`[${step}] found banned placeholder phrase: "${phrase}"`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nSMOKE TEST FAILED:", err.message);
    process.exit(1);
  })
  .finally(() => {
    console.error = originalConsoleError;
  });
