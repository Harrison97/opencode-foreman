const doc = globalThis.document;
const frames = [
  { node: "plan", message: "Make a plan before writing code." },
  { node: "build", message: "Build one manageable piece at a time." },
  { node: "review", message: "Run checks against the requested behavior." },
  {
    node: "build",
    repair: true,
    message: "Found an issue? Send it back for a fix.",
  },
  { node: "review", message: "Review the fix before moving on." },
  { node: "deliver", message: "Verify the result, then hand it over." },
];
const motion = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
const diagram = doc.querySelector(".flow-demo");
const toggle = doc.getElementById("toggle-animation");
let paused = motion.matches;
let frame = 0;
let timer;
function renderFrame() {
  const current = frames[frame];
  for (const node of doc.querySelectorAll("[data-node]")) {
    node.classList.toggle("is-active", node.dataset.node === current.node);
  }
  for (const edge of doc.querySelectorAll("[data-edge]")) {
    edge.classList.toggle(
      "is-active",
      !current.repair && edge.dataset.edge === current.node,
    );
  }
  diagram.classList.toggle("is-repairing", Boolean(current.repair));
  doc.getElementById("flow-message").textContent = current.message;
}
function schedule() {
  globalThis.clearInterval(timer);
  toggle.textContent = paused ? "Play animation" : "Pause animation";
  toggle.setAttribute("aria-pressed", String(paused));
  diagram.classList.toggle("is-paused", paused);
  if (!paused && !doc.hidden) {
    timer = globalThis.setInterval(() => {
      frame = (frame + 1) % frames.length;
      renderFrame();
    }, 1800);
  }
}
toggle.addEventListener("click", () => {
  paused = !paused;
  schedule();
});
motion.addEventListener("change", () => {
  paused = motion.matches;
  schedule();
});
doc.addEventListener("visibilitychange", schedule);
renderFrame();
schedule();
doc.getElementById("copy-install").addEventListener("click", async () => {
  const status = doc.getElementById("copy-status");
  try {
    await globalThis.navigator.clipboard.writeText(
      doc
        .getElementById("install-command")
        .textContent.replace(/\s+/g, " ")
        .trim(),
    );
    status.textContent = "Install command copied.";
  } catch {
    status.textContent = "Select and copy the install command above.";
    const range = doc.createRange();
    range.selectNodeContents(doc.getElementById("install-command"));
    const selection = globalThis.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

const installDialog = doc.getElementById("install-dialog");
doc
  .getElementById("open-install")
  .addEventListener("click", () => installDialog.showModal());
doc
  .getElementById("close-install")
  .addEventListener("click", () => installDialog.close());
