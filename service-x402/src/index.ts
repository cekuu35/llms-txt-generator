import app from "./app.js";

export default app;

if (!process.env.VERCEL && process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, "127.0.0.1", () => {
    console.log("site-context-forge listening on http://127.0.0.1:" + port);
  });
}
