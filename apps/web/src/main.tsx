import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { connect, initialView, threadFromHash } from "./session.ts";
import { setState } from "./store.ts";
import { syncTitleBar } from "./titlebar.ts";
import "./styles.css";

syncTitleBar();

// a reload keeps the open thread: #thread=<id>
setState(initialView(threadFromHash()));
connect();

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
