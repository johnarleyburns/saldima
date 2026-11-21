// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Minimal worker entry for the workerd test pool. Real routes arrive in P0-6.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("saldima test worker", { status: 200 });
  },
};
