import { createApp } from "./app.js";

// Entrypoint: build the app (see app.ts for the route map) and listen.

const app = createApp();

// Last-resort guard: an async handler that throws without passing the error to
// next() would otherwise take the whole API down (Express 4 doesn't catch
// those). Log and keep serving — one bad request must not deny service to the
// league.
process.on("unhandledRejection", (err) => {
  console.error("unhandled rejection:", err);
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  console.log(`tags-app API listening on :${port}`);
});
