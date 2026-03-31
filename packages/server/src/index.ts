import { app } from "./app";

const port = parseInt(process.env.PORT || "3100", 10);

console.log(`Hezo server starting on port ${port}...`);

export default {
  port,
  fetch: app.fetch,
};
