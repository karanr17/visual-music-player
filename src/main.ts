import { App } from "./app";
import "./ui/style.css";

const root = document.getElementById("app")!;
if (new URLSearchParams(location.search).has("capture")) {
  void import("./capture").then((m) => m.startCapture(root));
} else {
  const app = new App(root);
  if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
}
