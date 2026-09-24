const doc = globalThis.document;
const steps = {
  plan: [
    "01 / PLAN",
    "Turn the brief into bounded work.",
    "Establish the design and contracts, then select a manageable assignment with explicit acceptance criteria.",
    "BRIEF → DESIGN → PLAN",
  ],
  build: [
    "02 / BUILD",
    "One clear assignment at a time.",
    "Implement a bounded piece of work. Declare the checks and acceptance criteria that the review stage will verify.",
    "PLAN → BUILD → REVIEW",
  ],
  review: [
    "03 / REVIEW",
    "“Done” gets a second look.",
    "Run fresh checks against the agreed behavior. If the evidence falls short, route back to build, design, or investigation.",
    "BUILD → REVIEW → REPAIR ↴",
  ],
  deliver: [
    "04 / DELIVER",
    "Verify the whole, then hand it over.",
    "Once the required work is verified, check the complete product against the original goals before delivering the result.",
    "RELEASE → VERIFY → DELIVER",
  ],
};
for (const button of doc.querySelectorAll("[data-step]")) {
  button.addEventListener("click", () => {
    for (const option of doc.querySelectorAll("[data-step]"))
      option.setAttribute("aria-pressed", String(option === button));
    const values = steps[button.dataset.step];
    ["step-label", "step-title", "step-description", "step-route"].forEach(
      (id, index) => {
        doc.getElementById(id).textContent = values[index];
      },
    );
  });
}
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
