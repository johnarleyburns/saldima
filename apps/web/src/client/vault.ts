// SPDX-License-Identifier: AGPL-3.0-only

/**
 * First client-side JS entry point in this repo (see
 * `docs/architecture/TECHNICAL-DESIGN.md` §8 and issue #88). This bundle
 * is plumbing only: it proves the build, static serving and page wiring
 * work end to end in a real browser. The vault setup/encrypt/decrypt flow
 * itself lands in a follow-up PR, built on this same bundle.
 */
function markBundleLoaded(): void {
  const marker = document.querySelector<HTMLElement>("[data-vault-bundle-status]");
  if (marker) marker.textContent = "loaded";
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", markBundleLoaded);
} else {
  markBundleLoaded();
}
