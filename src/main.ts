import { App } from "./app";
import "./ui/style.css";

const app = new App(document.getElementById("app")!);
if (import.meta.env.DEV) (window as unknown as { __app: App }).__app = app;
