// SPDX-License-Identifier: AGPL-3.0-only
import { createApp } from "./app.ts";
import { Book } from "./book.ts";

export { Book };

export default {
  fetch: createApp().fetch,
};
